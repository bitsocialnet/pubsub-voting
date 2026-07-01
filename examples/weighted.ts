/**
 * Example: holder-weighted voting (a capability, not 5chan's default).
 *
 * v1 ships `constant` weight — one Pass, one vote — on purpose: it resists whale
 * dominance and downvote weaponization. But weight is a *magnitude*, so swapping the
 * `weight` slot for a balance/holding interpreter turns votes into holder-weighted
 * power with no engine change; eligibility still gates on the Pass. This carries open
 * governance/abuse questions, and balance-derived weight loses the free lazy-tally
 * ceiling — see DESIGN.md "Interpreters" and "Open questions".
 *
 * A criteria document is derived per contest and shipped static; here two are written
 * out in full so the weighted slots are visible.
 */
import { topicFor, type Criteria } from "@bitsocial/pubsub-votes";

const PASS = "0x13d41d6B8EA5C86096bb7a94C3557FCF184491b9"; // 5chan Pass (example)
const BSO = "0x1234567890abcdef1234567890abcdef12345678"; // placeholder BSO contract

// Among Pass-holders, voting power = BSO balance: 1000 BSO ⇒ 1000 votes.
const bsoWeighted: Criteria = {
    name: "/biz/ - Business & Finance (BSO-weighted)",
    contest: "biz",
    voteSchema: { min: 1, max: 1 },
    maxVotesPerAddress: 1,
    blocksPerBucket: 43200,
    voteExpiryBuckets: 30,
    eligibility: { type: "erc721-min-balance", chain: "base", contract: PASS, min: 1 },
    weight: { type: "erc20-balance", chain: "base", contract: BSO, decimals: 18 },
    requires: {
        interpreters: ["erc721-min-balance", "erc20-balance"],
        chains: { base: { chainId: 8453, rpcUrls: ["https://mainnet.base.org"] } }
    }
};

// Or: one vote per Pass held — 5 Passes ⇒ 5 votes (the gate interpreter, reused as weight).
const passCountWeighted: Criteria = {
    ...bsoWeighted,
    name: "/biz/ - Business & Finance (Pass-count-weighted)",
    weight: { type: "erc721-min-balance", chain: "base", contract: PASS, min: 1 },
    requires: { ...bsoWeighted.requires, interpreters: ["erc721-min-balance"] }
};

console.log("BSO-weighted topic:      ", await topicFor(bsoWeighted));
console.log("Pass-count-weighted topic:", await topicFor(passCountWeighted));
