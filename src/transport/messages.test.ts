import { describe, it, expect } from "vitest";
import { CID } from "multiformats/cid";
import {
    decodeVoteMessage,
    encodeBundleMessage,
    encodeRootMessage,
    encodeRootRecord,
    decodeRootRecord,
    maxBundleMessageBytes,
    MAX_ROOT_MESSAGE_BYTES,
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

    it("derives the per-message bundle cap from the criteria alone", () => {
        const one = maxBundleMessageBytes({ maxVotesPerAddress: 1 });
        const five = maxBundleMessageBytes({ maxVotesPerAddress: 5 });
        expect(five).toBeGreaterThan(one);
        // The cap must never reject a legitimate bundle: a real one-vote delta fits with room.
        expect(encodeBundleMessage(encodeBundle(BUNDLE)).length).toBeLessThan(one);
    });
});
