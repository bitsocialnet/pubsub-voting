import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, getAddress } from "viem";
import { z } from "zod";
import { balanceOf, balancesOfBatched, canBatch, scoreOf, shortfallError } from "./nft-balance.js";
import type { ChainReadContext, Rule, RuleResult } from "./types.js";

/**
 * Hold at least `min` of a **soulbound** ERC-721 (the 5chan Pass). The v1 gate.
 *
 * Same `balanceOf` scoring as `erc721-min-balance` — the wallet's holding at the sampled block
 * if it meets `min`, else `0n` — plus one assertion at the SAME block: the contract must
 * declare ERC-5192 (`supportsInterface(0xb45a3c0e)`). A contract that does not declare it scores
 * `0n` for every wallet, so the contest admits nobody rather than gating on a transferable asset.
 *
 * Unlike the other rules in the tree, this one scores at the verifier's CURRENT head rather than
 * at the bundle's bucket boundary, falling back to that boundary only when the head read refuses
 * — so a freshly-acquired Pass counts immediately. See `evaluateMany` for why both legs exist,
 * and rules/types.ts for what the pipeline does with `penalize: false`.
 *
 * **Why the assertion is the whole point.** The gate bounds Sybils only if the gating asset
 * cannot move (DESIGN.md "Does one Pass mean one vote?"). A vote is verified ONCE, when it is
 * merged, and then stays live for `voteExpiryBuckets` in a winner set LWW-keyed per wallet — so
 * one transferable token walked A → B → C inside a single expiry window backs three concurrent
 * live votes, each read true when it was checked and none collapsed by LWW. Nothing in the
 * verify pipeline can see that: every ballot is individually correct. (Reading pinned blocks,
 * the three reads land at three different historical blocks; reading the head, at three
 * different verification times. Transferability defeats both.) Requiring the asset to be
 * non-transferable AND to say so on-chain closes it with no wire change — and it is the same
 * property that makes scoring at the head sound at all. Pinned by
 * `src/crdt/amplification.test.ts`.
 *
 * **What the assertion does and does not prove.** `supportsInterface(0xb45a3c0e)` asserts the
 * contract *reports* lock state — ERC-5192's only function is `locked(uint256)`. ERC-5192
 * permits unlockable tokens (it defines an `Unlocked` event), so this is not proof that a given
 * token is locked; it refuses contracts that do not even claim the property. Per-token proof
 * would need `locked(tokenId)`, i.e. token ids in the signed bundle — a re-pin of the frozen
 * EIP-712 vector. The deployed gate closes the gap by being permanently locked with a constant
 * `locked() == true`.
 *
 * ERC-5192 mandates ERC-721 conformance, so `balanceOf` stays valid. In the rule slot `> 0`
 * admits the wallet; in the weight slot it weights by the number of Passes held. The body reads
 * through the injected viem client (no libp2p/helia import), unit-testable against a stub.
 */

/** ERC-5192's interface id (its only function is `locked(uint256)`). */
export const ERC5192_INTERFACE_ID = "0xb45a3c0e" as const;

const erc165Abi = [
    {
        type: "function",
        name: "supportsInterface",
        stateMutability: "view",
        inputs: [{ name: "interfaceId", type: "bytes4" }],
        outputs: [{ type: "bool" }]
    }
] as const;

export const Erc5192MinBalanceOptionsSchema = z.object({
    type: z.literal("erc5192-min-balance"),
    contract: z.string(),
    min: z.number().int().positive().default(1)
});

export type Erc5192MinBalanceOptions = z.infer<typeof Erc5192MinBalanceOptionsSchema>;

/**
 * Does the read prove "this contract does not answer `supportsInterface`", as opposed to "the
 * gateway failed"? A contract with no ERC-165 at all reverts (or returns no data) — that is a
 * chain FACT and means the gate must refuse, permanently and identically for every verifier. An
 * RPC outage is not a fact about the chain, and DESIGN.md keeps a throwing read infra-class
 * everywhere (gossip `ignore`, background retry) precisely so a flaky gateway never turns into a
 * consensus `reject` that scores honest relayers down. So only viem's revert/zero-data errors
 * map to "does not declare"; everything else (transport, timeout, rate limit) rethrows.
 */
function isContractRefusal(err: unknown): boolean {
    if (!(err instanceof BaseError)) return false;
    return err.walk((cause) => cause instanceof ContractFunctionRevertedError || cause instanceof ContractFunctionZeroDataError) !== null;
}

/**
 * How coarsely a head-scored read is memoized, in blocks (~1 minute on Base's 2 s blocks).
 *
 * The read itself is at the freshest head this verifier has — that is the whole point, a Pass
 * acquired seconds ago must count now. Only the cache EPOCH is quantized, and it has to be:
 * an epoch that moved every block would never hit, and the memo is what stops an ineligible
 * wallet from costing every peer one chain read per fresh-signed bundle (see rules/cache.ts).
 *
 * The number to reason about is what a stale NEGATIVE costs: a wallet already checked and failed
 * stays failed on this verifier until the epoch rolls, even if it acquires the Pass in between —
 * so it is deliberately short. A positive is unaffected in practice (a holding that cannot move
 * cannot stop being true), and re-reading one when the epoch rolls is a wasted read, never a
 * wrong answer. Local resource policy, NOT consensus: two peers may quantize differently and
 * still agree on every verdict, which is why it lives here and not in the criteria.
 */
const HEAD_EPOCH_BLOCKS = 30;

/** Cache-key prefixes: head-scored entries expire with the head, pinned ones never do. */
const HEAD_PREFIX = "head/";
const PINNED_PREFIX = "pin/";

/**
 * The voter-facing wording for every way this rule reaches `0n` ({@link RuleResult.error}).
 *
 * Deliberately generic and self-contained: the rule knows a contract address and a threshold, not
 * that the deployment calls this token a "5chan Pass". A client renders these verbatim, which is
 * the point — it then needs to know nothing about which block the rule read or what `min` is.
 */
const undeclaredError = (contract: string): string =>
    `the gate contract ${contract} does not declare ERC-5192, so it gates nothing and no wallet can qualify ` +
    `— this contest's criteria name a contract that is not soulbound`;

/** One `supportsInterface(0xb45a3c0e)` at `block`. Revert/zero-data ⇒ "does not declare". */
async function declaresErc5192(args: { contract: `0x${string}`; block: number; ctx: ChainReadContext }): Promise<{ declares: boolean }> {
    try {
        const declares = await args.ctx.chain.readContract({
            address: args.contract,
            abi: erc165Abi,
            functionName: "supportsInterface",
            args: [ERC5192_INTERFACE_ID],
            blockNumber: BigInt(args.block)
        });
        return { declares };
    } catch (err) {
        if (isContractRefusal(err)) return { declares: false };
        throw err;
    }
}

/**
 * Score every wallet at ONE block, memoized under one epoch — the whole rule body, run once per
 * leg (see `evaluateMany`).
 *
 * Two memos, both through the rule's cache: the ERC-5192 declaration, keyed per CONTRACT (it is
 * not a per-wallet fact, so a whole checkpoint's wallets share one probe — a key shape the old
 * per-wallet gate cache could not express at all), and each wallet's raw balance. Balances are
 * cached rather than scores so a change to `min` cannot be served a stale verdict; the batched
 * read behind the misses is one multicall3 `aggregate3` per 200 wallets.
 */
async function scoreAt(args: {
    contract: `0x${string}`;
    min: number;
    wallets: string[];
    block: number;
    epoch: number;
    prefix: string;
    ctx: ChainReadContext;
}): Promise<{ scores: bigint[]; errors: Array<string | undefined> }> {
    const { contract, min, wallets, block, epoch, prefix, ctx } = args;
    if (wallets.length === 0) return { scores: [], errors: [] };

    const [declared] = (
        await ctx.cache.memoMany({
            keys: [`${prefix}lock/${contract.toLowerCase()}`],
            epoch,
            read: async () => {
                const { declares } = await declaresErc5192({ contract, block, ctx });
                return { values: [declares ? "1" : "0"] };
            }
        })
    ).values;
    // A contract that does not claim its tokens are locked gates nothing: admit nobody rather
    // than gate on something transferable (see the rule doc above).
    if (declared !== "1") return { scores: wallets.map(() => 0n), errors: wallets.map(() => undeclaredError(contract)) };

    const { values } = await ctx.cache.memoMany({
        keys: wallets.map((wallet) => `${prefix}bal/${wallet.toLowerCase()}`),
        epoch,
        read: async ({ keys }) => {
            const missing = keys.map((key) => key.slice(key.lastIndexOf("/") + 1));
            const { balances } = canBatch({ ctx }).batchable
                ? await balancesOfBatched({ contract, wallets: missing, block, ctx })
                : {
                      balances: await Promise.all(
                          missing.map(async (wallet) => (await balanceOf({ contract, wallet, block, ctx })).balance)
                      )
                  };
            return { values: balances.map((balance) => balance.toString()) };
        }
    });
    const scores = values.map((balance) => scoreOf(BigInt(balance), min));
    return {
        scores,
        errors: scores.map((score, i) => (score > 0n ? undefined : shortfallError(BigInt(values[i]!), min, contract)))
    };
}

/** `{ success: true, score }` when the leg admitted, else the failing branch with its reason. */
function resultOf(score: bigint, error: string | undefined): RuleResult {
    // `penalize: false` on every failure: neither leg makes one attributable. The peer that
    // forwarded a vote verified it against ITS head, and any peer ahead of us may legitimately
    // see an acquisition we have not — and with burning possible, holding at neither block does
    // not even prove the wallet never held.
    return score > 0n ? { success: true, score } : { success: false, error: error ?? UNKNOWN_ERROR, penalize: false };
}

/** Unreachable: `scoreAt` pairs every non-positive score with a reason. Kept total, not thrown. */
const UNKNOWN_ERROR = "this wallet does not qualify for this contest's gate";

export const erc5192MinBalance: Rule<Erc5192MinBalanceOptions> = {
    type: "erc5192-min-balance",
    optionsSchema: Erc5192MinBalanceOptionsSchema,

    // One wallet is the batch of one: the two legs, the two epochs and the memos are identical,
    // so there is one body. Called through `erc5192MinBalance.evaluateMany` rather than `this`,
    // which a destructured or re-exported rule object would not carry (issue #29).
    async evaluate({ options, wallet, ctx }) {
        const { results } = await erc5192MinBalance.evaluateMany!({ options, wallets: [wallet], ctx });
        return results[0]!;
    },

    /**
     * Score at the HEAD first, falling back to each wallet's own pinned block.
     *
     * **Head first** is what lets a wallet vote in the block it acquires the Pass. Scoring only
     * at the bundle's bucket boundary — the block a ballot names, floored — meant waiting up to
     * a full bucket (an hour on 5chan's live manifest) before a fresh holding was visible, which
     * was never a chain requirement: a read pinned at block N already sees a mint that happened
     * in N. It is sound because a soulbound holding cannot move, so a peer whose head lags can
     * only be LATE to admit a vote, never in lasting disagreement about it.
     *
     * **The pinned fallback** covers what that reasoning does not: ERC-5192 requires transfers to
     * revert while locked, but says nothing about BURNING (a burn does not go through
     * `transferFrom`), so a compliant Pass may be burnable and this rule cannot check otherwise.
     * Without the fallback, a burn would make a peer that verified earlier keep a vote its
     * checkpoint still serves while a cold joiner rejects it — divergence for up to the expiry
     * window — and would hand whoever can burn a retroactive veto over votes already cast.
     * Reading the wallet's own `sampleBlock` when the head says `0n` restores agreement for any
     * vote that was legitimately held when it was cast. It admits nothing the pinned-only v1 gate
     * did not, so it opens no new amplification; a burn-and-remint to a fresh wallet is a
     * transfer by another name and remains a property of the deployment, not something any read
     * can close. Its cost is that a verifier still needs archive depth for that leg.
     *
     * **Two epochs**, which is why this caching lives in the rule: the head leg expires with the
     * head (a stale `0n` must not outlive {@link HEAD_EPOCH_BLOCKS}), while the pinned leg is a
     * historical read that is true forever and is keyed by the block itself.
     *
     * **`penalize: false`** on every failure: neither leg makes one attributable. The peer that
     * forwarded a vote verified it against ITS head, and any peer ahead of us may legitimately
     * see an acquisition we have not — and with burning possible, not holding at either block
     * does not even prove the wallet never held.
     *
     * **Three distinct failures**, each with its own {@link RuleResult.error}: the contract does
     * not declare ERC-5192 (so it gates nothing and no wallet can ever qualify), the wallet holds
     * none, or it holds some but fewer than `min`. The fallback leg has the last word on a
     * wallet's score, so it owns that wallet's reason too.
     */
    async evaluateMany({ options, wallets, ctx }) {
        const contract = getAddress(options.contract);
        const { block: head } = await ctx.head();
        const epoch = Math.floor(head / HEAD_EPOCH_BLOCKS) * HEAD_EPOCH_BLOCKS;
        // Everything behind the current window is unreachable — nothing will look it up again.
        // Scoped to the head keys, so the permanently-valid pinned entries are left alone.
        ctx.cache.purgeBelow({ epoch, keyPrefix: HEAD_PREFIX });

        const { scores, errors } = await scoreAt({
            contract,
            min: options.min,
            wallets: wallets.map((wallet) => wallet.address),
            block: head,
            epoch,
            prefix: HEAD_PREFIX,
            ctx
        });

        // Only wallets the head leg refused reach the fallback, so a holder costs one read path.
        // Grouped by sample block: bundles from different buckets name different pinned blocks.
        const byBlock = new Map<number, number[]>();
        scores.forEach((score, i) => {
            if (score > 0n) return;
            const block = wallets[i]!.sampleBlock;
            byBlock.set(block, [...(byBlock.get(block) ?? []), i]);
        });
        await Promise.all(
            [...byBlock].map(async ([block, indexes]) => {
                const fallback = await scoreAt({
                    contract,
                    min: options.min,
                    wallets: indexes.map((i) => wallets[i]!.address),
                    block,
                    epoch: block,
                    prefix: PINNED_PREFIX,
                    ctx
                });
                indexes.forEach((at, i) => {
                    scores[at] = fallback.scores[i]!;
                    // The fallback leg had the last word on the score, so it owns the reason too:
                    // a wallet that holds none at the head but held some at its ballot's block is
                    // admitted, and one that holds none at either gets the pinned leg's wording.
                    errors[at] = fallback.errors[i];
                });
            })
        );

        return { results: scores.map((score, i) => resultOf(score, errors[i])) };
    }
};
