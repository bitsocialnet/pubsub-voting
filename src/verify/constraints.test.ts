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

describe("checkBundleConstraints — criteria-bound offline checks", () => {
    // With the v1 cap of 1, a wallet voting for two *different* communities exceeds
    // maxVotesPerAddress and must be rejected. Both communities are distinct and legal at the
    // wire layer (VotesBundleSchema accepts the bundle), so this cannot be caught at parse
    // time — it is a runtime check against the criteria, which is why it lives here.
    it("rejects a bundle with more votes than maxVotesPerAddress (v1 = 1)", () => {
        const result = checkBundleConstraints(
            bundle([
                { community: { publicKey: KEY }, vote: 1 },
                { community: { publicKey: KEY_B }, vote: 1 }
            ]),
            bizCriteria()
        );
        expect(result.valid).toBe(false);
    });

    it("accepts a single-community bundle within the cap", () => {
        const result = checkBundleConstraints(bundle([{ community: { publicKey: KEY }, vote: 1 }]), bizCriteria());
        expect(result.valid).toBe(true);
    });

    it("rejects a vote outside voteSchema (v1 range is [1, 1])", () => {
        const result = checkBundleConstraints(bundle([{ community: { publicKey: KEY }, vote: 2 }]), bizCriteria());
        expect(result.valid).toBe(false);
    });

    it("accepts an empty votes array (withdrawal) regardless of the cap", () => {
        const result = checkBundleConstraints(bundle([]), bizCriteria());
        expect(result.valid).toBe(true);
    });
});
