import { z } from "zod";
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
export const VoteRangeSchema = z.strictObject({
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
 *     on different options stay distinct requirements) — a repeat among siblings says nothing the
 *     shorter tree does not. Across BRANCHES a rule may repeat, deliberately: that is how a gate
 *     expresses a requirement no repetition-free tree can ("any two of these three" is
 *     `{ any: [{ all: [A, B] }, { all: [A, C] }, { all: [B, C] }] }`). The price is that some
 *     redundant spellings survive — `{ all: [{ any: [A, B] }, A] }` is `A` by absorption — so a
 *     leaf's identity is NOT unique within a gate, and its position is what identifies it
 *     (`EligibilityCheck.leaf`);
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
    // requirement, however differently they were written. Siblings only — a rule repeated in
    // another branch is how a gate expresses "any two of these three".
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

/**
 * Structural bounds, checked on the RAW value before the recursive schema ever descends into it.
 * {@link GateNodeSchema} is `z.lazy` and {@link gateShape} recurses, so a pathological document
 * overflows the stack long before any cap can fire — and a `RangeError` escaping `safeParse`
 * breaks the one guarantee that call makes. This walk is iterative and stops at the first node
 * past a bound; anything within them it passes through untouched, so the real schema still
 * produces the precise error for an ordinary authoring mistake.
 */
const MAX_GATE_NODES = MAX_GATE_LEAVES * 2;
function checkGateBounds(raw: unknown, ctx: z.RefinementCtx): void {
    const stack: { node: unknown; depth: number }[] = [{ node: raw, depth: 1 }];
    let nodes = 0;
    while (stack.length > 0) {
        const { node, depth } = stack.pop()!;
        if (depth > MAX_GATE_DEPTH) {
            ctx.addIssue({ code: "custom", message: `gate tree is more than ${MAX_GATE_DEPTH} levels deep` });
            return;
        }
        nodes += 1;
        if (nodes > MAX_GATE_NODES) {
            ctx.addIssue({ code: "custom", message: `gate tree has more than ${MAX_GATE_NODES} nodes` });
            return;
        }
        if (typeof node !== "object" || node === null) continue; // not a node; the schema says so
        const branch = node as { all?: unknown; any?: unknown };
        const children = Array.isArray(branch.all) ? branch.all : branch.any;
        if (!Array.isArray(children)) continue;
        for (const child of children) stack.push({ node: child, depth: depth + 1 });
    }
}

export const GateSchema = z
    .unknown()
    .superRefine(checkGateBounds)
    .pipe(GateNodeSchema)
    .superRefine((node, ctx) => {
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
 * The dependency manifest. A client reads this on join and checks that it
 * implements every named rule; if not, it is too old and must recuse
 * itself rather than miscount. This is how criteria upgrades fork cleanly.
 *
 * Strict for the same reason the top level is: the topic is derived from the PARSED document, so
 * an unknown key must fail loudly rather than be stripped — a stripping schema would drop it and
 * derive a different topic from the one the author's bytes imply. That is what makes a document
 * still carrying the pre-`bucketChainId` `chains` map (or the even older `rpcUrls`) an error
 * instead of a silent re-topic.
 */
export const RequiresSchema = z.strictObject({
    rules: z.array(z.string().min(1)).nonempty()
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
        /**
         * The chain whose blocks this contest counts in, by numeric chain id.
         *
         * The contest has exactly ONE clock, and this names it: `blocksPerBucket` and
         * `voteExpiryBuckets` are measured in its blocks, a ballot's `blockNumber` and the
         * `sampleBlock` every rule is handed are numbers on it, the tie-break seed is the hash of
         * its bucket boundary block, and its id is bound into every EIP-712 ballot domain.
         *
         * It is a chain ID rather than a ticker because that is the identity the signature domain
         * already carries — a ticker is a label local to a document, and two documents spelling
         * one chain differently would be two topics for one contest. Rules do not name a chain at
         * all: they read this one. Gating across several chains is future work, and needs an
         * answer for what block a rule on a SECOND chain is handed before it can ship — see
         * DESIGN.md "Open questions".
         *
         * RPC endpoints are deliberately not part of the criteria: which gateway a client trusts
         * is client-local configuration (`PubsubVoterOptions.chains` maps this id to a client),
         * and two honest verifiers reading the same pinned block through different gateways
         * compute identical results. That keeps an operator's dead-RPC swap from forking the
         * topic and orphaning the contest's votes.
         */
        bucketChainId: z.number().int().positive(),
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
export type Requires = z.infer<typeof RequiresSchema>;
export type Criteria = z.infer<typeof CriteriaSchema>;
