import { createPublicClient, http } from "viem";
import type { Criteria } from "./schema/criteria.js";
import type { BlockstoreLike, HeliaInstance, PubsubService } from "./transport/types.js";
import type { ChainClientFactory } from "./chain/types.js";
import type { VoteSigner } from "./signer/types.js";
import { EIP712_SIGNATURE_TYPE } from "./signer/eip712.js";

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

/** A no-op gossipsub service: construction validates its shape but never calls it. */
function fakePubsub(): PubsubService {
    return {
        publish: async () => undefined,
        subscribe: () => {},
        unsubscribe: () => {},
        getSubscribers: () => [],
        addEventListener: () => {},
        removeEventListener: () => {}
    };
}

/** A no-op blockstore: construction validates its shape but never calls it. */
function fakeBlockstore(): BlockstoreLike {
    return {
        get: async () => new Uint8Array(),
        put: async (cid) => cid,
        has: async () => false
    };
}

/**
 * Build a Helia node from its parts, asserting in (not `any`) the rest of the `Helia`
 * surface the library never touches. Construction only reads `libp2p.services.pubsub`
 * and `blockstore`, so only those are populated; pass `undefined` to omit one and
 * exercise the construction guards.
 */
function makeFakeHelia(pubsub: PubsubService | undefined, blockstore: BlockstoreLike | undefined): HeliaInstance {
    return { libp2p: { services: { pubsub } }, blockstore } as unknown as HeliaInstance;
}

/** A Helia node carrying a gossipsub service and a blockstore, as a host injects. */
export function fakeHelia(): HeliaInstance {
    return makeFakeHelia(fakePubsub(), fakeBlockstore());
}

/** A Helia node whose libp2p has no pubsub service, to assert construction rejects it. */
export function fakeHeliaWithoutPubsub(): HeliaInstance {
    return makeFakeHelia(undefined, fakeBlockstore());
}

/** A Helia node with no blockstore, to assert construction rejects it. */
export function fakeHeliaWithoutBlockstore(): HeliaInstance {
    return makeFakeHelia(fakePubsub(), undefined);
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
        address: () => "0x0000000000000000000000000000000000000001",
        signBallot: () => ({ signature: "0xdeadbeef", type: EIP712_SIGNATURE_TYPE })
    };
}
