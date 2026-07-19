import { describe, it, expect } from "vitest";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import type { PeerId } from "@libp2p/interface";
import { adaptBlockstore } from "./helia.js";

const peerId = (id: string) => ({ toString: () => id }) as unknown as PeerId;

async function rawCid(bytes: Uint8Array): Promise<CID> {
    return CID.createV1(raw.code, await sha256.digest(bytes));
}

describe("adaptBlockstore get normalisation", () => {
    it("passes through a plain Promise<Uint8Array> blockstore and forwards put/has", async () => {
        const bytes = new Uint8Array([1, 2, 3]);
        const cid = await rawCid(bytes);
        const puts: string[] = [];
        const adapted = adaptBlockstore({
            get: async () => bytes,
            put: async (c) => {
                puts.push(c.toString());
                return c;
            },
            has: async (c) => c.equals(cid)
        });
        expect(await adapted.get(cid)).toEqual(bytes);
        expect(await adapted.put(cid, bytes)).toBe(cid);
        expect(puts).toEqual([cid.toString()]);
        expect(await adapted.has(cid)).toBe(true);
    });

    it("concatenates a multi-chunk streaming get in order (Helia's Blocks interface)", async () => {
        const bytes = new Uint8Array([1, 2, 3, 4, 5]);
        const cid = await rawCid(bytes);
        const adapted = adaptBlockstore({
            get: () =>
                (async function* () {
                    yield bytes.slice(0, 2);
                    yield bytes.slice(2);
                })(),
            put: async (c) => c,
            has: async () => true
        });
        expect(await adapted.get(cid)).toEqual(bytes);
    });

    it("rejects a stream that yields no bytes (a block cannot be empty-by-omission)", async () => {
        const cid = await rawCid(new Uint8Array([1]));
        const adapted = adaptBlockstore({
            get: () => (async function* () {})(),
            put: async (c) => c,
            has: async () => true
        });
        await expect(adapted.get(cid)).rejects.toThrow(/yielded no bytes/);
    });
});

describe("adaptBlockstore sessions", () => {
    it("omits createSession when the raw blockstore cannot make sessions", () => {
        const adapted = adaptBlockstore({
            get: async () => new Uint8Array(),
            put: async (cid) => cid,
            has: async () => false
        });
        expect(adapted.createSession).toBeUndefined();
    });

    it("adapts a session: streaming get normalised, providers/addPeer/close passed through", async () => {
        const bytes = new Uint8Array([1, 2, 3]);
        const cid = await rawCid(bytes);
        const opened: Array<{ root: string; providers: string[]; maxProviders?: number }> = [];
        const added: string[] = [];
        let closed = 0;
        const store = adaptBlockstore({
            get: async () => new Uint8Array(),
            put: async (c) => c,
            has: async () => false,
            createSession: (root, options) => {
                opened.push({
                    root: root.toString(),
                    providers: (options?.providers ?? []).map((p) => p.toString()),
                    maxProviders: options?.maxProviders
                });
                return {
                    // Helia's real session get streams like the parent store's — one chunk here.
                    get: () =>
                        (async function* () {
                            yield bytes;
                        })(),
                    addPeer: (peer: PeerId) => {
                        added.push(peer.toString());
                    },
                    close: () => {
                        closed++;
                    }
                };
            }
        });
        expect(store.createSession).toBeDefined();
        const session = store.createSession!(cid, { providers: [peerId("peer-a")], maxProviders: 2 });
        expect(opened).toEqual([{ root: cid.toString(), providers: ["peer-a"], maxProviders: 2 }]);
        expect(await session.get(cid)).toEqual(bytes);
        void session.addPeer(peerId("peer-b"));
        session.close();
        expect(added).toEqual(["peer-b"]);
        expect(closed).toBe(1);
    });
});
