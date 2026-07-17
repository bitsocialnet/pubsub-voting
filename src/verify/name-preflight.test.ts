import { describe, it, expect, vi } from "vitest";
import { preflightCommunityNames } from "./name-preflight.js";
import type { NameResolver } from "../chain/types.js";
import type { Vote } from "../schema/votes.js";
import type { NameResolutionCache } from "./name-resolution-cache.js";

const KEY = "12D3KooWEyoppNCUx8Yx66oV9fVnrJmG92pTuY6zbLDaz8T5XCiL";
const OTHER_KEY = "12D3KooWQYV9dGMFoRzNStwpXztXaBUjtPqi6aU76ZgUriHhKust";

const named = (name: string, publicKey = KEY): Vote => ({ community: { name, publicKey }, vote: 1 });

function resolverTo(publicKey: string | undefined): NameResolver {
    return {
        key: "test",
        provider: "test",
        canResolve: ({ name }) => name.endsWith(".bso"),
        resolve: async () => (publicKey === undefined ? undefined : { publicKey })
    };
}

describe("preflightCommunityNames", () => {
    it("passes settled for votes carrying no name, consulting no resolver", async () => {
        const canResolve = vi.fn(() => true);
        const result = await preflightCommunityNames({
            votes: [{ community: { publicKey: KEY }, vote: 1 }],
            nameResolvers: [{ key: "t", provider: "t", canResolve, resolve: async () => undefined }],
            cache: undefined
        });
        expect(result).toEqual({ ok: true, settled: true });
        expect(canResolve).not.toHaveBeenCalled();
    });

    it("passes settled when every carried name resolves to its claimed key", async () => {
        const result = await preflightCommunityNames({
            votes: [named("memes.bso")],
            nameResolvers: [resolverTo(KEY)],
            cache: undefined
        });
        expect(result).toEqual({ ok: true, settled: true });
    });

    it("fails when no resolver handles the name's TLD", async () => {
        const result = await preflightCommunityNames({
            votes: [named("memes.eth")], // the .bso resolver recuses
            nameResolvers: [resolverTo(KEY)],
            cache: undefined
        });
        expect(result).toMatchObject({ ok: false, communityName: "memes.eth", claimedPublicKey: KEY });
        expect((result as { reason: string }).reason).toContain("no resolver handles");
        expect((result as { resolvedPublicKey?: string }).resolvedPublicKey).toBeUndefined();
    });

    it("fails when the name resolves to no record", async () => {
        const result = await preflightCommunityNames({
            votes: [named("memes.bso")],
            nameResolvers: [resolverTo(undefined)],
            cache: undefined
        });
        expect(result).toMatchObject({ ok: false, communityName: "memes.bso" });
        expect((result as { reason: string }).reason).toContain("does not resolve");
    });

    it("fails with the resolved key when the name points at a DIFFERENT key than claimed", async () => {
        const result = await preflightCommunityNames({
            votes: [named("memes.bso")],
            nameResolvers: [resolverTo(OTHER_KEY)],
            cache: undefined
        });
        expect(result).toMatchObject({
            ok: false,
            communityName: "memes.bso",
            claimedPublicKey: KEY,
            resolvedPublicKey: OTHER_KEY
        });
        expect((result as { reason: string }).reason).toContain(`resolves to ${OTHER_KEY}`);
    });

    it("passes UNSETTLED when the resolver throws (a registry outage never blocks a publish)", async () => {
        const resolver: NameResolver = {
            key: "down",
            provider: "test",
            canResolve: () => true,
            resolve: async () => {
                throw new Error("registry down");
            }
        };
        const result = await preflightCommunityNames({ votes: [named("memes.bso")], nameResolvers: [resolver], cache: undefined });
        expect(result).toEqual({ ok: true, settled: false });
    });

    it("serves a cached resolution without a live resolver call (the shared pkc-js-rule cache)", async () => {
        const resolve = vi.fn(async () => ({ publicKey: KEY }));
        const cache: NameResolutionCache = {
            get: async () => ({ publicKey: KEY, resolverKey: "test", provider: "test", resolvedAtMs: Date.now() }),
            set: async () => {}
        };
        const result = await preflightCommunityNames({
            votes: [named("memes.bso")],
            nameResolvers: [{ key: "test", provider: "test", canResolve: () => true, resolve }],
            cache
        });
        expect(result).toEqual({ ok: true, settled: true });
        expect(resolve).not.toHaveBeenCalled();
    });
});
