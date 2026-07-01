import { describe, it, expect } from "vitest";
import { hashTypedData, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
    ballotTypedData,
    BALLOT_TYPES,
    EIP712_DOMAIN_NAME,
    EIP712_DOMAIN_VERSION
} from "./eip712.js";

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
        const td = ballotTypedData({ ...base, votes: [{ board: "b", vote: 1 }] });
        expect(td.domain).toEqual({ name: EIP712_DOMAIN_NAME, version: EIP712_DOMAIN_VERSION, chainId: 8453 });
        expect(td.primaryType).toBe("Ballot");
        expect(td.types).toBe(BALLOT_TYPES);
    });

    it("binds criteria + blockNumber and converts integers to bigint", () => {
        const td = ballotTypedData({ ...base, votes: [{ board: "b", vote: 1 }] });
        expect(td.message.criteria).toBe("0x0171122069ed193edc1ad0d931d7c6ceafeb8ba40ff1ca1a65cb0a6493e04c96483320c1");
        expect(td.message.blockNumber).toBe(1000n);
        expect(td.message.votes).toEqual([{ board: "b", vote: 1n }]);
    });

    it("carries an empty votes array (the withdrawal form)", () => {
        const td = ballotTypedData({ ...base, votes: [] });
        expect(td.message.votes).toEqual([]);
        expect(() => hashTypedData(td)).not.toThrow();
    });

    it("produces well-formed typed data that hashes deterministically", () => {
        const a = ballotTypedData({ ...base, votes: [{ board: "b", vote: 1 }] });
        const b = ballotTypedData({ ...base, votes: [{ board: "b", vote: 1 }] });
        expect(hashTypedData(a)).toBe(hashTypedData(b));
    });

    it("hashes differently when any bound field changes", () => {
        const h = (over: Partial<typeof base> & { votes?: { board: string; vote: number }[] }) =>
            hashTypedData(ballotTypedData({ ...base, votes: [{ board: "b", vote: 1 }], ...over }));
        const ref = h({});
        expect(h({ criteriaCid: hexToBytes("0xdeadbeef") })).not.toBe(ref);
        expect(h({ chainId: 1 })).not.toBe(ref);
        expect(h({ blockNumber: 1001 })).not.toBe(ref);
        expect(h({ votes: [{ board: "c", vote: 1 }] })).not.toBe(ref);
        expect(h({ votes: [{ board: "b", vote: 2 }] })).not.toBe(ref);
    });
});

/**
 * Frozen v1 conformance vector. These literals ARE the wire spec: an independent client
 * must reproduce this hash, signature, and recovered signer byte-for-byte. If any of these
 * assertions needs updating, the ballot layout changed — that is a breaking wire change
 * that must bump EIP712_DOMAIN_VERSION and re-freeze this vector on purpose, never a silent
 * edit. Unlike the self-consistency tests above, these compare against hand-frozen output,
 * so a layout change (e.g. int256 -> uint256, or bytes -> string) fails here loudly.
 *
 * Key is the well-known anvil/hardhat test account #1 — it holds no real funds and exists
 * only to make the signature reproducible.
 */
describe("EIP-712 ballot v1 frozen vector", () => {
    const PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    const SIGNER_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const EXPECTED_HASH = "0x9ffd0912b8eb3289e94f1f3e69a7dd98d3c2d3d6e5bceef68957135c78838670";
    const EXPECTED_SIGNATURE =
        "0x4db2601f61c4aabf70c7a570f3728d1fd5b9caf70fe9ec5c3ec92225d414ccc6" +
        "5124dd7b52bf9c5ef4cd0eadbe8288def00e42512aa736676ec7fb586a1c0c9e1b";

    const vector = ballotTypedData({
        criteriaCid: CRITERIA_CID,
        chainId: 8453,
        votes: [{ board: "0x000000000000000000000000000000000000b0a4", vote: 1 }],
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
