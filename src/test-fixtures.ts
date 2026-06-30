import { createPublicClient, http } from "viem";
import type { Criteria } from "./schema/criteria.js";
import type { Libp2pHandle } from "./transport/types.js";
import type { ChainClientFactory } from "./chain/types.js";
import type { VoteSigner } from "./signer/types.js";

/**
 * Shared test fixtures. Not part of the public API; imported only by *.test.ts and
 * excluded from the published build (see tsconfig `exclude`). Kept as a plain `.ts`
 * (not `.test.ts`) so vitest does not treat it as a suite.
 */

/** A valid v1 criteria document (the /biz/ slot from the 5chan example). */
export function bizCriteria(): Criteria {
    return {
        name: "/biz/ - Business & Finance",
        contest: "biz",
        voteSchema: { min: 1, max: 1 },
        maxVotesPerAddress: 1,
        blocksPerBucket: 43200,
        voteExpiryBuckets: 30,
        eligibility: {
            type: "erc721-min-balance",
            chain: "base",
            contract: "0x13d41d6B8EA5C86096bb7a94C3557FCF184491b9",
            min: 1
        },
        weight: { type: "constant", value: 1 },
        requires: {
            interpreters: ["erc721-min-balance", "constant"],
            chains: { base: { chainId: 8453, rpcUrls: ["https://mainnet.base.org"] } }
        }
    };
}

/** A no-op libp2p handle: construction never calls these in unit tests. */
export function fakeLibp2p(): Libp2pHandle {
    return {
        publish: async () => {},
        subscribe: async () => {},
        unsubscribe: async () => {},
        peers: async () => [],
        fetch: async () => undefined,
        handleFetch: async () => {}
    };
}

/**
 * A chain client factory backed by real viem clients. viem clients are lazy (no
 * connection until a read), and these unit tests never read, so the configured RPC
 * URL is never contacted.
 */
export function fakeChains(): ChainClientFactory {
    return ({ config }) => createPublicClient({ transport: http(config.rpcUrls[0]) });
}

/** A minimal signer for write-path tests. */
export function fakeSigner(): VoteSigner {
    return {
        author: () => ({ address: "author-1", wallets: {} }),
        sign: () => ({ signature: "deadbeef", type: "ed25519" })
    };
}
