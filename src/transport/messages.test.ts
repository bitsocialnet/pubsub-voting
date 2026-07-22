import { describe, it, expect } from "vitest";
import { CID } from "multiformats/cid";
import {
    decodeVoteMessage,
    encodeBundleMessage,
    encodeRootMessage,
    encodeRootRecord,
    decodeRootRecord,
    encodeBulkRootRecords,
    decodeBulkRootRecords,
    maxBundleMessageBytes,
    rootFetchKey,
    BULK_ROOTS_FETCH_KEY,
    MAX_ROOT_MESSAGE_BYTES,
    ROOT_FETCH_KEY_SUFFIX,
    ROOT_RECORD_VERSION,
    type RootRecord,
    type FetchRootRecord
} from "./messages.js";
import { encodeBundle, bundleCidForBytes } from "../crdt/codec.js";
import type { VotesBundle } from "../schema/votes.js";

const KEY_A = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";

const BUNDLE: VotesBundle = {
    address: "0x1111111111111111111111111111111111111111",
    votes: [{ community: { name: "memes.bso", publicKey: KEY_A }, vote: 1 }],
    blockNumber: 43200,
    signature: { signature: `0x${"11".repeat(65)}`, type: "eip712" }
};

// A fixed root CID (the bundle-codec vector's CID) so the record vector is deterministic.
const ROOT = CID.parse("bafyreifn55wc5oqdjhb2pmaevd45kgt3uiifwyiqv5iepru5rnmmvkx6v4");
const RECORD: RootRecord = { version: ROOT_RECORD_VERSION, root: ROOT, count: 2, sizeBytes: 470 };
// The fetch-protocol response adds the chunk-CID index (see FetchRootRecord).
const FETCH_RECORD: FetchRootRecord = { ...RECORD, chunks: [ROOT] };

// A second root, so the bulk map's vector covers two distinct contests rather than a repeat.
const OTHER_ROOT = CID.parse("bafyreigz22r5ujmwkzdopj5b4yl55plabqbrq3hf3gvv4b6ekfbf2xxfd4");
/** A two-contest bulk answer: one contest with votes and a chunk index, one still empty. */
const BULK_RECORDS: Record<string, FetchRootRecord> = {
    "bitsocial-votes/biz": FETCH_RECORD,
    "bitsocial-votes/pol": { version: ROOT_RECORD_VERSION, root: OTHER_ROOT, chunks: [], count: 0, sizeBytes: 0 }
};

describe("pubsub message codec (two-kind union)", () => {
    // Cross-client spec: the envelope layout is pinned by these vectors — any change is a
    // breaking wire change that re-freezes them.
    it("pins the envelope bytes for a known bundle delta (fixed vector)", async () => {
        const cid = await bundleCidForBytes(encodeBundleMessage(encodeBundle(BUNDLE)));
        expect(cid.toString()).toBe("bafyreie4xh3uhrtxt4tsztnyw7mjyyfb6f2kbjafnlj7urflreofxzq6nq");
    });

    it("pins the envelope bytes for a known root record (fixed vector)", async () => {
        const cid = await bundleCidForBytes(encodeRootMessage(RECORD));
        expect(cid.toString()).toBe("bafyreih6zv4lx4oalkwaraejnu3ehlhhquvthr4vmxgklohpjzfmw62mby");
    });

    it("round-trips a bundle delta", () => {
        const blockBytes = encodeBundle(BUNDLE);
        const message = decodeVoteMessage(encodeBundleMessage(blockBytes));
        expect(message.kind).toBe("bundle");
        // Byte-content comparison: the encoder may hand back a Buffer, the decoder a Uint8Array.
        if (message.kind === "bundle") expect(Array.from(message.bundle)).toEqual(Array.from(blockBytes));
    });

    it("round-trips a root record, in the envelope and standalone (fetch protocol)", () => {
        // The pubsub heartbeat carries only the bare advertisement — the chunk index is stripped,
        // keeping the broadcast message constant-size.
        const inEnvelope = decodeVoteMessage(encodeRootMessage(FETCH_RECORD));
        expect(inEnvelope.kind).toBe("root");
        if (inEnvelope.kind === "root") expect(inEnvelope.record).toEqual(RECORD);

        // The fetch response carries the chunk-CID index so a cold joiner can skip the manifest pull.
        const standalone = decodeRootRecord(encodeRootRecord(FETCH_RECORD));
        expect(standalone.root.equals(FETCH_RECORD.root)).toBe(true);
        expect(standalone).toEqual(FETCH_RECORD);
    });

    it("keeps the root message within its fixed constant cap", () => {
        expect(encodeRootMessage(RECORD).length).toBeLessThanOrEqual(MAX_ROOT_MESSAGE_BYTES);
    });

    it("throws on malformed payloads (unknown kind, wrong version, extra fields, bad record)", () => {
        expect(() => decodeVoteMessage(new Uint8Array([0xff]))).toThrow();
        expect(() => decodeRootRecord(new Uint8Array([0xff]))).toThrow();
        expect(() => decodeRootRecord(encodeBundleMessage(encodeBundle(BUNDLE)))).toThrow();
        expect(() =>
            encodeRootMessage({ ...RECORD, count: -1 } as RootRecord)
        ).toThrow();
    });

    // Cross-client spec, as above: the bulk answer is what a directory-sized cold joiner reads
    // instead of one reply per contest, so its layout is frozen by the same kind of vector.
    it("pins the bulk root-record map's bytes (fixed vector)", async () => {
        const cid = await bundleCidForBytes(encodeBulkRootRecords(BULK_RECORDS));
        expect(cid.toString()).toBe("bafyreidsxpchf5kl5g7xp7lh5t523siaox5qazwmme5tb4pfave3isfrkm");
    });

    it("round-trips a bulk root-record map, entries identical to the per-topic codec's", () => {
        const decoded = decodeBulkRootRecords(encodeBulkRootRecords(BULK_RECORDS));
        expect(decoded).toEqual(BULK_RECORDS);
        expect(Object.keys(decoded).sort()).toEqual(["bitsocial-votes/biz", "bitsocial-votes/pol"]);
        // A batched entry must be byte-for-byte what the single-topic key would have served —
        // the caller hands both to the same `decodeRootRecord`, so any drift splits the paths.
        expect(decoded["bitsocial-votes/biz"]).toEqual(decodeRootRecord(encodeRootRecord(FETCH_RECORD)));
        expect(decoded["bitsocial-votes/biz"]!.root.equals(ROOT)).toBe(true);
    });

    it("round-trips inline chunk blocks, and keeps the block-less encoding byte-identical to the pre-inline one", async () => {
        // The optional per-record `chunkBlocks` payload (the whole cold pull in one round trip):
        // present entries must round-trip byte-exact, and its ABSENCE must leave the map's bytes
        // exactly what the pre-inline encoder produced — the field is additive, not a re-freeze
        // of the existing vector.
        const blockBytes = new Uint8Array([0xa1, 0x01, 0x02]); // any bytes; the CID check is the receiver's job
        const withBlocks = {
            ...BULK_RECORDS,
            "bitsocial-votes/biz": { ...FETCH_RECORD, chunkBlocks: [blockBytes] }
        };
        const decoded = decodeBulkRootRecords(encodeBulkRootRecords(withBlocks));
        expect(Array.from(decoded["bitsocial-votes/biz"]!.chunkBlocks![0]!)).toEqual(Array.from(blockBytes));
        expect(decoded["bitsocial-votes/pol"]!.chunkBlocks).toBeUndefined();
        // Absent field ⇒ the frozen no-inline vector still holds (same CID as the vector test).
        const cid = await bundleCidForBytes(encodeBulkRootRecords(BULK_RECORDS));
        expect(cid.toString()).toBe("bafyreidsxpchf5kl5g7xp7lh5t523siaox5qazwmme5tb4pfave3isfrkm");
    });

    it("round-trips the EMPTY map, which is a real answer and not the same as no answer", () => {
        // "I speak bulk, I serve nothing" — distinct from a pre-bulk peer's silence, which is what
        // the caller uses to decide whether to remember a peer as bulk-less (see makeRootPuller).
        expect(decodeBulkRootRecords(encodeBulkRootRecords({}))).toEqual({});
        expect(encodeBulkRootRecords({}).length).toBe(1); // a bare empty dag-cbor map
    });

    it("keeps the bulk key distinct from every per-topic key (one prefix registration, two shapes)", () => {
        // Both keys arrive at the same prefix-registered responder, which dispatches on the suffix:
        // if the bulk key ended in `/root` it would be read as a request for the topic
        // `bitsocial-votes` and answered with silence.
        expect(BULK_ROOTS_FETCH_KEY.endsWith(ROOT_FETCH_KEY_SUFFIX)).toBe(false);
        expect(BULK_ROOTS_FETCH_KEY).not.toBe(rootFetchKey("bitsocial-votes"));
    });

    it("throws on malformed bulk payloads, and on either root-record shape fed to the other's decoder", () => {
        expect(() => decodeBulkRootRecords(new Uint8Array([0xff]))).toThrow();
        // The two shapes must never be silently interchangeable: a single record decoded as a map
        // would surface as contests named `version`/`root`/`count`, and a map decoded as a record
        // would surface as one record with a garbage root.
        expect(() => decodeBulkRootRecords(encodeRootRecord(FETCH_RECORD))).toThrow();
        expect(() => decodeRootRecord(encodeBulkRootRecords(BULK_RECORDS))).toThrow();
        // One bad entry rejects the whole answer rather than encoding a record no peer can read.
        expect(() =>
            encodeBulkRootRecords({ ...BULK_RECORDS, "bitsocial-votes/bad": { ...FETCH_RECORD, count: -1 } })
        ).toThrow();
    });

    it("derives the per-message bundle cap from the criteria alone", () => {
        const one = maxBundleMessageBytes({ maxVotesPerAddress: 1 });
        const five = maxBundleMessageBytes({ maxVotesPerAddress: 5 });
        expect(five).toBeGreaterThan(one);
        // The cap must never reject a legitimate bundle: a real one-vote delta fits with room.
        expect(encodeBundleMessage(encodeBundle(BUNDLE)).length).toBeLessThan(one);
    });
});
