import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Criteria } from "./schema/criteria.js";
import type { PeerId } from "@libp2p/interface";
import type { BlockstoreLike, FetchServiceLike, HeliaInstance, PubsubService } from "./transport/types.js";
import type { ChainClient, ChainClientFactory } from "./chain/types.js";
import {
    encodeBulkRootRecords,
    encodeRootRecord,
    BULK_ROOTS_FETCH_KEY,
    ROOT_FETCH_KEY_SUFFIX,
    type BulkFetchRootRecord
} from "./transport/messages.js";
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
        contestId: "biz",
        voteSchema: { min: 1, max: 1 },
        maxVotesPerAddress: 1,
        blocksPerBucket: 43200,
        voteExpiryBuckets: 30,
        rule: {
            type: "erc721-min-balance",
            chain: "base",
            contract: "0x13d41d6B8EA5C86096bb7a94C3557FCF184491b9",
            min: 1
        },
        weight: { type: "constant", value: 1 },
        requires: {
            rules: ["erc721-min-balance", "constant"],
            chains: { base: { chainId: 8453 } }
        }
    };
}

/** A no-op gossipsub service carrying an (empty) topic-validator map, as gossipsub exposes. */
function fakePubsub(): PubsubService {
    return {
        // Report a single recipient, as gossipsub resolves `{ recipients }` for a delivered message.
        publish: async () => ({ recipients: [{ toString: () => "recipient1" } as unknown as PeerId] }),
        subscribe: () => {},
        unsubscribe: () => {},
        getSubscribers: () => [],
        addEventListener: () => {},
        removeEventListener: () => {},
        topicValidators: new Map()
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

/** A no-op libp2p fetch service (no peers answer, registrations are inert). */
export function fakeFetchService(): FetchServiceLike {
    return {
        fetch: async () => undefined,
        registerLookupFunction: () => {},
        unregisterLookupFunction: () => {}
    };
}

/**
 * A fetch service that answers BOTH root-record key shapes from one source of truth: the
 * per-topic `<topic>/root` key and the bulk `bitsocial-votes/roots` key that batches them.
 *
 * Tests must be explicit about which kind of peer they model, because the two differ in a way
 * the client depends on:
 *
 *   - `speaksBulk: true` (default) — a current peer. The bulk key always answers, with an EMPTY
 *     map when it serves nothing. The client reads that as "speaks bulk, has nothing".
 *   - `speaksBulk: false` — answers `undefined` to the bulk key. That models BOTH a pre-bulk peer
 *     and one whose responder is not registered yet (it has joined nothing so far), which are
 *     indistinguishable on the wire. This is what drives the client's fall-back-and-re-probe path.
 *
 * `onFetch` observes every request as `(peerId, key)`, which is how a test counts round trips —
 * the number that distinguishes a batched directory join from a per-contest one.
 */
export function rootFetchService(options: {
    /**
     * topic → that topic's record, as the responder would encode it. Absent topic = no record.
     * An entry may carry inline `chunkBlocks` (the bulk answer's optional payload); the per-topic
     * answer strips them, mirroring the real responder (only the bulk reply inlines blocks).
     */
    records?: () => Record<string, BulkFetchRootRecord>;
    /**
     * Model a pre-bulk peer (answers nothing to the bulk key). Default true = current peer.
     * Pass a FUNCTION to have it re-read per request — that is how a test models a peer whose
     * responder is not registered yet and starts answering partway through the session.
     */
    speaksBulk?: boolean | (() => boolean);
    /** Called for every request, before the answer is computed. */
    onFetch?: (peerId: string, key: string) => void;
} = {}): FetchServiceLike {
    const { records = () => ({}), speaksBulk = true, onFetch } = options;
    const answersBulk = () => (typeof speaksBulk === "function" ? speaksBulk() : speaksBulk);
    return {
        fetch: async (peer: PeerId, key: string | Uint8Array) => {
            const keyString = typeof key === "string" ? key : new TextDecoder().decode(key);
            onFetch?.(peer.toString(), keyString);
            if (keyString === BULK_ROOTS_FETCH_KEY) {
                return answersBulk() ? encodeBulkRootRecords(records()) : undefined;
            }
            if (!keyString.endsWith(ROOT_FETCH_KEY_SUFFIX)) return undefined;
            const record = records()[keyString.slice(0, -ROOT_FETCH_KEY_SUFFIX.length)];
            if (record === undefined) return undefined;
            const { chunkBlocks: _bulkOnly, ...bare } = record;
            return encodeRootRecord(bare);
        },
        registerLookupFunction: () => {},
        unregisterLookupFunction: () => {}
    };
}

/**
 * Build a Helia node from its parts, asserting in (not `any`) the rest of the `Helia`
 * surface the library never touches. Construction only reads `libp2p.services.pubsub`,
 * `libp2p.services.fetch`, and `blockstore`, so only those are populated; pass
 * `undefined` to omit one and exercise the construction guards.
 */
function makeFakeHelia(
    pubsub: PubsubService | undefined,
    blockstore: BlockstoreLike | undefined,
    fetch: FetchServiceLike | undefined
): HeliaInstance {
    return { libp2p: { services: { pubsub, fetch } }, blockstore } as unknown as HeliaInstance;
}

/** A Helia node carrying a gossipsub service, a blockstore, and a fetch service, as a host injects. */
export function fakeHelia(): HeliaInstance {
    return makeFakeHelia(fakePubsub(), fakeBlockstore(), fakeFetchService());
}

/** A Helia node whose libp2p has no pubsub service, to assert construction rejects it. */
export function fakeHeliaWithoutPubsub(): HeliaInstance {
    return makeFakeHelia(undefined, fakeBlockstore(), fakeFetchService());
}

/** A Helia node with no blockstore, to assert construction rejects it. */
export function fakeHeliaWithoutBlockstore(): HeliaInstance {
    return makeFakeHelia(fakePubsub(), undefined, fakeFetchService());
}

/** A Helia node whose libp2p has no fetch service, to assert construction rejects it. */
export function fakeHeliaWithoutFetch(): HeliaInstance {
    return makeFakeHelia(fakePubsub(), fakeBlockstore(), undefined);
}

/**
 * A chain client factory backed by a real viem client — one shared client, as the
 * `ChainClientFactory` contract recommends. viem clients are lazy (no connection until a
 * read), and these unit tests never read, so the RPC URL is never contacted.
 */
export function fakeChains(): ChainClientFactory {
    const client = createPublicClient({ transport: http("https://mainnet.base.org") });
    return () => client;
}

/** A minimal signer for write-path tests (65-byte placeholder — the binary codec checks size). */
export function fakeSigner(): VoteSigner {
    return {
        address: () => "0x0000000000000000000000000000000000000001",
        signBallot: () => ({ signature: `0x${"de".repeat(65)}`, type: EIP712_SIGNATURE_TYPE })
    };
}

/**
 * A REAL signer over the anvil/hardhat test account #1 (as in verify/bundle.test.ts and the
 * two-node integration test), for tests whose bundles must survive the verifier's signature
 * recovery — e.g. the checkpoint-snapshot restore, which re-runs `verifyOffline` on reload.
 * `fakeSigner`'s placeholder fails recovery by design.
 */
export function realSigner(): VoteSigner {
    const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    return {
        address: () => account.address,
        signBallot: async (typedData) => ({ signature: await account.signTypedData(typedData), type: EIP712_SIGNATURE_TYPE })
    };
}

/**
 * A chain factory returning a stubbed viem client (no network): `getBlockNumber` for the
 * current bucket, `getBlock` for the tie-break block hash, and `readContract` for balances.
 * Lets write-path and tally tests run the engine end-to-end without an RPC.
 */
export function stubChains(over: { blockNumber?: bigint; balance?: bigint } = {}): ChainClientFactory {
    const client = {
        getBlockNumber: async () => over.blockNumber ?? 43200n,
        getBlock: async () => ({ hash: `0x${"11".repeat(32)}` }),
        readContract: async () => over.balance ?? 1n
    };
    return () => client as unknown as ChainClient;
}
