import { describe, it, expect } from "vitest";
import { hashTypedData, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ballotTypedData, BALLOT_TYPES, EIP712_DOMAIN_NAME } from "./eip712.js";
import { VoteSchema, type Vote } from "../schema/votes.js";

// Two distinct, schema-valid B58 IPNS community keys. Building test votes through VoteSchema
// (rather than raw literals) keeps this suite honest: the exact bytes that flow through
// the ballot are the bytes the wire schema actually accepts.
const KEY_A = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";
const KEY_B = "12Czge2qhmFg7TPsvfRDyZiWbwho51g5fgqc6LoVD6nTUWbodZXw";

/** A schema-validated vote for KEY_A, with optional overrides, for feeding ballotTypedData. */
function vote(over: { community?: { name?: string; publicKey: string }; vote?: number } = {}): Vote {
    return VoteSchema.parse({ community: { publicKey: KEY_A }, vote: 1, ...over });
}

/** Decode a lowercase `0x`-hex string to bytes (test helper for building CID inputs). */
function hexToBytes(hex: `0x${string}`): Uint8Array {
    const body = hex.slice(2);
    const out = new Uint8Array(body.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
    return out;
}

// The frozen v1 conformance vector's criteria CID (dag-cbor, sha2-256, 36 bytes).
const CRITERIA_CID = hexToBytes("0x0171122069ed193edc1ad0d931d7c6ceafeb8ba40ff1ca1a65cb0a6493e04c96483320c1");

const base = { criteriaCid: CRITERIA_CID, chainId: 8453, blockNumber: 1000 };

describe("ballotTypedData", () => {
    it("sets the shared domain and primary type", () => {
        const td = ballotTypedData({ ...base, votes: [vote()] });
        expect(td.domain).toEqual({ name: EIP712_DOMAIN_NAME, chainId: 8453 });
        expect(td.primaryType).toBe("Ballot");
        expect(td.types).toBe(BALLOT_TYPES);
    });

    it("binds criteria + blockNumber and converts integers to bigint", () => {
        const td = ballotTypedData({ ...base, votes: [vote()] });
        expect(td.message.criteria).toBe("0x0171122069ed193edc1ad0d931d7c6ceafeb8ba40ff1ca1a65cb0a6493e04c96483320c1");
        expect(td.message.blockNumber).toBe(1000n);
        expect(td.message.votes).toEqual([{ community: { name: "", publicKey: KEY_A }, vote: 1n }]);
    });

    it("carries an empty votes array (the withdrawal form)", () => {
        const td = ballotTypedData({ ...base, votes: [] });
        expect(td.message.votes).toEqual([]);
        expect(() => hashTypedData(td)).not.toThrow();
    });

    it("produces well-formed typed data that hashes deterministically", () => {
        const a = ballotTypedData({ ...base, votes: [vote()] });
        const b = ballotTypedData({ ...base, votes: [vote()] });
        expect(hashTypedData(a)).toBe(hashTypedData(b));
    });

    it("hashes differently when any bound field changes", () => {
        const h = (over: Partial<typeof base> & { votes?: Vote[] }) =>
            hashTypedData(ballotTypedData({ ...base, votes: [vote()], ...over }));
        const ref = h({});
        expect(h({ criteriaCid: hexToBytes("0xdeadbeef") })).not.toBe(ref);
        expect(h({ chainId: 1 })).not.toBe(ref);
        expect(h({ blockNumber: 1001 })).not.toBe(ref);
        expect(h({ votes: [vote({ community: { publicKey: KEY_B } })] })).not.toBe(ref);
        expect(h({ votes: [vote({ vote: 2 })] })).not.toBe(ref);
        // `name` is part of the signed Community struct, so it changes the hash too.
        expect(h({ votes: [vote({ community: { name: "biz.bso", publicKey: KEY_A } })] })).not.toBe(ref);
    });
});

/**
 * Frozen v1 conformance vector. These literals ARE the wire spec: an independent client
 * must reproduce this hash, signature, and recovered signer byte-for-byte. If any of these
 * assertions needs updating, the ballot layout changed — that is a breaking wire change
 * that must re-freeze this vector on purpose, never a silent edit (the domain carries no
 * version to bump). Unlike the self-consistency tests above, these compare against hand-frozen output,
 * so a layout change (e.g. int256 -> uint256, or bytes -> string) fails here loudly.
 *
 * Key is the well-known anvil/hardhat test account #1 — it holds no real funds and exists
 * only to make the signature reproducible.
 */
describe("EIP-712 ballot v1 frozen vector", () => {
    const PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    const SIGNER_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const EXPECTED_HASH = "0x1b0c3e29a0bffb1305d7dc278707165ea5bbf8004b65b24738256a5544facc7a";
    const EXPECTED_SIGNATURE =
        "0x67813a39ba6e600b0370934a6cc8958c5d54b2f1bdbaa5c64457262133d41e16" +
        "3d045c635cc1ce1648421452b7a6075c4c3329205b79988c472a2e28a0bc7b5b1c";

    const vector = ballotTypedData({
        criteriaCid: CRITERIA_CID,
        chainId: 8453,
        votes: [VoteSchema.parse({ community: { publicKey: KEY_A }, vote: 1 })],
        blockNumber: 1000
    });

    it("hashes to the frozen digest", () => {
        expect(hashTypedData(vector)).toBe(EXPECTED_HASH);
    });

    it("produces the frozen signature", async () => {
        const account = privateKeyToAccount(PRIVATE_KEY);
        expect(await account.signTypedData(vector)).toBe(EXPECTED_SIGNATURE);
    });

    it("recovers the frozen signer", async () => {
        const recovered = await recoverTypedDataAddress({ ...vector, signature: EXPECTED_SIGNATURE });
        expect(recovered).toBe(SIGNER_ADDRESS);
    });
});
