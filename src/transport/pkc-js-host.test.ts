import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import PKC from "@pkcprotocol/pkc-js";
import { PubsubVoter } from "../client/voter.js";
import { topicFor } from "../topic.js";
import { adaptBlockstore } from "./helia.js";
import { bizCriteria, realSigner, stubChains } from "../test-fixtures.js";

/**
 * The pkc-js HOST CONTRACT, offline: a stock `PKC({ libp2pJsClientsOptions })` instance's shared
 * Helia node — the exact object a real consumer injects, `pkc.clients.libp2pJsClients[key]._helia`
 * — must pass `PubsubVoter`'s construction guards (gossipsub + blockstore + fetch service, all
 * registered by pkc-js since 0.0.63) and drive the offline facade. The unit suite's other
 * transport tests exercise fakes shaped like the host node; this one pins the REAL host object,
 * so a pkc-js release that stops registering a service (or reshapes the blockstore) fails here,
 * not in production. Everything stays offline: the node listens on nothing, dials nobody, and the
 * one configured router URL is a reserved-TLD name that can never resolve. The networked
 * end-to-end path lives in `integration/pkc-js-host.integration.test.ts`.
 */

// The injected-node seam, reached the way consumers reach it today. TODO: switch to the public
// `client.heliaNode` accessor once pkc-js#221 ships (implemented in pkc-js PR #223).
type PkcInstance = Awaited<ReturnType<typeof PKC>>;
const sharedHelia = (pkc: PkcInstance, key: string) => {
    const client = pkc.clients.libp2pJsClients[key];
    if (client === undefined) throw new Error(`pkc-js created no libp2p-js client under key "${key}"`);
    return client._helia;
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
        const voter = new PubsubVoter({ dataPath: false, helia, chains: stubChains(), signer: realSigner() });
        voters.push(voter);

        const contest = await voter.createContest({ criteria: bizCriteria() });
        expect(contest.topic).toBe(await topicFor(bizCriteria()));
        // A fresh contest tallies empty without joining the topic — fully offline.
        expect(await contest.getTally()).toEqual({ contestId: "biz", ranking: [] });
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
