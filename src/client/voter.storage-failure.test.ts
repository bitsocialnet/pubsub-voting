import { describe, it, expect, vi } from "vitest";
import { PubsubVoter } from "./voter.js";
import { bizCriteria, fakeHelia, stubChains, fakeSigner } from "../test-fixtures.js";
import type { VoteStorage } from "../storage/types.js";

/**
 * The snapshot store's failure contract, isolated in its own file because it mocks the whole
 * storage backend: an IndexedDB in private-browsing mode, a full disk, or a permission error
 * can make every snapshot read/write throw. Both paths are best-effort by design — a broken
 * store must degrade the voter to its pre-persistence behavior, never break join or leave.
 */
vi.mock("../storage/node.js", async () => {
    const { makeMemoryStorage } = await vi.importActual<typeof import("../storage/memory.js")>("../storage/memory.js");
    return {
        makeStorage: (): VoteStorage => {
            const memory = makeMemoryStorage(); // the LRU caches stay healthy — only snapshots fail
            return {
                openLru: (opts) => memory.openLru(opts),
                openSnapshots: () => ({
                    get: async () => {
                        throw new Error("snapshot store unreadable");
                    },
                    set: async () => {
                        throw new Error("snapshot store unwritable");
                    },
                    remove: async () => {
                        throw new Error("snapshot store unwritable");
                    }
                }),
                destroy: () => memory.destroy()
            };
        }
    };
});

const VALID_KEY = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";
const VOTE = [{ community: { publicKey: VALID_KEY }, vote: 1 }];

describe("snapshot store failure (best-effort persistence)", () => {
    it("an unreadable snapshot store degrades the join to a plain cold start", async () => {
        const voter = new PubsubVoter({ dataPath: "mocked-away", helia: fakeHelia(), chains: stubChains() });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        const errors: unknown[] = [];
        contest.on("error", (e) => errors.push(e));
        await expect(contest.update()).resolves.toBeUndefined(); // the throwing get never surfaces
        expect(contest.tally?.ranking).toEqual([]); // joined empty, exactly as before persistence
        expect(errors).toEqual([]);
        await voter.stop();
    });

    it("an unwritable snapshot store never fails the leave flush (the write is best-effort)", async () => {
        const voter = new PubsubVoter({ dataPath: "mocked-away", helia: fakeHelia(), chains: stubChains(), signer: fakeSigner() });
        const contest = await voter.createContest({ criteria: bizCriteria() });
        const errors: unknown[] = [];
        contest.on("error", (e) => errors.push(e));
        await (await voter.createContestVote({ criteria: bizCriteria(), votes: VOTE })).publish();
        // Wait for the deferred gate read to settle, so the leave flush really attempts the
        // snapshot write (a pending check would skip it before reaching the store).
        await vi.waitFor(async () => expect((await contest.getTally()).ranking[0]?.chainVerified).toBe(true));
        await expect(voter.stop()).resolves.toBeUndefined(); // the throwing set is swallowed
        expect(errors).toEqual([]);
        await voter.destroy();
    });
});
