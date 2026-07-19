import { describe, it, expect, afterEach } from "vitest";
import PKC from "@pkcprotocol/pkc-js";
import { PubsubVoter, type Contest } from "../../client/voter.js";
import { topicFor } from "../../topic.js";
import { bizCriteria, realSigner, stubChains } from "../../test-fixtures.js";
import type { ContestTally } from "../../tally/types.js";
import { waitFor } from "./harness.js";

/**
 * End to end on REAL pkc-js hosts: three `PKC({ libp2pJsClientsOptions })` instances in one
 * process (distinct keys ⇒ distinct shared nodes), each injecting its OWN shared Helia node —
 * `pkc.clients.libp2pJsClients[key].heliaNode`, the public accessor production consumers use —
 * into a real `PubsubVoter`. Unlike the other integration tests, nothing here is harness-built: the
 * nodes run pkc-js's stock configuration (gossipsub 16.0.2 + `@libp2p/fetch` registered since
 * 0.0.63, its default connection gater, loopback TCP listeners passed through
 * `libp2pOptions.addresses`), so this pins the full host contract the library documents —
 * construction guards, live-delta publish over the host's gossipsub, the forward-gate verify on
 * the receiver, and a later joiner's cold-start checkpoint pull over the host's fetch service +
 * bitswap.
 *
 * The router URL is a reserved-TLD name that can never resolve: discovery via
 * `libp2p.contentRouting` degrades to "no providers" (pkc-js wraps router errors, issue #171),
 * so every byte moves over the direct loopback dials — deterministic, no external network.
 *
 * Slow by design — excluded from `npm test`, run via `npm run test:integration`.
 */

const KEY_A = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";

let cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
    for (const cleanup of cleanups.reverse()) {
        await cleanup().catch(() => {}); // a node stopped mid-test stops again harmlessly
    }
    cleanups = [];
});

/**
 * One pkc-js instance with an in-process shared Helia node listening on loopback TCP, and a REAL
 * `PubsubVoter` injected with that node. `signed` adds the anvil test-account signer (the
 * publisher); omitting it builds a read-only voter (the receivers).
 */
async function pkcHostedVoter(key: string, options: { signed?: boolean } = {}) {
    const pkc = await PKC({
        libp2pJsClientsOptions: [{ key, libp2pOptions: { addresses: { listen: ["/ip4/127.0.0.1/tcp/0"] } } }],
        httpRoutersOptions: ["https://router.invalid"],
        dataPath: undefined
    });
    cleanups.push(() => pkc.destroy());
    const client = pkc.clients.libp2pJsClients[key];
    if (client === undefined) throw new Error(`pkc-js created no libp2p-js client under key "${key}"`);
    // The injected-node seam: the public, semver-covered `heliaNode` accessor (pkc-js#221,
    // shipped in 0.0.72) — no more reaching through the private `_helia`.
    const helia = client.heliaNode;

    const voter = new PubsubVoter({
        dataPath: false,
        helia,
        chains: stubChains(),
        ...(options.signed ? { signer: realSigner() } : {})
    });
    cleanups.push(() => voter.destroy());
    const contest: Contest = await voter.createContest({ criteria: bizCriteria() });
    return { helia, voter, contest };
}

const totalWeight = (tally: ContestTally): bigint => tally.ranking.reduce((sum, row) => sum + row.weight, 0n);

describe("pkc-js-hosted voters (real PKC shared nodes)", () => {
    it(
        "a vote published on one pkc-js host reaches a meshed peer live and a later joiner via checkpoint pull",
        async () => {
            const topic = await topicFor(bizCriteria());

            // A: the publisher/seeder. B: a live receiver. Both join the topic before the mesh
            // forms, so A's publish is a real gossipsub delivery through B's forward-gate.
            const a = await pkcHostedVoter("pkc-host-a", { signed: true });
            const b = await pkcHostedVoter("pkc-host-b");
            expect(a.contest.topic).toBe(topic);
            await a.contest.update();
            await b.contest.update();
            await b.helia.libp2p.dial(a.helia.libp2p.getMultiaddrs());
            await waitFor(
                () =>
                    a.helia.libp2p.services.pubsub.getMeshPeers(topic).includes(b.helia.libp2p.peerId.toString()) &&
                    b.helia.libp2p.services.pubsub.getMeshPeers(topic).includes(a.helia.libp2p.peerId.toString()),
                30_000,
                "gossipsub mesh to form between the two pkc-js hosts"
            );

            // Live leg: a genuinely-signed ballot, published through A's pkc-js gossipsub. B's
            // forward-gate runs the FULL verify pipeline (signature recovery, the erc721 gate via
            // the stub chain) before admitting, so B's row lands already chain-verified.
            const vote = await a.voter.createContestVote({
                criteria: bizCriteria(),
                votes: [{ community: { publicKey: KEY_A }, vote: 1 }]
            });
            const { recipientCount } = await vote.publish();
            expect(recipientCount).toBeGreaterThanOrEqual(1); // gossipsub reached B directly
            await waitFor(
                async () => {
                    const tally = await b.contest.getTally();
                    return totalWeight(tally) === 1n && tally.ranking.every((row) => row.chainVerified);
                },
                30_000,
                "B to receive and verify A's vote over live gossip"
            );

            // Cold-join leg: C subscribes only after the publish, so gossip can never replay the
            // vote to it — everything it tallies came from the checkpoint root-record pull over
            // the host's fetch service and the bitswap chase behind it.
            const c = await pkcHostedVoter("pkc-host-c");
            await c.helia.libp2p.dial(b.helia.libp2p.getMultiaddrs());
            await c.contest.update();
            await waitFor(
                async () => {
                    const tally = await c.contest.getTally();
                    return totalWeight(tally) === 1n && tally.ranking.every((row) => row.chainVerified);
                },
                45_000,
                "C to cold-join the checkpoint from a pkc-js host and settle"
            );

            const tally = await c.contest.getTally();
            expect(tally.ranking).toHaveLength(1);
            expect(tally.ranking[0]!.community.publicKey).toBe(KEY_A);
            expect(tally.ranking[0]!.weight).toBe(1n);
        },
        120_000
    );
});
