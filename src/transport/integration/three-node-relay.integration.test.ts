import { describe, it, expect, afterEach } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { PubsubVoter, type Contest } from "../../client/voter.js";
import { topicFor, criteriaCid } from "../../topic.js";
import { bizCriteria } from "../../test-fixtures.js";
import { ballotTypedData, EIP712_SIGNATURE_TYPE } from "../../signer/eip712.js";
import type { ChainClient, ChainClientFactory } from "../../chain/types.js";
import type { Vote, VotesBundle } from "../../schema/votes.js";
import type { ContestTally } from "../../tally/types.js";
import { makeVoteNode, makeBareNode, waitFor } from "./harness.js";

/**
 * Seeder-to-seeder relay, end to end: a seeder that COLD-JOINED a contest (pulled another
 * seeder's checkpoint, admitted on the offline checks, settled the deferred gate reads in the
 * background verifier) must re-serve those votes to the next joiner from its own checkpoint.
 * Three real loopback libp2p + Helia nodes: the origin seeder A is the two-node harness (its
 * internals are not under test — it just holds five genuinely-signed bundles and serves its
 * root record), while B and C are REAL `PubsubVoter`s riding bare host nodes, so the whole
 * production joiner path runs twice — cold-start subscriber pull over libp2p fetch, chunk
 * fast-path chase over bitswap, offline verify, background gate settlement, and the lazily
 * registered fetch responder serving onward.
 *
 * The load-bearing step is stopping A before C joins: C is connected only to B, so every vote
 * C tallies can only have come from B's re-served checkpoint. The negative control pins the
 * other half of the contract: a bundle failing B's OWN chain gate is evicted by B's background
 * verifier and never reaches C, even though C's chain view would have accepted it — a relay
 * seeder serves what it verified, not what it was handed. (The pending-window serve gate —
 * unverified rows withheld — is unit-tested in client/voter.test.ts; racing it here would be
 * flaky by construction.)
 *
 * Slow by design — excluded from `npm test`, run via `npm run test:integration`.
 */

const BIZ_CHAIN_ID = 8453;
const KEY_A = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";
const KEY_B = "12D3KooWQYV9dGMFoRzNStwpXztXaBUjtPqi6aU76ZgUriHhKust";

// The anvil/hardhat well-known accounts #1–#5: five distinct voting wallets signing real
// EIP-712 ballots (B and C run the REAL offline verify — recover must match `address`).
const WALLETS = [
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
    "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"
].map((key) => privateKeyToAccount(key as `0x${string}`));
// Wallets #1–#4 vote for KEY_A; the odd wallet #5 votes for KEY_B. Keying the odd wallet to its
// own community makes wallet-level propagation visible through the public tally: KEY_B's row
// exists exactly when wallet #5's bundle arrived.
const ODD_WALLET = WALLETS[4]!;

/** A genuinely-signed one-vote ballot for `bizCriteria()` at block 10 (bucket 0, never expired). */
async function signedBundle(wallet: (typeof WALLETS)[number], publicKey: string): Promise<VotesBundle> {
    const votes: Vote[] = [{ community: { publicKey }, vote: 1 }];
    const cid = await criteriaCid(bizCriteria());
    const typedData = ballotTypedData({ criteriaCid: cid.bytes, chainId: BIZ_CHAIN_ID, votes, blockNumber: 10 });
    const signature = await wallet.signTypedData(typedData);
    return { address: wallet.address, votes, blockNumber: 10, signature: { signature, type: EIP712_SIGNATURE_TYPE } };
}

/**
 * A stub chain whose gate read answers `balanceOf(lowercased wallet)`. No `multicall` and no
 * `chain` property, so the rule's `evaluateMany` takes the per-wallet fallback and the read
 * coalescer leaves the client unwrapped — every deferred gate read hits `balanceOf` directly.
 * Head block 43200 ⇒ current bucket 1, so the block-10 (bucket 0) ballots are live (expiry 30).
 */
function stubChains(balanceOf: (wallet: string) => bigint): ChainClientFactory {
    const client = {
        getBlockNumber: async () => 43_200n,
        getBlock: async () => ({ hash: `0x${"11".repeat(32)}` }),
        readContract: async ({ args }: { args?: readonly unknown[] }) => balanceOf(String(args?.[0] ?? "").toLowerCase())
    };
    return () => client as unknown as ChainClient;
}

const totalWeight = (tally: ContestTally): bigint => tally.ranking.reduce((sum, row) => sum + row.weight, 0n);
const weightOf = (tally: ContestTally, publicKey: string): bigint | undefined =>
    tally.ranking.find((row) => row.community.publicKey === publicKey)?.weight;

let cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
    for (const cleanup of cleanups.reverse()) {
        await cleanup().catch(() => {}); // a node stopped mid-test stops again harmlessly
    }
    cleanups = [];
});

/** The origin seeder: a harness node already holding all five genuinely-signed bundles. */
async function originSeeder(topic: string) {
    const a = await makeVoteNode(topic);
    cleanups.push(() => a.stop());
    for (const [index, wallet] of WALLETS.entries()) {
        await a.admitBundle(await signedBundle(wallet, index < 4 ? KEY_A : KEY_B));
    }
    return a;
}

/** A REAL `PubsubVoter` on a bare host node — the full production joiner/seeder path. */
async function realVoterNode(topic: string, balanceOf: (wallet: string) => bigint) {
    const { libp2p, helia } = await makeBareNode(topic);
    const voter = new PubsubVoter({ dataPath: false, helia, chains: stubChains(balanceOf) });
    cleanups.push(async () => {
        await voter.stop();
        await helia.stop();
    });
    const contest: Contest = await voter.createContest({ criteria: bizCriteria() });
    return { libp2p, contest };
}

describe("three-node relay (real PubsubVoter seeders)", () => {
    it(
        "a second seeder cold-joins five votes, verifies them, and re-serves them alone to a third joiner",
        async () => {
            const topic = await topicFor(bizCriteria());
            const a = await originSeeder(topic);

            // B: a real voter, connected only to A. Its cold start pulls A's root record over
            // libp2p fetch, chases the checkpoint over bitswap, admits on the offline checks, and
            // settles every deferred gate read (stub: all five wallets hold the Pass).
            const b = await realVoterNode(topic, () => 1n);
            expect(b.contest.topic).toBe(topic); // the voter derived the same topic A serves on
            await b.libp2p.dial(a.libp2p.getMultiaddrs());
            await b.contest.update();
            await waitFor(
                async () => {
                    const tally = await b.contest.getTally();
                    return totalWeight(tally) === 5n && tally.ranking.every((row) => row.chainVerified);
                },
                45_000,
                "B to pull A's checkpoint and settle all five gate reads"
            );

            // Remove the origin: from here on, B is the only node holding these votes.
            await a.stop();

            // C: a fresh real voter, connected only to B. Everything it tallies came from B's
            // re-served checkpoint — the fetch responder B registered on join, over B's blocks.
            const c = await realVoterNode(topic, () => 1n);
            await c.libp2p.dial(b.libp2p.getMultiaddrs());
            await c.contest.update();
            await waitFor(
                async () => {
                    const tally = await c.contest.getTally();
                    return totalWeight(tally) === 5n && tally.ranking.every((row) => row.chainVerified);
                },
                45_000,
                "C to pull B's re-served checkpoint and settle"
            );

            const tally = await c.contest.getTally();
            expect(weightOf(tally, KEY_A)).toBe(4n);
            expect(weightOf(tally, KEY_B)).toBe(1n); // the odd wallet's vote survived both hops
        },
        120_000
    );

    it(
        "a vote failing the relay seeder's chain gate is evicted there and never reaches the third joiner",
        async () => {
            const topic = await topicFor(bizCriteria());
            const a = await originSeeder(topic);

            // B's chain says the odd wallet holds no Pass: the background verifier confirms the
            // other four and evicts the fifth, leaving KEY_B's row out of B's verified view.
            const oddAddress = ODD_WALLET.address.toLowerCase();
            const b = await realVoterNode(topic, (wallet) => (wallet === oddAddress ? 0n : 1n));
            await b.libp2p.dial(a.libp2p.getMultiaddrs());
            await b.contest.update();
            await waitFor(
                async () => {
                    const tally = await b.contest.getTally();
                    return (
                        tally.ranking.length === 1 &&
                        tally.ranking[0]!.community.publicKey === KEY_A &&
                        tally.ranking[0]!.weight === 4n &&
                        tally.ranking[0]!.chainVerified
                    );
                },
                45_000,
                "B to verify four votes and evict the gate-failing fifth"
            );

            await a.stop();

            // C is deliberately permissive (every wallet eligible): if the odd wallet's vote were
            // anywhere in what B serves, C would count it. Its absence proves B withheld it.
            const c = await realVoterNode(topic, () => 1n);
            await c.libp2p.dial(b.libp2p.getMultiaddrs());
            await c.contest.update();
            await waitFor(
                async () => {
                    const tally = await c.contest.getTally();
                    return totalWeight(tally) === 4n && tally.ranking.every((row) => row.chainVerified);
                },
                45_000,
                "C to pull B's four-vote checkpoint and settle"
            );

            const tally = await c.contest.getTally();
            expect(tally.ranking).toHaveLength(1);
            expect(tally.ranking[0]!.community.publicKey).toBe(KEY_A);
            expect(tally.ranking[0]!.weight).toBe(4n);
            expect(weightOf(tally, KEY_B)).toBeUndefined();
        },
        120_000
    );
});
