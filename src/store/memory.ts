import type { VoteIntent, VoteStore } from "./types.js";

/**
 * In-memory {@link VoteStore}: the fallback until the concrete IndexedDB / Node backends are
 * wired. Intents live only for the lifetime of the process, so republishing resumes after a
 * restart only once a durable backend is selected (IndexedDB in the browser, SQLite under
 * `dataPath` on Node — see DESIGN.md "Persistence"). It exists so the voter's lifecycle works
 * and unit tests run with no I/O.
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
