import { getAddress } from "viem";
import { z } from "zod";
import { ChainTickerSchema } from "../schema/common.js";
import { balanceOf, balancesOfBatched, canBatch, scoreOf } from "./nft-balance.js";
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
    chain: ChainTickerSchema,
    contract: z.string(),
    min: z.number().int().positive().default(1)
});

export type Erc721MinBalanceOptions = z.infer<typeof Erc721MinBalanceOptionsSchema>;

export const erc721MinBalance: Rule<Erc721MinBalanceOptions> = {
    type: "erc721-min-balance",
    optionsSchema: Erc721MinBalanceOptionsSchema,
    async evaluate({ options, walletAddress, ctx }) {
        const balance = await balanceOf(getAddress(options.contract), walletAddress, ctx);
        return { score: scoreOf(balance, options.min) };
    },
    async evaluateMany({ options, walletAddresses, ctx }) {
        const contract = getAddress(options.contract);
        // Multicall3 `aggregate3` batching (see nft-balance.ts for the chunking policy) — the
        // path the background chain verifier rides on a cold join. A client that cannot batch
        // takes the per-wallet fallback.
        if (!canBatch(ctx)) return Promise.all(walletAddresses.map((wallet) => this.evaluate({ options, walletAddress: wallet, ctx })));
        const balances = await balancesOfBatched(contract, walletAddresses, ctx);
        return balances.map((balance): RuleResult => ({ score: scoreOf(balance, options.min) }));
    }
};
