import type { z } from "zod";
import type { ChainClient } from "../chain/types.js";
import type { RuleCache } from "./cache.js";

/**
 * Rule interface, design + leaves implemented.
 *
 * A rule turns a criteria `{ type, ...options }` reference into a non-negative
 * score for one wallet, at whichever block the rule itself decides to read — the pinned block
 * the bundle names ({@link RuleWallet.sampleBlock}) or this verifier's current head
 * ({@link ChainReadContext.head}). There is a SINGLE kind
 * (mirroring the flat pkc-js challenge registry: `Record<string, rule>`, user
 * entries shadow builtins). The criteria still has two slots that draw from this one
 * registry:
 *
 *   - rule slot:   the result is a GATE. `success: true` admits the wallet, `success: false`
 *                  rejects it and must say why ({@link RuleResult.error}).
 *   - weight slot: a successful result's `score` is the vote's MAGNITUDE; a failure is zero
 *                  weight.
 *
 * One return shape covers both roles: a rule that needs a threshold (min Passes, min balance)
 * bakes it in by failing when the wallet falls short, so the gate slot needs no separate kind.
 */

/**
 * The result of one evaluation: a wallet either qualifies with a score, or it does not and the
 * rule says why.
 *
 * Modelled on pkc-js's `ChallengeResult` (community/schema.ts) — a `success` discriminant, with
 * `error` REQUIRED on the failing branch. Making it required is the whole point: only the rule
 * knows why a wallet fell short, and if that reason is optional it will simply be omitted, which
 * leaves the pipeline with one undifferentiated "score is 0n" and forces every UI to re-derive
 * the rule's thresholds and block choice to say anything useful. That duplication is exactly what
 * {@link ChainReadContext} and {@link RuleCache} exist to prevent everywhere else, and it is what
 * broke when the gate moved from a pinned block to the head: a client's hand-rolled explanation
 * kept telling voters to wait for a window that no longer gated anything.
 *
 *   - rule slot:   `success: true` admits the wallet; `success: false` rejects it.
 *   - weight slot: `success: true` carries the vote's MAGNITUDE; `success: false` is zero weight.
 *
 * Final vote value = gate `success: false` ? `0n` : weight `success` ? weight `score` : `0n`.
 *
 * `score` MUST be `> 0n` on the success branch — "qualifies, with no weight" is not a state this
 * models, and the pipeline treats a non-positive success score as a rule bug and refuses the
 * wallet rather than silently admitting a zero-weight vote.
 */
export type RuleResult =
    | {
          success: true;
          /** The wallet's magnitude. MUST be `> 0n`. */
          score: bigint;
      }
    | {
          success: false;
          /**
           * Why this wallet does not qualify, phrased for the person who cast (or is about to
           * cast) the vote. Surfaces on `VerifyFail.reason`, on `VoteEvictedError.verdict`, and
           * from `Contest.checkEligibility`, so a client renders it verbatim and stays correct
           * across rule changes it knows nothing about.
           *
           * Write it as a statement about the wallet, not about the library: "this wallet holds
           * none of the gate token", not "gate rule returned 0". Do not cite block numbers unless
           * they are actionable — a voter can do nothing with a sample block.
           */
          error: string;
          /**
           * May this failure be blamed on the peer that sent the vote? Default `true`.
           *
           * The pipeline has two decisions the rule cannot make for it — whether the gossip
           * forward-gate `reject`s the message (penalizing the delivering peer through
           * gossipsub's invalid-message score, eventually pruning and graylisting it) or merely
           * `ignore`s it, and whether the background verifier evicts the bundle at once or holds
           * it for a grace window. Both hinge on one thing only the rule knows: is this failure
           * attributable?
           *
           * `true` (the default) says every honest verifier necessarily computes this same
           * failure — true of a read pinned to a historical block, since the block is named by
           * the bundle and the chain's history does not move. The bundle is dropped, the sender
           * penalized, the verdict cached as terminal.
           *
           * `false` says an honest peer could legitimately disagree, so nobody may be blamed. The
           * bundle is still dropped, but `ignore`-class — no penalty, verdict uncached, and the
           * background verifier re-examines it for a grace window before giving up. This is what
           * a rule scoring the chain head must return: the peer that forwarded the vote verified
           * it against ITS head, and any peer ahead of us can legitimately see an acquisition we
           * have not. Penalizing there punishes honest relayers for being current — and does so
           * exactly when a wallet has just acquired the gate asset, which is when peer heads
           * straddle.
           */
          penalize?: boolean;
      };

/** Everything a rule needs to read chain state and remember what it read. */
export interface ChainReadContext {
    /**
     * The viem `PublicClient` for the rule's `options.chain`. Use the full viem read surface
     * directly (`readContract`, `getBalance`, ...). ALWAYS pin each call to an explicit
     * `blockNumber: BigInt(...)`: the read coalescer (src/chain/coalescer.ts) only folds reads
     * carrying an explicit block into one multicall3, so a `blockTag` or an omitted block
     * silently drops out of batching and back to one HTTP round trip per read.
     */
    chain: ChainClient;
    /**
     * This verifier's current head on {@link chain}. A rule scoring historical state never calls
     * it and never pays for it; a rule scoring "now" resolves it ONCE per evaluation and pins
     * its reads to that number, so a batch still lands in a single multicall.
     *
     * Shared and coalesced by the voter, because the gate runs on the verify path — one call per
     * incoming vote — so an unshared head read would be one `eth_blockNumber` per bundle per
     * contest.
     */
    head: () => Promise<{ block: number }>;
    /**
     * This rule's memo (see rules/cache.ts). A chain-reading rule MUST compute through it: it is
     * what turns "one chain read per unique bundle" into "one read per key per epoch", which is
     * the bound that stops an ineligible wallet from making every peer on the topic pay an RPC
     * round trip per fresh-signed bundle.
     */
    cache: RuleCache;
}

/** One wallet to score, and the pinned block the bundle it came from names. */
export interface RuleWallet {
    /** The voting wallet (the address recovered from the bundle's signature). */
    address: string;
    /**
     * The bundle's bucketized sample block, already floored to the bucket boundary — the
     * historical block every verifier agrees this ballot names. A rule scoring pinned state
     * reads here (and its answer is then identical on every verifier, forever); a rule scoring
     * current state ignores it and uses {@link ChainReadContext.head} instead. It is NOT a
     * claim about when the ballot was signed: it is floored to the bucket, so it can trail the
     * actual signing moment by up to `blocksPerBucket`.
     */
    sampleBlock: number;
}

/**
 * The one rule kind. `O` is the validated options type (from its `optionsSchema`).
 * `evaluate` returns a {@link RuleResult}: either `{ success: true, score }` with `score > 0n`,
 * or `{ success: false, error }` — "does not qualify", with the reason the voter is shown.
 */
export interface Rule<O = unknown> {
    readonly type: string;
    readonly optionsSchema: z.ZodType<O>;
    evaluate(args: { options: O; wallet: RuleWallet; ctx: ChainReadContext }): Promise<RuleResult>;
    /**
     * Optional batched form of {@link evaluate}: score many wallets in as few RPC round trips as
     * the rule can manage (e.g. one multicall3 `aggregate3` for a whole checkpoint's wallets).
     * Returns one result per input wallet, in order. Semantics MUST equal mapping `evaluate` over
     * the wallets — this is a transport optimization, never a different answer. The background
     * chain verifier prefers it when present and falls back to per-wallet `evaluate` otherwise.
     *
     * The wallets are NOT guaranteed to share a `sampleBlock`: the pipeline no longer groups them
     * (it cannot, since which block a rule reads at is the rule's own business), so a batch is
     * whatever was pending. A rule scoring the head reads once for the whole batch; a rule
     * scoring pinned state groups by `sampleBlock` itself.
     */
    evaluateMany?(args: { options: O; wallets: RuleWallet[]; ctx: ChainReadContext }): Promise<{ results: RuleResult[] }>;
}

/**
 * The registry: a flat `type -> rule` map. Built-ins are provided by this
 * library; hosts may pass overrides that shadow built-ins by `type`. Mirrors pkc-js
 * src/runtime/node/community/challenges/index.ts.
 */
export type RuleRegistry = Record<string, Rule>;
