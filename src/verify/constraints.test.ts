import { describe, it, expect } from "vitest";
import { checkBundleConstraints } from "./constraints.js";
import { bizCriteria } from "../test-fixtures.js";
import type { VotesBundle } from "../schema/votes.js";

// Two real, decodable base58btc IPNS keys (12D3KooW…) — two distinct, legal communities.
const KEY = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";
const KEY_B = "12Czge2qhmFg7TPsvfRDyZiWbwho51g5fgqc6LoVD6nTUWbodZXw";

const bundle = (votes: VotesBundle["votes"]): VotesBundle => ({
    address: "0x0000000000000000000000000000000000000001",
    votes,
    blockNumber: 43200,
    signature: { signature: "0xsig", type: "eip712" }
});

describe("checkBundleConstraints — votes.length <= maxVotesPerAddress (runtime, criteria-bound)", () => {
    // Reproduce-first pin (see AGENTS.md "When implementing later"): with the v1 cap of 1, a
    // wallet voting for two *different* communities exceeds maxVotesPerAddress and must be
    // rejected. Both boards are distinct and legal at the wire layer (VotesBundleSchema
    // accepts the bundle), so this cannot be caught at parse time — it is a runtime check
    // against the criteria, which is why it lives here in the verify layer.
    //
    // Marked `it.fails` because checkBundleConstraints is design-only and throws
    // NotImplementedError today, so the suite stays green (AGENTS.md forbids committing
    // failing/skipped tests). The assertion below is the *desired* end-state. When the
    // offline verify stage lands and implements the cap, this test starts passing, which
    // flips `it.fails` red — the signal to drop `.fails` and keep it as a real test.
    it.fails("rejects a bundle with more votes than maxVotesPerAddress (v1 = 1)", () => {
        const criteria = bizCriteria(); // maxVotesPerAddress = 1
        const result = checkBundleConstraints(
            bundle([
                { board: { publicKey: KEY }, vote: 1 },
                { board: { publicKey: KEY_B }, vote: 1 }
            ]),
            criteria
        );
        expect(result.valid).toBe(false);
    });
});
