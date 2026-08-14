import { z } from "zod";
import { ChainTickerSchema } from "./common.js";
import { encodeCanonical } from "../encoding/canonical.js";

/**
 * The criteria document.
 *
 * Shipped static in the client bundle and used to derive the pubsub topic:
 *   topic = "bitsocial-votes/" + CID(dag-cbor(criteria))
 *
 * One criteria document describes exactly one contest (one directory slot), so there
 * is one topic per contest. The differing `contestId` value makes each contest's bytes
 * distinct, which forks the topic automatically. A client joins only the contests it
 * cares about, which is what keeps cold start cheap. See DESIGN.md "Criteria document".
 *
 * Because the topic is the CID of the canonical encoding of this object, two peers
 * on the same topic provably ran identical rules. Therefore this object MUST be
 * canonically encodable (no `undefined`, deterministic key order under dag-cbor);
 * a non-canonical change silently changes the topic.
 */

/** Inclusive numeric bounds for a single `vote` value. v1 is { min: 1, max: 1 }. */
export const VoteRangeSchema = z.object({
    min: z.number().int(),
    max: z.number().int()
});

/**
 * A reference to a rule by `type`, plus rule-specific options.
 * Kept loose on purpose: each rule owns and validates its own option schema
 * (see rules/types.ts), so custom rules can be referenced without
 * changing CriteriaSchema. This mirrors pkc-js challenge settings
 * ({ name, options }) where the named challenge validates its own options.
 */
export const RuleRefSchema = z.looseObject({
    type: z.string().min(1)
});

/**
 * The gate: a boolean tree over rule references, deciding who may vote.
 *
 * A leaf wraps one {@link RuleRefSchema}; `all` and `any` compose leaves into conjunction and
 * disjunction, so a contest can require "holds the Pass AND is not on the deny list", or "holds
 * the Pass OR is a moderator", without either rule knowing the other exists. Composition is the
 * document's business, never a rule's: a rule still answers exactly one question about one wallet
 * (see rules/types.ts), and `rules/gate.ts` folds the answers.
 *
 * The leaf is WRAPPED (`{ rule: { type, ... } }`) rather than bare because {@link RuleRefSchema}
 * is loose by design — a custom rule may carry an option named `all` or `any`, which would make a
 * bare leaf structurally ambiguous with a branch exactly when someone writes such a rule.
 *
 * Canonicity constraints, all of them load-bearing rather than stylistic. The topic is the CID of
 * these bytes, so any document that differs in bytes but not in meaning is a silent topic FORK —
 * two peers running identical rules on two topics, each invisible to the other:
 *   - a branch needs at least TWO children, so `{ all: [X] }` cannot exist alongside `X`;
 *   - a branch may not REPEAT a child (compared by canonical bytes, so two leaves of one rule type
 *     on different options stay distinct requirements) — a repeat says nothing the shorter tree
 *     does not;
 *   - a branch may not nest a branch of its OWN kind: `{ all: [{ all: [A, B] }, C] }` admits,
 *     scores, blames and penalizes exactly as `{ all: [A, B, C] }` does, since min and `some` are
 *     associative, so the nesting carries no meaning and only new bytes;
 *   - depth is capped at {@link MAX_GATE_DEPTH} and leaves at {@link MAX_GATE_LEAVES}, because a
 *     criteria document is attacker-supplied input that every peer parses and evaluates.
 *
 * Child ORDER is deliberately significant rather than normalized away: it is what the lazy forward
 * gate evaluates in, so it decides which rule's chain read is paid first and the order failures are
 * reported. Two orderings are two documents, and an author picks the one that reads best.
 */
export interface GateLeaf {
    rule: RuleRef;
}
export interface GateAll {
    all: GateNode[];
}
export interface GateAny {
    any: GateNode[];
}
export type GateNode = GateLeaf | GateAll | GateAny;

/** Maximum nesting depth of the gate tree (a leaf alone is depth 1). */
export const MAX_GATE_DEPTH = 4;
/** Maximum number of rule references in one gate tree. */
export const MAX_GATE_LEAVES = 8;

const GateNodeSchema: z.ZodType<GateNode> = z.lazy(() =>
    z.union([
        z.strictObject({ rule: RuleRefSchema }),
        z.strictObject({ all: z.array(GateNodeSchema).min(2) }),
        z.strictObject({ any: z.array(GateNodeSchema).min(2) })
    ])
);

/** Depth (a leaf is 1), leaf count, and the redundant spellings, in one walk. */
function gateShape(node: GateNode): { depth: number; leaves: number; redundant: string | undefined } {
    if ("rule" in node) return { depth: 1, leaves: 1, redundant: undefined };
    const kind = "all" in node ? "all" : "any";
    const children = "all" in node ? node.all : node.any;
    let depth = 0;
    let leaves = 0;
    let redundant: string | undefined;
    // Canonical bytes are the identity: two children that encode identically ARE the same
    // requirement, however differently they were written.
    const seen = new Set<string>();
    for (const child of children) {
        const shape = gateShape(child);
        depth = Math.max(depth, shape.depth);
        leaves += shape.leaves;
        redundant ??= shape.redundant;
        if (kind in child) {
            redundant ??= `a \`${kind}\` nested directly inside an \`${kind}\` says nothing its parent does not; inline its children`;
        }
        const bytes = bytesToHex(encodeCanonical(child));
        if (seen.has(bytes)) redundant ??= `a \`${kind}\` repeats one of its children; drop the duplicate`;
        seen.add(bytes);
    }
    return { depth: depth + 1, leaves, redundant };
}

const bytesToHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export const GateSchema = GateNodeSchema.superRefine((node, ctx) => {
    const { depth, leaves, redundant } = gateShape(node);
    if (depth > MAX_GATE_DEPTH) {
        ctx.addIssue({ code: "custom", message: `gate tree is ${depth} levels deep; the maximum is ${MAX_GATE_DEPTH}` });
    }
    if (leaves > MAX_GATE_LEAVES) {
        ctx.addIssue({ code: "custom", message: `gate tree names ${leaves} rules; the maximum is ${MAX_GATE_LEAVES}` });
    }
    // Every redundant spelling is a topic fork waiting to happen: it means the same thing as a
    // shorter tree while encoding to different bytes, so two authors expressing one contest can
    // land on two topics. Same reason a branch may not have a single child.
    if (redundant !== undefined) ctx.addIssue({ code: "custom", message: `gate tree has a redundant spelling: ${redundant}` });
});

/**
 * One chain the contest reads, by ticker. Part of the dependency manifest.
 *
 * Only the `chainId` is here — it is consensus-critical (bound into every EIP-712 ballot
 * domain and defining which chain the rules read). RPC endpoints are deliberately NOT part
 * of the criteria: which gateway a client trusts is client-local transport configuration
 * (`PubsubVoterOptions.chains` maps ticker/chainId to a client), and two honest verifiers
 * reading the same pinned block through different gateways compute identical results. Keeping
 * URLs out means an operator can swap a dead RPC provider without changing the document's
 * bytes — i.e. without forking the topic and orphaning the contest's votes.
 *
 * Strict on purpose: the topic is derived from the PARSED document, so an unknown key must
 * fail loudly here — a plain (stripping) object would silently drop it and derive a different
 * topic than the author's raw document implies. This also makes pre-v1 documents that still
 * carry `rpcUrls` a loud error instead of a silent re-topic.
 */
export const ChainConfigSchema = z.strictObject({
    chainId: z.number().int().positive()
});

/**
 * The dependency manifest. A client reads this on join and checks that it
 * implements every named rule; if not, it is too old and must recuse
 * itself rather than miscount. This is how criteria upgrades fork cleanly.
 */
export const RequiresSchema = z.object({
    rules: z.array(z.string().min(1)).nonempty(),
    chains: z.record(ChainTickerSchema, ChainConfigSchema)
});

export const CriteriaSchema = z
    .object({
        /** Human-readable label, not consensus-critical beyond changing the CID. */
        name: z.string().min(1),
        /**
         * The directory-slot code this topic decides. One contest per topic: a distinct
         * `contestId` makes the document's bytes distinct, which forks the topic automatically.
         */
        contestId: z.string().min(1),
        /** Allowed range for each `vote` value. v1: { min: 1, max: 1 }. */
        voteSchema: VoteRangeSchema,
        /**
         * Max community selections per wallet in this contest (anti-spam). v1 = 1, the
         * one-vote-per-topic rule: a wallet picks one community. An empty `votes` array is
         * always allowed as withdrawal/abstention regardless of this cap.
         */
        maxVotesPerAddress: z.number().int().positive(),
        /** Block bucket size; all verifiers price the same block per bucket. */
        blocksPerBucket: z.number().int().positive(),
        /** How many buckets a bundle stays valid after its blockNumber. */
        voteExpiryBuckets: z.number().int().positive(),
        /**
         * Who may vote (gates a wallet in or out): one rule, or a boolean tree of them.
         * A single-rule gate is spelled `{ rule: { type, ... } }` — see {@link GateSchema}.
         */
        gate: GateSchema,
        /** How much an eligible vote counts. */
        weight: RuleRefSchema,
        /** Dependency manifest + version negotiation. */
        requires: RequiresSchema
    })
    .strict();

export type VoteRange = z.infer<typeof VoteRangeSchema>;
export type RuleRef = z.infer<typeof RuleRefSchema>;
export type ChainConfig = z.infer<typeof ChainConfigSchema>;
export type Requires = z.infer<typeof RequiresSchema>;
export type Criteria = z.infer<typeof CriteriaSchema>;
