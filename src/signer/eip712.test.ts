import { describe, it, expect } from "vitest";
import { hashTypedData } from "viem";
import {
    ballotTypedData,
    BALLOT_TYPES,
    EIP712_DOMAIN_NAME,
    EIP712_DOMAIN_VERSION
} from "./eip712.js";

const base = { contestCid: "bafyTestContestCid", chainId: 8453, blockNumber: 1000 };

describe("ballotTypedData", () => {
    it("sets the shared domain and primary type", () => {
        const td = ballotTypedData({ ...base, votes: [{ board: "b", vote: 1 }] });
        expect(td.domain).toEqual({ name: EIP712_DOMAIN_NAME, version: EIP712_DOMAIN_VERSION, chainId: 8453 });
        expect(td.primaryType).toBe("Ballot");
        expect(td.types).toBe(BALLOT_TYPES);
    });

    it("binds contest + blockNumber and converts integers to bigint", () => {
        const td = ballotTypedData({ ...base, votes: [{ board: "b", vote: 1 }] });
        expect(td.message.contest).toBe(base.contestCid);
        expect(td.message.blockNumber).toBe(1000n);
        expect(td.message.votes).toEqual([{ board: "b", vote: 1n }]);
    });

    it("carries an empty votes array (the withdrawal form)", () => {
        const td = ballotTypedData({ ...base, votes: [] });
        expect(td.message.votes).toEqual([]);
        expect(() => hashTypedData(td)).not.toThrow();
    });

    it("produces well-formed typed data that hashes deterministically", () => {
        const a = ballotTypedData({ ...base, votes: [{ board: "b", vote: 1 }] });
        const b = ballotTypedData({ ...base, votes: [{ board: "b", vote: 1 }] });
        expect(hashTypedData(a)).toBe(hashTypedData(b));
    });

    it("hashes differently when any bound field changes", () => {
        const h = (over: Partial<typeof base> & { votes?: { board: string; vote: number }[] }) =>
            hashTypedData(ballotTypedData({ ...base, votes: [{ board: "b", vote: 1 }], ...over }));
        const ref = h({});
        expect(h({ contestCid: "bafyOther" })).not.toBe(ref);
        expect(h({ chainId: 1 })).not.toBe(ref);
        expect(h({ blockNumber: 1001 })).not.toBe(ref);
        expect(h({ votes: [{ board: "c", vote: 1 }] })).not.toBe(ref);
        expect(h({ votes: [{ board: "b", vote: 2 }] })).not.toBe(ref);
    });
});
