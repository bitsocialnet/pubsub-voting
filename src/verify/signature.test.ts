import { describe, it, expect } from "vitest";
import { verifyBundleSignature } from "./signature.js";
import { VotesBundleSchema, type VotesBundle } from "../schema/votes.js";

// The frozen v1 conformance vector from signer/eip712.test.ts, reused here so the verify
// side is checked against the exact same known-good signature the signer side pins.
const KEY_A = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";
const KEY_B = "12Czge2qhmFg7TPsvfRDyZiWbwho51g5fgqc6LoVD6nTUWbodZXw";

function hexToBytes(hex: `0x${string}`): Uint8Array {
    const body = hex.slice(2);
    const out = new Uint8Array(body.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
    return out;
}

const CRITERIA_CID = hexToBytes("0x0171122069ed193edc1ad0d931d7c6ceafeb8ba40ff1ca1a65cb0a6493e04c96483320c1");
const CHAIN_ID = 8453;
const SIGNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const SIG =
    "0x67813a39ba6e600b0370934a6cc8958c5d54b2f1bdbaa5c64457262133d41e16" +
    "3d045c635cc1ce1648421452b7a6075c4c3329205b79988c472a2e28a0bc7b5b1c";

/** The frozen-vector bundle, with optional overrides fed through the wire schema. */
function bundle(over: Partial<VotesBundle> = {}): VotesBundle {
    return VotesBundleSchema.parse({
        address: SIGNER,
        votes: [{ community: { publicKey: KEY_A }, vote: 1 }],
        blockNumber: 1000,
        signature: { signature: SIG, type: "eip712" },
        ...over
    });
}

const verify = (b: VotesBundle, criteriaCid = CRITERIA_CID, chainId = CHAIN_ID) =>
    verifyBundleSignature({ bundle: b, criteriaCid, chainId });

describe("verifyBundleSignature", () => {
    it("accepts the frozen v1 vector", async () => {
        expect((await verify(bundle())).valid).toBe(true);
    });

    it("accepts a lowercased address (case-insensitive match)", async () => {
        expect((await verify(bundle({ address: SIGNER.toLowerCase() }))).valid).toBe(true);
    });

    it("rejects a forged address that does not match the recovered signer", async () => {
        expect((await verify(bundle({ address: "0x0000000000000000000000000000000000000001" }))).valid).toBe(false);
    });

    it("rejects a tampered vote (different community)", async () => {
        expect((await verify(bundle({ votes: [{ community: { publicKey: KEY_B }, vote: 1 }] }))).valid).toBe(false);
    });

    it("rejects a tampered blockNumber", async () => {
        expect((await verify(bundle({ blockNumber: 1001 }))).valid).toBe(false);
    });

    it("rejects a different criteria CID (contest replay)", async () => {
        expect((await verify(bundle(), hexToBytes("0xdeadbeef"))).valid).toBe(false);
    });

    it("rejects a different chainId (cross-chain replay)", async () => {
        expect((await verify(bundle(), CRITERIA_CID, 1)).valid).toBe(false);
    });

    it("rejects an unknown signature type", async () => {
        expect((await verify(bundle({ signature: { signature: SIG, type: "ed25519" } }))).valid).toBe(false);
    });

    it("rejects a non-hex signature without throwing", async () => {
        expect((await verify(bundle({ signature: { signature: "nothex", type: "eip712" } }))).valid).toBe(false);
    });

    it("rejects a malformed hex signature without throwing", async () => {
        expect((await verify(bundle({ signature: { signature: "0x1234", type: "eip712" } }))).valid).toBe(false);
    });
});
