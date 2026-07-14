import type { Announcer, AnnouncerOptions } from "./types.js";

/**
 * The browser announcer: inert by design. A browser peer is not dialable — no listener, no
 * public address — so a provider record naming it would only misdirect cold joiners; it must
 * never announce, whatever `httpRouterUrls` says. The package.json `browser` field remaps
 * `./dist/transport/announce/node.js` to this module (the same swap as `src/storage/`), so the
 * voter's wiring is identical on both platforms and only the effect differs.
 */
export function makeAnnouncer(_options: AnnouncerOptions): Announcer {
    return {
        start() {},
        stop() {},
        notifyChange() {}
    };
}
