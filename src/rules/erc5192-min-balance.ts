import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, getAddress } from "viem";
import { z } from "zod";
import { ChainTickerSchema } from "../schema/common.js";
import { balanceOf, balancesOfBatched, canBatch, scoreOf } from "./nft-balance.js";
import type { ChainReadContext, Rule, RuleResult } from "./types.js";

/**
 * Hold at least `min` of a **soulbound** ERC-721 (the 5chan Pass). The v1 gate.
 *
 * Same `balanceOf` scoring as `erc721-min-balance` — the wallet's holding at the bucket block
 * if it meets `min`, else `0n` — plus one assertion at the SAME pinned block: the contract must
 * declare ERC-5192 (`supportsInterface(0xb45a3c0e)`). A contract that does not declare it scores
 * `0n` for every wallet, so the contest admits nobody rather than gating on a transferable asset.
 *
 * **Why the assertion is the whole point.** The gate bounds Sybils only if the gating asset
 * cannot move (DESIGN.md "Does one Pass mean one vote?"): every bundle is verified at its OWN
 * pinned block, stays live for `voteExpiryBuckets`, and the winner set is LWW-keyed per wallet —
 * so one transferable token walked A → B → C inside a single expiry window backs three
 * concurrent live votes, each read true at its own block and none collapsed by LWW. Nothing in
 * the verify pipeline can see that: every ballot is individually correct. Requiring the asset to
 * be non-transferable AND to say so on-chain closes it with no wire change, no extra archive
 * depth, and no second read per wallet. Pinned by `src/crdt/amplification.test.ts`.
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
    chain: ChainTickerSchema,
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
 * One `supportsInterface(0xb45a3c0e)` at the sampled block. Identical calldata at the same block
 * for every wallet in a batch, so the voter's read coalescer (src/chain/coalescer.ts) dedupes a
 * whole checkpoint's worth of wallets — and every parallel contest on the same contract — onto a
 * single extra read, folded into the same `aggregate3` as the balances.
 */
async function declaresErc5192(contract: `0x${string}`, ctx: ChainReadContext): Promise<boolean> {
    try {
        return await ctx.chain.readContract({
            address: contract,
            abi: erc165Abi,
            functionName: "supportsInterface",
            args: [ERC5192_INTERFACE_ID],
            blockNumber: BigInt(ctx.blockNumber)
        });
    } catch (err) {
        if (isContractRefusal(err)) return false;
        throw err;
    }
}

export const erc5192MinBalance: Rule<Erc5192MinBalanceOptions> = {
    type: "erc5192-min-balance",
    optionsSchema: Erc5192MinBalanceOptionsSchema,
    async evaluate({ options, walletAddress, ctx }) {
        const contract = getAddress(options.contract);
        // Issued together, not sequenced: same block, so the coalescer folds both into one
        // aggregate3 — the lock assertion costs no extra round trip.
        const [declares, balance] = await Promise.all([declaresErc5192(contract, ctx), balanceOf(contract, walletAddress, ctx)]);
        return { score: declares ? scoreOf(balance, options.min) : 0n };
    },
    async evaluateMany({ options, walletAddresses, ctx }) {
        const contract = getAddress(options.contract);
        // ONE lock assertion for the whole batch (hoisted out of the per-wallet reads), in
        // parallel with the balances so both share the coalescing window.
        const [declares, balances] = await Promise.all([
            declaresErc5192(contract, ctx),
            canBatch(ctx)
                ? balancesOfBatched(contract, walletAddresses, ctx)
                : Promise.all(walletAddresses.map((wallet) => balanceOf(contract, wallet, ctx)))
        ]);
        if (!declares) return walletAddresses.map((): RuleResult => ({ score: 0n }));
        return balances.map((balance): RuleResult => ({ score: scoreOf(balance, options.min) }));
    }
};
