import type { BlockstoreLike, HeliaInstance, PubsubService } from "./types.js";
import { MissingBlockstoreError, MissingPubsubError } from "../errors.js";

/**
 * The helia/libp2p-touching glue. Like the rest of `transport/`, this is the only place
 * that reaches into the host node; the core never imports it.
 *
 * `requireHeliaServices` is the one piece live today: the host injects its running Helia
 * node directly (no adapter), and we cannot trust the type — `libp2p.services.pubsub` is
 * `unknown`, a plain Helia node has none, and a malformed object may lack a blockstore —
 * so we validate both at construction and fail fast (`MissingPubsubError` /
 * `MissingBlockstoreError`) instead of letting a later publish/subscribe/fetch throw
 * obscurely.
 *
 * Note "bitswap" is not separately checkable: it is a block broker wired *beneath*
 * `blockstore`, not a property of the Helia node, so validating the blockstore (the
 * surface bitswap retrieves through) is the closest honest guarantee.
 */

/** Does `value` look like a pubsub service we can drive (the methods we depend on)? */
function isPubsubService(value: unknown): value is PubsubService {
    if (value === null || typeof value !== "object") return false;
    const candidate = value as Record<string, unknown>;
    return (
        typeof candidate.publish === "function" &&
        typeof candidate.subscribe === "function" &&
        typeof candidate.unsubscribe === "function"
    );
}

/** Does `value` look like a blockstore we can fetch/store blocks through? */
function isBlockstoreLike(value: unknown): value is BlockstoreLike {
    if (value === null || typeof value !== "object") return false;
    const candidate = value as Record<string, unknown>;
    return (
        typeof candidate.get === "function" &&
        typeof candidate.put === "function" &&
        typeof candidate.has === "function"
    );
}

/**
 * Resolve and validate the gossipsub service and blockstore on an injected Helia node,
 * throwing {@link MissingPubsubError} or {@link MissingBlockstoreError} if either is
 * absent or malformed. Returns the narrowed handles so callers do not re-check.
 */
export function requireHeliaServices(helia: HeliaInstance): { pubsub: PubsubService; blockstore: BlockstoreLike } {
    const pubsub: unknown = helia.libp2p?.services?.pubsub;
    if (!isPubsubService(pubsub)) throw new MissingPubsubError();
    const blockstore: unknown = helia.blockstore;
    if (!isBlockstoreLike(blockstore)) throw new MissingBlockstoreError();
    return { pubsub, blockstore };
}
