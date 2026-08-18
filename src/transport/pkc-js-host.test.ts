import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import PKC from "@pkcprotocol/pkc-js";
import { PubsubVoter } from "../client/voter.js";
import { topicFor } from "../topic.js";
import { adaptBlockstore } from "./helia.js";
import { requireAnnounceSigner, signedProvidersBody } from "./announce/record.js";
import { verifyProvidersBody } from "./announce/router-verifier.test-fixtures.js";
import { bizCriteria, realSigner, stubChains } from "../test-fixtures.js";

/**
 * The pkc-js HOST CONTRACT, offline: a stock `PKC({ libp2pJsClientsOptions })` instance's shared
 * Helia node — the exact object a real consumer injects, reached through the public
 * `pkc.clients.libp2pJsClients[key].heliaNode` accessor (pkc-js#221, shipped in 0.0.72) —
 * must pass `PubsubVoter`'s construction guards (gossipsub + blockstore + fetch service, all
 * registered by pkc-js since 0.0.63) and drive the offline facade. The unit suite's other
 * transport tests exercise fakes shaped like the host node; this one pins the REAL host object,
 * so a pkc-js release that stops registering a service (or reshapes the blockstore) fails here,
 * not in production. Everything stays offline: the node listens on nothing, dials nobody, and the
 * one configured router URL is a reserved-TLD name that can never resolve. The networked
 * end-to-end path lives in `integration/pkc-js-host.integration.test.ts`.
 */

// The injected-node seam: `heliaNode` is the public, semver-covered accessor for the shared
// Helia node (pkc-js#221, shipped in 0.0.72) — no more reaching through the private `_helia`.
type PkcInstance = Awaited<ReturnType<typeof PKC>>;
const sharedHelia = (pkc: PkcInstance, key: string) => {
    const client = pkc.clients.libp2pJsClients[key];
    if (client === undefined) throw new Error(`pkc-js created no libp2p-js client under key "${key}"`);
    return client.heliaNode;
};

describe("pkc-js host contract (offline)", () => {
    let pkc: PkcInstance;
    let helia: ReturnType<typeof sharedHelia>;
    const voters: PubsubVoter[] = [];

    beforeAll(async () => {
        pkc = await PKC({
            libp2pJsClientsOptions: [{ key: "voting-host-contract" }],
            httpRoutersOptions: ["https://router.invalid"],
            dataPath: undefined
        });
        helia = sharedHelia(pkc, "voting-host-contract");
    });

    afterAll(async () => {
        for (const voter of voters) await voter.destroy().catch(() => {});
        await pkc.destroy();
    });

    it("the shared Helia node passes PubsubVoter's construction guards and drives the facade", async () => {
        // Would throw MissingPubsubError / MissingBlockstoreError / MissingFetchError on a node
        // missing any of the three surfaces the transport drives.
        const voter = new PubsubVoter({ dataPath: false, helia, chains: stubChains() });
        voters.push(voter);

        const contest = await voter.createContest({ criteria: bizCriteria() });
        expect(contest.topic).toBe(await topicFor(bizCriteria()));
        // A fresh contest tallies empty without joining the topic — fully offline.
        expect(await contest.getTally()).toEqual({ contestId: "biz", ranking: [] });
    });

    it("the node's own key signs a provider record the HTTP routers accept", async () => {
        // The announce path's other half of the host contract (issue #38): pkc-http-router — the
        // implementation every configured router is assumed to run — verifies the IPIP-0526
        // signature and 403s the whole PUT without it. Pin it against the REAL node: the key must
        // be reachable where libp2p keeps it, and libp2p's `PrivateKey.sign` over the payload
        // digest must be what the router's verifier accepts for THIS node's peer id. A fake signer
        // could only prove the fixture agrees with itself.
        const signer = requireAnnounceSigner(helia.libp2p);
        const body = await signedProvidersBody(
            {
                peerId: helia.libp2p.peerId.toString(),
                addrs: ["/ip4/203.0.113.5/tcp/4001"],
                keys: ["bafyreihjvjzva7reg5ot6e6ahu74z2nppohcvkmk4rrykg2voike3vfjcu"],
                timestamp: Date.now()
            },
            signer
        );

        expect(verifyProvidersBody(body)).toEqual({ valid: true });
    });

    it("the node's blockstore round-trips a block through adaptBlockstore", async () => {
        // Helia's BlockStorage.get yields the block over an async generator, not a bare promise —
        // the latent bug the two-node integration test surfaced (fixed by adaptBlockstore). Pin
        // the adaptation against the REAL pkc-js node's blockstore, not a fake shaped like it.
        const store = adaptBlockstore(helia.blockstore as never);
        const bytes = new TextEncoder().encode("pkc-js host blockstore round-trip");
        const cid = CID.createV1(raw.code, await sha256.digest(bytes));

        await store.put(cid, bytes);
        expect(await store.has(cid)).toBe(true);
        expect(await store.get(cid)).toEqual(bytes);
    });
});
