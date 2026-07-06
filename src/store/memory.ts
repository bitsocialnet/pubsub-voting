import type { VoteIntent, VoteStore } from "./types.js";

/**
 * In-memory {@link VoteStore}: the fallback used on Node when no `dataPath` is given (the
 * durable backends are the browser's IndexedDB and Node's SQLite-under-`dataPath` — see
 * `selectVoteStore` and DESIGN.md "Persistence"). Intents live only for the lifetime of the
 * process, so republishing does NOT survive a restart with this backend. It exists so the
 * voter's lifecycle works with no configured persistence and so unit tests run with no I/O.
 */
export class MemoryVoteStore implements VoteStore {
    readonly #byTopic = new Map<string, VoteIntent>();

    async list(): Promise<VoteIntent[]> {
        return [...this.#byTopic.values()];
    }

    async get(topic: string): Promise<VoteIntent | undefined> {
        return this.#byTopic.get(topic);
    }

    async put(intent: VoteIntent): Promise<void> {
        this.#byTopic.set(intent.topic, intent);
    }

    async delete(topic: string): Promise<void> {
        this.#byTopic.delete(topic);
    }
}
