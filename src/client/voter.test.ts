import { describe, it, expect } from "vitest";
import { PubsubVoter } from "./voter.js";
import { NotImplementedError, ReadOnlyError } from "../errors.js";
import { topicFor } from "../topic.js";
import { bizCriteria, fakeLibp2p, fakeChains, fakeSigner } from "../test-fixtures.js";

describe("PubsubVoter construction + read-only", () => {
    it("is read-only without a signer", () => {
        const voter = new PubsubVoter({ libp2p: fakeLibp2p(), chains: fakeChains() });
        expect(voter.readOnly).toBe(true);
    });

    it("is writable with a signer", () => {
        const voter = new PubsubVoter({ libp2p: fakeLibp2p(), chains: fakeChains(), signer: fakeSigner() });
        expect(voter.readOnly).toBe(false);
    });
});

describe("PubsubVoter.contest", () => {
    it("derives the correct topic and propagates read-only", async () => {
        const voter = new PubsubVoter({ libp2p: fakeLibp2p(), chains: fakeChains() });
        const contest = await voter.contest(bizCriteria());
        expect(contest.topic).toBe(await topicFor(bizCriteria()));
        expect(contest.criteria.contest).toBe("biz");
        expect(contest.readOnly).toBe(true);
    });

    it("caches one network per topic", async () => {
        const voter = new PubsubVoter({ libp2p: fakeLibp2p(), chains: fakeChains() });
        const a = await voter.contest(bizCriteria());
        const b = await voter.contest(bizCriteria());
        expect(a).toBe(b);
    });

    it("rejects an invalid criteria document", async () => {
        const voter = new PubsubVoter({ libp2p: fakeLibp2p(), chains: fakeChains() });
        // @ts-expect-error intentionally invalid for the test
        await expect(voter.contest({ contest: "x" })).rejects.toThrow();
    });
});

describe("write path gating", () => {
    it("castVotes throws ReadOnlyError without a signer", async () => {
        const voter = new PubsubVoter({ libp2p: fakeLibp2p(), chains: fakeChains() });
        const contest = await voter.contest(bizCriteria());
        await expect(contest.castVotes([{ board: "b", vote: 1 }])).rejects.toBeInstanceOf(ReadOnlyError);
    });

    it("castVotes reaches the (unbuilt) engine when a signer is present", async () => {
        const voter = new PubsubVoter({ libp2p: fakeLibp2p(), chains: fakeChains(), signer: fakeSigner() });
        const contest = await voter.contest(bizCriteria());
        await expect(contest.castVotes([{ board: "b", vote: 1 }])).rejects.toBeInstanceOf(NotImplementedError);
    });

    it("getTally reaches the (unbuilt) engine", async () => {
        const voter = new PubsubVoter({ libp2p: fakeLibp2p(), chains: fakeChains() });
        const contest = await voter.contest(bizCriteria());
        await expect(contest.getTally()).rejects.toBeInstanceOf(NotImplementedError);
    });
});
