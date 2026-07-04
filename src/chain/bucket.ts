import type { BucketMath } from "./types.js";

/**
 * Bucket math for one criteria's `blocksPerBucket`.
 *
 *   bucketForBlock(block)        = Math.floor(block / blocksPerBucket)
 *   sampleBlockForBucket(bucket) = bucket * blocksPerBucket  (the bucket boundary block)
 *
 * Every verifier prices balances at one sample block per bucket so votes cannot
 * flip-flop mid-bucket and every client agrees. v1 uses the bucket boundary (the head
 * rounded down to `blocksPerBucket`); the boundary lags the head by up to a full bucket,
 * which also places it past any realistic reorg depth (see DESIGN.md "Tally", "CRDT").
 */
export function makeBucketMath(blocksPerBucket: number): BucketMath {
    if (!Number.isInteger(blocksPerBucket) || blocksPerBucket <= 0) {
        throw new RangeError(`blocksPerBucket must be a positive integer, got ${blocksPerBucket}`);
    }
    return {
        bucketForBlock(blockNumber: number): number {
            return Math.floor(blockNumber / blocksPerBucket);
        },
        sampleBlockForBucket(bucket: number): number {
            return bucket * blocksPerBucket;
        }
    };
}
