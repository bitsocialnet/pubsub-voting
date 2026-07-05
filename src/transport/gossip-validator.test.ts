import { describe, it, expect } from "vitest";
import type { CID } from "multiformats/cid";
import { makeGossipGate, type GossipGateDeps } from "./gossip-validator.js";
import { encodeWinnerCids, decodeWinnerCids } from "./winner-cids.js";
import { makeVerdictCache } from "../verify/cache.js";
import { bundleCid } from "../crdt/codec.js";
import type { BundleVerifier } from "../verify/types.js";
import type { VotesBundle } from "../schema/votes.js";

const KEY_A = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";

function bundle(address: string): VotesBundle {
    return { address, votes: [{ board: { publicKey: KEY_A }, vote: 1 }], blockNumber: 1, signature: { signature: "0x", type: "eip712" } };
}

async function makeNode(address: string): Promise<{ cid: CID; node: VotesBundle }> {
    const node = bundle(address);
    return { cid: await bundleCid(node), node };
}

const okVerifier: BundleVerifier = { verify: async () => ({ valid: true, ruleScore: 1n, resolvedNames: {} }) };
const badVerifier: BundleVerifier = { verify: async () => ({ valid: false, reason: "invalid" }) };

const DEFAULT_BOUNDS = { maxWinnerCidsPerMessage: 16, maxMessageBytes: 1 << 20 };

function gate(over: Partial<GossipGateDeps> & { fetchNode: GossipGateDeps["fetchNode"] }) {
    return makeGossipGate({
        decodeWinnerCids,
        verifier: okVerifier,
        cache: makeVerdictCache(),
        merge: async () => {},
        limit: (fn) => fn(),
        allowPeer: () => true,
        bounds: DEFAULT_BOUNDS,
        timeoutMs: 5000,
        ...over
    });
}

const fetcher =
    (nodes: Map<string, VotesBundle>) =>
    async (cid: CID): Promise<VotesBundle | undefined> =>
        nodes.get(cid.toString());

describe("makeGossipGate", () => {
    it("accepts a valid single-CID message and merges it", async () => {
        const { cid, node } = await makeNode("0x1");
        let merged: CID[] | undefined;
        const accepted: Array<[CID[], string]> = [];
        const g = gate({
            fetchNode: fetcher(new Map([[cid.toString(), node]])),
            merge: async (h) => {
                merged = h;
            },
            onAccept: (h, from) => accepted.push([h, from])
        });

        expect(await g.validate(encodeWinnerCids([cid]), "peer1")).toBe("accept");
        expect(merged?.[0].equals(cid)).toBe(true);
        expect(accepted[0][1]).toBe("peer1");
    });

    it("rejects malformed bytes (layer-1)", async () => {
        const g = gate({ fetchNode: async () => undefined });
        expect(await g.validate(new Uint8Array([0xff, 0xff]), "p")).toBe("reject");
    });

    it("rejects an oversized message", async () => {
        const { cid, node } = await makeNode("0x1");
        const g = gate({ fetchNode: fetcher(new Map([[cid.toString(), node]])), bounds: { ...DEFAULT_BOUNDS, maxMessageBytes: 5 } });
        expect(await g.validate(encodeWinnerCids([cid]), "p")).toBe("reject");
    });

    it("rejects too many CIDs", async () => {
        const { cid, node } = await makeNode("0x1");
        const g = gate({ fetchNode: fetcher(new Map([[cid.toString(), node]])), bounds: { ...DEFAULT_BOUNDS, maxWinnerCidsPerMessage: 0 } });
        expect(await g.validate(encodeWinnerCids([cid]), "p")).toBe("reject");
    });

    it("ignores a peer over its rate limit (no penalty)", async () => {
        const { cid, node } = await makeNode("0x1");
        const g = gate({ fetchNode: fetcher(new Map([[cid.toString(), node]])), allowPeer: () => false });
        expect(await g.validate(encodeWinnerCids([cid]), "p")).toBe("ignore");
    });

    it("ignores an empty CID announcement", async () => {
        const g = gate({ fetchNode: async () => undefined });
        expect(await g.validate(encodeWinnerCids([]), "p")).toBe("ignore");
    });

    it("ignores an unfetchable CID (not the sender's provable fault)", async () => {
        const { cid } = await makeNode("0x1");
        const g = gate({ fetchNode: async () => undefined }); // never resolves to a node
        expect(await g.validate(encodeWinnerCids([cid]), "p")).toBe("ignore");
    });

    it("rejects a bundle that fails verification", async () => {
        const { cid, node } = await makeNode("0xbad");
        const g = gate({ fetchNode: fetcher(new Map([[cid.toString(), node]])), verifier: badVerifier });
        expect(await g.validate(encodeWinnerCids([cid]), "p")).toBe("reject");
    });

    it("short-circuits to accept on a verdict-cache hit without fetching", async () => {
        const { cid } = await makeNode("0x1");
        const cache = makeVerdictCache();
        cache.set(cid, { valid: true, ruleScore: 1n, resolvedNames: {} });
        let fetches = 0;
        const g = gate({
            fetchNode: async () => {
                fetches++;
                return undefined;
            },
            cache
        });
        expect(await g.validate(encodeWinnerCids([cid]), "p")).toBe("accept");
        expect(fetches).toBe(0);
    });

    it("rejects on a cached-invalid CID without fetching", async () => {
        const { cid } = await makeNode("0x1");
        const cache = makeVerdictCache();
        cache.set(cid, { valid: false, reason: "known bad" });
        let fetches = 0;
        const g = gate({
            fetchNode: async () => {
                fetches++;
                return undefined;
            },
            cache
        });
        expect(await g.validate(encodeWinnerCids([cid]), "p")).toBe("reject");
        expect(fetches).toBe(0);
    });

    it("rejects when more CIDs than maxWinnerCidsPerMessage are announced", async () => {
        const a = await makeNode("0x1");
        const b = await makeNode("0x2");
        const nodes = new Map([
            [a.cid.toString(), a.node],
            [b.cid.toString(), b.node]
        ]);
        const g = gate({ fetchNode: fetcher(nodes), bounds: { ...DEFAULT_BOUNDS, maxWinnerCidsPerMessage: 1 } });
        expect(await g.validate(encodeWinnerCids([a.cid, b.cid]), "p")).toBe("reject");
    });

    it("wraps every fetch through the concurrency limiter", async () => {
        const a = await makeNode("0x1");
        const b = await makeNode("0x2");
        const nodes = new Map([
            [a.cid.toString(), a.node],
            [b.cid.toString(), b.node]
        ]);
        let limited = 0;
        const g = gate({
            fetchNode: fetcher(nodes),
            limit: (fn) => {
                limited++;
                return fn();
            }
        });
        expect(await g.validate(encodeWinnerCids([a.cid, b.cid]), "p")).toBe("accept");
        expect(limited).toBe(2); // one per fetched bundle in the message
    });

    it("ignores (does not hang) when a fetch exceeds the timeout", async () => {
        const { cid } = await makeNode("0x1");
        const g = gate({ fetchNode: () => new Promise<undefined>(() => {}), timeoutMs: 50 });
        expect(await g.validate(encodeWinnerCids([cid]), "p")).toBe("ignore");
    });
});
