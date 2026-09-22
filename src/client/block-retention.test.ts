import {describe, it, expect, vi} from "vitest";
import {CID} from "multiformats/cid";
import {PubsubVoter} from "./voter.js";
import type {ChainClient} from "../chain/types.js";
import type {BlockstoreLike} from "../transport/types.js";
import type {FetchRootRecord} from "../transport/messages.js";
import {bizCriteria, fakeHelia, fakeSigner, stubChains} from "../test-fixtures.js";

const votes = [{community: {publicKey: "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL"}, vote: 1}];

describe("host blockstore GC retention", () => {
    it("retains admitted bundles and checkpoint blocks across codec aliases, and releases stopped contests", async () => {
        const helia = fakeHelia();
        const puts = vi.spyOn(helia.blockstore as unknown as BlockstoreLike, "put");
        const voter = new PubsubVoter({dataPath: false, helia, chains: stubChains()});
        try {
            const criteria = bizCriteria();
            const contest = await voter.createContest({criteria});
            const view = contest as unknown as {rootRecord(): Promise<FetchRootRecord>};
            const published = await (await voter.createContestVote({criteria, votes, signer: fakeSigner()})).publish();
            // Admission is protected even before the deferred checks finish.
            expect(voter.retainsBlock(published.cid)).toBe(true);
            await vi.waitFor(async () => expect((await view.rootRecord()).count).toBe(1));
            const root = await view.rootRecord();
            for (const cid of [published.cid, root.root, ...root.chunks]) {
                expect(voter.retainsBlock(cid)).toBe(true);
                expect(voter.retainsBlock(CID.createV1(0x55, cid.multihash))).toBe(true);
                expect(voter.retainsBlock(CID.decode(cid.multihash.bytes))).toBe(true);
            }
            await contest.stop();
            for (const cid of [published.cid, root.root, ...root.chunks]) expect(voter.retainsBlock(cid)).toBe(false);
            puts.mockClear();
            await contest.update();
            await view.rootRecord();
            expect(puts.mock.calls.some(([cid]) => cid.equals(root.root))).toBe(true);
            expect(voter.retainsBlock(published.cid)).toBe(true);
        } finally { await voter.destroy(); }
    });

    it("retains a shared empty checkpoint until its last joined contest leaves", async () => {
        const voter = new PubsubVoter({dataPath: false, helia: fakeHelia(), chains: stubChains()});
        try {
            const a = await voter.createContest({criteria: bizCriteria()});
            const b = await voter.createContest({criteria: {...bizCriteria(), contestId: "other"}});
            await a.update();
            await b.update();
            const root = await (a as unknown as {rootRecord(): Promise<FetchRootRecord>}).rootRecord();
            await (b as unknown as {rootRecord(): Promise<FetchRootRecord>}).rootRecord();
            await a.stop();
            expect(voter.retainsBlock(root.root)).toBe(true);
            await b.stop();
            expect(voter.retainsBlock(root.root)).toBe(false);
        } finally { await voter.destroy(); }
    });
    it("protects provisional and fallback bundles, then releases superseded checkpoints and expired votes", async () => {
        let head = 43200n;
        let hold = false;
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        const client = {
            getBlockNumber: async () => head,
            getBlock: async () => ({hash: `0x${"11".repeat(32)}`}),
            readContract: async ({functionName}: {functionName?: string} = {}) => {
                if (functionName === "supportsInterface") return true;
                if (hold) await pending;
                return 1n;
            }
        };
        const voter = new PubsubVoter({dataPath: false, helia: fakeHelia(), chains: () => client as unknown as ChainClient});
        try {
            const criteria = bizCriteria();
            const contest = await voter.createContest({criteria});
            const view = contest as unknown as {rootRecord(): Promise<FetchRootRecord>};
            const first = await (await voter.createContestVote({criteria, votes, signer: fakeSigner()})).publish();
            await vi.waitFor(async () => expect((await view.rootRecord()).count).toBe(1));
            const oldRoot = await view.rootRecord();
            hold = true;
            head = 86400n;
            const next = await (await voter.createContestVote({criteria, votes, signer: fakeSigner()})).publish();
            expect(voter.retainsBlock(first.cid)).toBe(true);
            expect(voter.retainsBlock(next.cid)).toBe(true);
            expect((await view.rootRecord()).root.equals(oldRoot.root)).toBe(true);
            release();
            await vi.waitFor(async () => expect((await view.rootRecord()).root.equals(oldRoot.root)).toBe(false));
            expect(voter.retainsBlock(oldRoot.root)).toBe(false);
            await contest.getTally(); // housekeeping prunes the superseded admitted bundle
            expect(voter.retainsBlock(first.cid)).toBe(false);
            expect(voter.retainsBlock(next.cid)).toBe(true);
            head = 43200n * 100n;
            await contest.getTally();
            await view.rootRecord();
            expect(voter.retainsBlock(next.cid)).toBe(false);
        } finally { release(); await voter.destroy(); }
    });

});
