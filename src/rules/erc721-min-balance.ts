import { getAddress } from "viem";
import { z } from "zod";
import { balanceOf, balancesOfBatched, canBatch, scoreOf, shortfallError } from "./nft-balance.js";
import type { Rule, RuleResult } from "./types.js";

/**
 * Hold at least `min` of a **plain** ERC-721.
 *
 * **NOT registered** in `builtinRegistry` — a criteria naming it recuses via `UnknownRuleError`.
 * It reads a bare `balanceOf` and asserts nothing about transferability, so it gates on an asset
 * that can move: one token walked A → B → C inside a single expiry window backs three concurrent
 * live votes, since every bundle is verified at its own pinned block and the winner set is
 * LWW-keyed per wallet (DESIGN.md "Does one Pass mean one vote?"; pinned by
 * `src/crdt/amplification.test.ts`). The v1 gate is `erc5192-min-balance`, which is this rule plus
 * a `supportsInterface(0xb45a3c0e)` assertion that the contract declares its tokens locked.
 *
 * Kept in the tree, exported, and unit-tested: a host that genuinely wants a transferable gate
 * can still register it through the `rules` override map. The library stops blessing the
 * configuration; it does not forbid it. See registry.ts and issue #27.
 *
 * Score = the wallet's holding at the bucket block if it meets `min`, else 0. In the rule slot,
 * `> 0` admits the wallet; in the weight slot it weights by the number of tokens held. The body
 * reads its own `balanceOf` via the injected viem client (no libp2p/helia import), unit-testable
 * against a stubbed client.
 */

export const Erc721MinBalanceOptionsSchema = z.object({
    type: z.literal("erc721-min-balance"),
    contract: z.string(),
    min: z.number().int().positive().default(1)
});

export type Erc721MinBalanceOptions = z.infer<typeof Erc721MinBalanceOptionsSchema>;

/**
 * One pinned-block balance as a {@link RuleResult}. `penalize` is left at its default `true`:
 * this rule reads the block the bundle itself names, so every honest verifier computes the same
 * answer forever and a failure IS attributable to whoever sent it.
 */
function pinnedResult(balance: bigint, min: number, contract: string): RuleResult {
    const score = scoreOf(balance, min);
    return score > 0n ? { success: true, score } : { success: false, error: shortfallError(balance, min, contract) };
}

export const erc721MinBalance: Rule<Erc721MinBalanceOptions> = {
    type: "erc721-min-balance",
    optionsSchema: Erc721MinBalanceOptionsSchema,
    // Scores at the bundle's OWN pinned block, and deliberately not at the head: a transferable
    // balance can go DOWN, so a vote admitted today would silently become invalid the moment the
    // token moved, and whether it still counted would depend on when each peer last looked. A
    // pinned read is identical on every verifier forever, which is what leaves `penalize` at its
    // default — a `0n` here IS attributable to the sender. That difference is a second,
    // independent reason this rule stays out of `builtinRegistry`, on top of the Sybil
    // amplification described in registry.ts.
    async evaluate({ options, wallet, ctx }) {
        const { balance } = await balanceOf({
            contract: getAddress(options.contract),
            wallet: wallet.address,
            block: wallet.sampleBlock,
            ctx
        });
        return pinnedResult(balance, options.min, getAddress(options.contract));
    },
    async evaluateMany({ options, wallets, ctx }) {
        const contract = getAddress(options.contract);
        // Grouped by sample block, because a batch is no longer guaranteed to share one: the
        // pipeline hands over whatever is pending and each rule groups the way it reads. Within
        // a group it is multicall3 `aggregate3` batching (chunking policy in nft-balance.ts) —
        // the path the background chain verifier rides on a cold join; a client that cannot
        // batch takes the per-wallet fallback.
        const results = new Array<RuleResult | undefined>(wallets.length);
        const byBlock = new Map<number, number[]>();
        wallets.forEach((wallet, i) => byBlock.set(wallet.sampleBlock, [...(byBlock.get(wallet.sampleBlock) ?? []), i]));
        await Promise.all(
            [...byBlock].map(async ([block, indexes]) => {
                const group = indexes.map((i) => wallets[i]!.address);
                const { balances } = canBatch({ ctx }).batchable
                    ? await balancesOfBatched({ contract, wallets: group, block, ctx })
                    : {
                          balances: await Promise.all(
                              group.map(async (wallet) => (await balanceOf({ contract, wallet, block, ctx })).balance)
                          )
                      };
                indexes.forEach((at, i) => {
                    results[at] = pinnedResult(balances[i]!, options.min, contract);
                });
            })
        );
        return { results: results.map((result) => result!) };
    }
};
