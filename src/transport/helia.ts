import type { CID } from "multiformats/cid";
import type { PeerId } from "@libp2p/interface";
import type { BlockstoreLike, FetchServiceLike, HeliaInstance, PubsubService } from "./types.js";
import { MissingBlockstoreError, MissingFetchError, MissingPubsubError } from "../errors.js";

/**
 * The helia/libp2p-touching glue. Like the rest of `transport/`, this is the only place
 * that reaches into the host node; the core never imports it.
 *
 * `requireHeliaServices` is the one piece live today: the host injects its running Helia
 * node directly (no adapter), and we cannot trust the type — `libp2p.services.pubsub` is
 * `unknown`, a plain Helia node has none, and a malformed object may lack a blockstore —
 * so we validate both at construction and fail fast (`MissingPubsubError` /
 * `MissingBlockstoreError`) instead of letting a later publish/subscribe/fetch throw
 * obscurely.
 *
 * Note "bitswap" is not separately checkable: it is a block broker wired *beneath*
 * `blockstore`, not a property of the Helia node, so validating the blockstore (the
 * surface bitswap retrieves through) is the closest honest guarantee.
 */

/** Does `value` look like a pubsub service we can drive (the methods we depend on)? */
function isPubsubService(value: unknown): value is PubsubService {
    if (value === null || typeof value !== "object") return false;
    const candidate = value as Record<string, unknown>;
    return (
        typeof candidate.publish === "function" &&
        typeof candidate.subscribe === "function" &&
        typeof candidate.unsubscribe === "function"
    );
}

/**
 * The host's raw blockstore surface. `get` may return EITHER a `Promise<Uint8Array>` (a plain
 * `interface-blockstore`) OR an async generator yielding the block's bytes — Helia's real
 * `BlockStorage` implements the streaming `Blocks` interface and yields the block (one chunk in
 * practice), not a bare promise. The library works against the simpler {@link BlockstoreLike}
 * contract, so {@link adaptBlockstore} normalises either shape at this one boundary.
 */
interface RawBlockstore {
    get(cid: CID, options?: { signal?: AbortSignal }): AsyncIterable<Uint8Array> | Promise<Uint8Array>;
    put(cid: CID, block: Uint8Array, options?: { signal?: AbortSignal }): Promise<CID>;
    has(cid: CID, options?: { signal?: AbortSignal }): Promise<boolean>;
    /** Helia's `Blocks.createSession` (a provider-scoped session blockstore); plain blockstores lack it. */
    createSession?(root: CID, options?: { providers?: PeerId[]; maxProviders?: number }): RawBlockSession;
}

/** The raw session surface (Helia's `SessionBlockstore`); `get` streams like the parent store's. */
interface RawBlockSession {
    get(cid: CID, options?: { signal?: AbortSignal }): AsyncIterable<Uint8Array> | Promise<Uint8Array>;
    addPeer(peer: PeerId): Promise<void> | void;
    close(): void;
}

/** Does `value` look like a blockstore we can fetch/store blocks through? */
function isRawBlockstore(value: unknown): value is RawBlockstore {
    if (value === null || typeof value !== "object") return false;
    const candidate = value as Record<string, unknown>;
    return (
        typeof candidate.get === "function" &&
        typeof candidate.put === "function" &&
        typeof candidate.has === "function"
    );
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
    return value !== null && typeof value === "object" && Symbol.asyncIterator in value;
}

/**
 * Adapt a raw blockstore to the library's {@link BlockstoreLike} contract: normalise `get` to a
 * single `Uint8Array`. Helia's `BlockStorage.get` yields the block over an async generator (a
 * single chunk for the sub-1 MiB blocks this library stores; chunks are concatenated defensively),
 * while a plain blockstore returns a promise — both are handled. `put`/`has` already return
 * promises, so they pass through. Exported so the transport (and the integration harness) adapt the
 * injected node the same way.
 */
export function adaptBlockstore(raw: RawBlockstore): BlockstoreLike {
    const adapted: BlockstoreLike = {
        get: (cid, options) => readBlock(raw.get(cid, options), cid),
        put: (cid, block) => raw.put(cid, block),
        has: (cid) => raw.has(cid)
    };
    // Feature-detected, not assumed: only Helia's `Blocks` makes sessions; the unit tests' plain
    // blockstores don't, and their absence here is what tells the chase to broadcast instead.
    // Dispatched dynamically (like `get`/`put`/`has` above) so a wrapper installed on the raw
    // store after adaptation — e.g. the benchmark's timing instrumentation — is still honoured.
    if (typeof raw.createSession === "function") {
        adapted.createSession = (root, options) => {
            const session = raw.createSession!(root, options);
            return {
                get: (cid, opts) => readBlock(session.get(cid, opts), cid),
                addPeer: (peer) => session.addPeer(peer),
                close: () => session.close()
            };
        };
    }
    return adapted;
}

/** Normalise one raw `get` result (promise or stream — see {@link RawBlockstore}) to the block's bytes. */
async function readBlock(result: AsyncIterable<Uint8Array> | Promise<Uint8Array>, cid: CID): Promise<Uint8Array> {
    if (!isAsyncIterable(result)) return result; // a plain Promise<Uint8Array> blockstore
    const chunks: Uint8Array[] = [];
    for await (const chunk of result) chunks.push(chunk);
    if (chunks.length === 1) return chunks[0]!;
    if (chunks.length === 0) throw new Error(`block ${cid.toString()} yielded no bytes`);
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

/** Does `value` look like a libp2p fetch service (the request + responder registration)? */
function isFetchService(value: unknown): value is FetchServiceLike {
    if (value === null || typeof value !== "object") return false;
    const candidate = value as Record<string, unknown>;
    return (
        typeof candidate.fetch === "function" &&
        typeof candidate.registerLookupFunction === "function" &&
        typeof candidate.unregisterLookupFunction === "function"
    );
}

/**
 * Resolve and validate the gossipsub service, blockstore, and fetch service on an injected
 * Helia node, throwing {@link MissingPubsubError} / {@link MissingBlockstoreError} /
 * {@link MissingFetchError} if any is absent or malformed. Returns the narrowed handles so
 * callers do not re-check.
 */
export function requireHeliaServices(helia: HeliaInstance): {
    pubsub: PubsubService;
    blockstore: BlockstoreLike;
    fetch: FetchServiceLike;
} {
    const pubsub: unknown = helia.libp2p?.services?.pubsub;
    if (!isPubsubService(pubsub)) throw new MissingPubsubError();
    const blockstore: unknown = helia.blockstore;
    if (!isRawBlockstore(blockstore)) throw new MissingBlockstoreError();
    const fetch: unknown = (helia.libp2p?.services as Record<string, unknown> | undefined)?.fetch;
    if (!isFetchService(fetch)) throw new MissingFetchError();
    return { pubsub, blockstore: adaptBlockstore(blockstore), fetch };
}
