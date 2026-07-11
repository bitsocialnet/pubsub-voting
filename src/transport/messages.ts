import { CID } from "multiformats/cid";
import { base64url } from "multiformats/bases/base64";
import * as dagCbor from "@ipld/dag-cbor";
import { z } from "zod";
import { encodeCanonical } from "../encoding/canonical.js";
import { TOPIC_PREFIX } from "../topic.js";
import type { Criteria } from "../schema/criteria.js";

/**
 * The pubsub message payload: a two-kind discriminated union (see DESIGN.md "Transport").
 *
 *   - `bundle`: one wallet's own bundle as a **live delta** — the exact binary bundle-block
 *     bytes (crdt/codec.ts) inlined, so the receiver validates straight from the message,
 *     hashing the embedded bytes yields the bundle CID (the verdict-cache key), and the
 *     blockstore put is byte-identical. No fetch toward the publisher exists on this path.
 *   - `root`: the constant-size **root record** `{ version, root, count, sizeBytes }` — the
 *     checkpoint heartbeat (see DESIGN.md "Checkpoints"). An unverifiable *hint*, never
 *     trusted; the same record also travels over the libp2p fetch protocol, so its codec is
 *     standalone (`encodeRootRecord`/`decodeRootRecord`).
 *
 * A message carries **no authority** either way: all trust comes from re-verifying the
 * self-authenticating bundle (or the self-verifying blocks behind a root) before acting.
 * Encoding is the same canonical dag-cbor as the rest of the protocol; the layout is pinned
 * by fixed test vectors in `messages.test.ts` — any change is a breaking wire change.
 */

/** Envelope wire version (the root record carries its own `version` for the fetch path). */
export const MESSAGE_VERSION = 1;
export const ROOT_RECORD_VERSION = 1;

/** See `z.custom` note in crdt/codec.ts — `z.instanceof(Uint8Array)` over-narrows the buffer type. */
const BytesSchema = z.custom<Uint8Array>((value) => value instanceof Uint8Array, "expected bytes");
const CidSchema = z.custom<CID>((value) => CID.asCID(value) !== null, "expected a CID link");

/** A topic's compacted-state advertisement: tiny, constant-size, unauthenticated (a hint). */
export interface RootRecord {
    version: number;
    /** The checkpoint root CID of the advertiser's current winner-set. */
    root: CID;
    /** Advisory: winners inlined behind the root. Unverifiable until the blocks arrive. */
    count: number;
    /** Advisory: total checkpoint block bytes behind the root. Unverifiable until they arrive. */
    sizeBytes: number;
}

/**
 * The **fetch-protocol** root response: the advertisement plus the checkpoint's chunk-CID index
 * (the root manifest's contents). Carrying it lets a cold joiner skip the root-manifest bitswap
 * round-trip — it re-derives `CID(dag-cbor({ chunks }))`, checks it equals `root` (self-verifying,
 * so the index is never a new trust vector), and pulls every chunk in parallel (see DESIGN.md
 * "Checkpoints", "Block pull"). Only the *direct fetch response* carries the index; the pubsub
 * heartbeat stays the bare {@link RootRecord} so its message cap remains a tiny fixed constant
 * (the anti-amplification property — the index is O(sizeBytes / chunk-ceiling), a ~36 B/MiB
 * pointer list, not the payload, but the broadcast path keeps the stricter guarantee anyway).
 */
export interface FetchRootRecord extends RootRecord {
    /** The checkpoint's chunk CIDs, in root order. `CID(dag-cbor({ chunks })) === root`. */
    chunks: CID[];
}

const RootRecordSchema = z.strictObject({
    version: z.number().int().positive(),
    // Points to a `CheckpointRoot` block (`{ chunks: CID[] }`, checkpoint/codec.ts).
    root: CidSchema,
    count: z.number().int().nonnegative(),
    sizeBytes: z.number().int().nonnegative()
});

const FetchRootRecordSchema = z.strictObject({
    version: z.number().int().positive(),
    root: CidSchema,
    chunks: z.array(CidSchema),
    count: z.number().int().nonnegative(),
    sizeBytes: z.number().int().nonnegative()
});

const MessageSchema = z.discriminatedUnion("kind", [
    z.strictObject({ v: z.literal(MESSAGE_VERSION), kind: z.literal("bundle"), bundle: BytesSchema }),
    z.strictObject({ v: z.literal(MESSAGE_VERSION), kind: z.literal("root"), record: RootRecordSchema })
]);

export type VoteMessage = { kind: "bundle"; bundle: Uint8Array } | { kind: "root"; record: RootRecord };

/** Project any root record (possibly a {@link FetchRootRecord}) to the bare advertisement fields. */
function toRootRecord(record: RootRecord): RootRecord {
    return { version: record.version, root: record.root, count: record.count, sizeBytes: record.sizeBytes };
}

/** Encode one bundle's binary block bytes as a live-delta message. */
export function encodeBundleMessage(blockBytes: Uint8Array): Uint8Array {
    return encodeCanonical({ v: MESSAGE_VERSION, kind: "bundle", bundle: blockBytes });
}

/**
 * Encode a root record as a heartbeat message. The broadcast heartbeat carries only the bare
 * advertisement (never the fetch response's chunk index), so its size stays a tiny fixed
 * constant — accepts a {@link FetchRootRecord} and drops the index (see {@link FetchRootRecord}).
 */
export function encodeRootMessage(record: RootRecord): Uint8Array {
    return encodeCanonical({ v: MESSAGE_VERSION, kind: "root", record: RootRecordSchema.parse(toRootRecord(record)) });
}

/**
 * Decode a pubsub payload to its message kind, throwing on anything malformed. The gate
 * treats a throw as layer-1 badness (`reject`) — the cheapest, pre-verify check.
 */
export function decodeVoteMessage(data: Uint8Array): VoteMessage {
    const parsed = MessageSchema.parse(dagCbor.decode(data));
    return parsed.kind === "bundle" ? { kind: "bundle", bundle: parsed.bundle } : { kind: "root", record: parsed.record };
}

/**
 * The libp2p fetch-protocol key suffix for a topic's root record: the full key is
 * `topic + "/root"` (the topic prefix only namespaces *which* contest a multi-contest
 * responder is asked about — it is not a pubsub topic). See DESIGN.md "Checkpoints".
 */
export const ROOT_FETCH_KEY_SUFFIX = "/root";

/** The fetch-protocol key for one contest's root record. */
export function rootFetchKey(topic: string): string {
    return `${topic}${ROOT_FETCH_KEY_SUFFIX}`;
}

/**
 * Standalone root-record codec — the record served over the libp2p fetch protocol, carrying the
 * chunk-CID index so a cold joiner can skip the root-manifest round-trip (see {@link FetchRootRecord}).
 */
export function encodeRootRecord(record: FetchRootRecord): Uint8Array {
    return encodeCanonical(FetchRootRecordSchema.parse(record));
}

/** Decode a fetch-protocol root-record value (with its chunk index); throws on malformed. */
export function decodeRootRecord(bytes: Uint8Array): FetchRootRecord {
    return FetchRootRecordSchema.parse(dagCbor.decode(bytes));
}

/**
 * Batched root pull (see DESIGN.md "Checkpoints"): one fetch stream carries many contests' root
 * records, so a directory-scale cold join pays the per-stream multistream-select negotiation
 * once per peer instead of once per contest. The key needs no prior agreement between requester
 * and responder — it carries its own manifest (the requested criteria CIDs, dag-cbor'd and
 * base64url'd into the key itself), and the responder answers entry-by-entry from whatever it
 * participates in: a topic it does not serve answers `null`, aligned to the request order. A
 * responder that predates the batch key sees an unknown key shape and answers nothing
 * (NOT_FOUND), which the requester treats as "fall back to per-topic keys".
 */
export const BATCH_ROOTS_VERSION = 1;
/**
 * Requested-topics ceiling per batch key: bounds the responder's per-request work (decode + K
 * cache lookups) and the key/response size. A requester wanting more chunks its batches.
 */
export const MAX_BATCH_ROOT_KEYS = 64;
/**
 * The batch key marker under {@link TOPIC_PREFIX}. It cannot collide with a per-topic key:
 * topics are `TOPIC_PREFIX + <CIDv1 base32>` (always starting `b`), never the literal `roots`,
 * and base64url carries no `/`, so a batch key also never ends in the `/root` suffix a
 * per-topic responder matches on.
 */
const BATCH_ROOTS_KEY_PREFIX = `${TOPIC_PREFIX}roots/`;

/** The requested criteria CIDs as carried inside a batch key (dag-cbor CID links). */
const BatchRootsKeySchema = z.array(CidSchema).min(1).max(MAX_BATCH_ROOT_KEYS);

/** The batch response: one entry per requested topic, in request order; `null` = "no record". */
const BatchRootsResponseSchema = z.strictObject({
    v: z.literal(BATCH_ROOTS_VERSION),
    records: z.array(z.union([FetchRootRecordSchema, z.null()])).max(MAX_BATCH_ROOT_KEYS)
});

/**
 * Build the fetch-protocol key requesting many topics' root records in one stream. Throws on an
 * empty list, more than {@link MAX_BATCH_ROOT_KEYS} topics, or a string that is not a contest
 * topic — all requester-side programming errors, never wire conditions.
 */
export function batchRootsFetchKey(topics: readonly string[]): string {
    if (topics.length === 0 || topics.length > MAX_BATCH_ROOT_KEYS) {
        throw new Error(`batch key must carry 1..${MAX_BATCH_ROOT_KEYS} topics, got ${topics.length}`);
    }
    const cids = topics.map((topic) => {
        if (!topic.startsWith(TOPIC_PREFIX)) throw new Error(`not a contest topic: ${topic}`);
        return CID.parse(topic.slice(TOPIC_PREFIX.length));
    });
    return BATCH_ROOTS_KEY_PREFIX + base64url.baseEncode(dagCbor.encode(cids));
}

/**
 * Parse a fetch key as a batch-roots request, returning the requested topics in request order,
 * or `undefined` for anything else — a non-batch key shape, undecodable payload, or an over-cap
 * list (the responder answers nothing, which the requester reads as "use per-topic keys").
 */
export function decodeBatchRootsKey(key: string): string[] | undefined {
    if (!key.startsWith(BATCH_ROOTS_KEY_PREFIX)) return undefined;
    try {
        const bytes = base64url.baseDecode(key.slice(BATCH_ROOTS_KEY_PREFIX.length));
        return BatchRootsKeySchema.parse(dagCbor.decode(bytes)).map((cid) => TOPIC_PREFIX + cid.toString());
    } catch {
        return undefined;
    }
}

/** Encode the batch response — entry `i` answers requested topic `i`; `null` = "no record". */
export function encodeBatchRootsResponse(records: ReadonlyArray<FetchRootRecord | null>): Uint8Array {
    return encodeCanonical(BatchRootsResponseSchema.parse({ v: BATCH_ROOTS_VERSION, records }));
}

/** Decode a batch response; throws on malformed (the requester falls back to per-topic keys). */
export function decodeBatchRootsResponse(bytes: Uint8Array): (FetchRootRecord | null)[] {
    return BatchRootsResponseSchema.parse(dagCbor.decode(bytes)).records;
}

/**
 * The fixed byte cap for a root-kind message. The record is ~100 B by construction (version +
 * CID link + two small ints + envelope), so this is a generous constant — anything larger is
 * provably not a well-formed root message.
 */
export const MAX_ROOT_MESSAGE_BYTES = 256;

/** Envelope + fixed bundle fields (address, blockNumber, signature, structure), generously. */
const BUNDLE_MESSAGE_OVERHEAD_BYTES = 256;
/**
 * One vote entry's ceiling: a 253-byte name (the schema's DNS bound), a raw-multihash
 * publicKey (≲64 B for any realistic key hash), a small int vote, and map structure —
 * rounded up generously. Generosity is safe: the cap exists to bound *adversarial* payloads,
 * and what matters is that every peer derives the identical number from the criteria.
 */
const MAX_VOTE_ENTRY_BYTES = 512;

/**
 * The derived per-message cap for a bundle-kind message — a pure function of the criteria
 * (see DESIGN.md "Message size cap"): the criteria's own `maxVotesPerAddress` bounds the
 * entry count, the schema's fixed field bounds (253-byte name, binary crypto fields) bound
 * the entry size, so every peer computes the same cap from the same criteria bytes and an
 * over-cap `reject` stays deterministic, penalizable, and cacheable. Deliberately NOT a
 * criteria field: a raw byte knob could contradict `maxVotesPerAddress` and reject valid
 * bundles.
 */
export function maxBundleMessageBytes(criteria: Pick<Criteria, "maxVotesPerAddress">): number {
    return BUNDLE_MESSAGE_OVERHEAD_BYTES + MAX_VOTE_ENTRY_BYTES * criteria.maxVotesPerAddress;
}
