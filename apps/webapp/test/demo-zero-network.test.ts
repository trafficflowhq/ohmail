import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpAdapter } from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import { createEngine, EngineUnarmedError } from "../app/shell/engine-config.js";
import { transportOf } from "@ohmail/app-logic/session/sync-scheduler";

/**
 * THE DEMO PROMISE, as BEHAVIOUR (the demo-content and testing-bar invariants).
 *
 * `demo-gate.test.ts` proves the demo DECISION: that `?demo=1&demo=0` is a demo, that the
 * client may turn the demo on and never off, that the engine is built in the first-render
 * initializer. Every one of those is a source-level or pure-function assertion, and it has
 * to be — `engine.tsx` is a `"use client"` React module.
 *
 * None of them proves the sentence the product actually says, which is **"nothing leaves
 * this tab"**. That is a claim about what happens when the demo runs, and the live engine is the change
 * that gives the same shell a live network path to get wrong: `/join` and `/login` now
 * really do fetch, `HttpAdapter` really is reachable, and `NEXT_PUBLIC_API_BASE` really is
 * set in production. So this file boots the demo engine for real, drives it, and watches
 * every egress primitive a browser has.
 *
 * ── THE CONTROL IS THE POINT ────────────────────────────────────────────────────────────
 *
 * A zero-network assertion passes trivially against code that does nothing. The last test
 * here builds the LIVE engine with the same harness and asserts that `fetch` IS called —
 * so "no requests" is a fact about the demo branch and not about the test being blind.
 */

interface Watchers {
  fetch: ReturnType<typeof vi.fn>;
  xhrOpen: ReturnType<typeof vi.fn>;
  ws: ReturnType<typeof vi.fn>;
  sse: ReturnType<typeof vi.fn>;
  /** Total egress attempts across every mechanism. */
  total(): number;
}

const originals: Record<string, unknown> = {};

/**
 * Trap every way a browser can reach the network.
 *
 * `fetch` alone would be a weak assertion: the engine could use `XMLHttpRequest`, a
 * `WebSocket`, or `EventSource` (which the delta-sync contract explicitly contemplates —
 * `/events` is SSE) and the test would see nothing. `sendBeacon` and `Image` are not
 * trapped because neither is reachable from the engine's surface; the four below are.
 */
function watch(): Watchers {
  const w: Watchers = {
    fetch: vi.fn(async () => new Response("{}", { status: 200 })),
    xhrOpen: vi.fn(),
    ws: vi.fn(),
    sse: vi.fn(),
    total: () => w.fetch.mock.calls.length + w.xhrOpen.mock.calls.length
      + w.ws.mock.calls.length + w.sse.mock.calls.length,
  };

  originals.fetch = globalThis.fetch;
  globalThis.fetch = w.fetch as unknown as typeof fetch;

  originals.XMLHttpRequest = (globalThis as Record<string, unknown>).XMLHttpRequest;
  (globalThis as Record<string, unknown>).XMLHttpRequest = class {
    open(...args: unknown[]): void { w.xhrOpen(...args); }
    send(): void { /* never reached in a passing run */ }
    setRequestHeader(): void { /* noop */ }
  };

  originals.WebSocket = (globalThis as Record<string, unknown>).WebSocket;
  (globalThis as Record<string, unknown>).WebSocket = class {
    constructor(...args: unknown[]) { w.ws(...args); }
    close(): void { /* noop */ }
  };

  originals.EventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    constructor(...args: unknown[]) { w.sse(...args); }
    close(): void { /* noop */ }
  };

  return w;
}

function restore(): void {
  globalThis.fetch = originals.fetch as typeof fetch;
  for (const key of ["XMLHttpRequest", "WebSocket", "EventSource"]) {
    if (originals[key] === undefined) delete (globalThis as Record<string, unknown>)[key];
    else (globalThis as Record<string, unknown>)[key] = originals[key];
  }
}

let watcher: Watchers;
beforeEach(() => { watcher = watch(); });
afterEach(() => { restore(); vi.restoreAllMocks(); });

describe("?demo=1 — the engine performs ZERO network operations", () => {
  it("boots, starts, reads and MUTATES without touching fetch/XHR/WebSocket/EventSource", async () => {
    // The env is passed explicitly and it is the PRODUCTION one — a base URL is present,
    // armed, and the demo must ignore it. Testing the demo branch with no API base
    // configured would be testing nothing at all.
    const engine = createEngine(true, { NEXT_PUBLIC_API_BASE: "/api" });

    // The adapter is the fixture one, not merely "not the HTTP one".
    expect((engine as unknown as { adapter: unknown }).adapter).toBeInstanceOf(FixturesAdapter);

    await engine.start();

    // A real read: the demo world is present, so this is not passing because the engine
    // did nothing.
    const reader = engine.read();
    expect(reader.version()).toBeGreaterThanOrEqual(0);

    // AND A REAL MUTATION. The title said "mutates" and the body only read — which mattered,
    // because reading is the half that obviously touches nothing. A write is where an engine
    // would reach for the network: it is the path that enqueues, applies an optimistic
    // effect and, on the live adapter, POSTs. Driving it here is what makes the assertions
    // below evidence rather than a restatement of the adapter's type.
    const before = reader.version();
    const messages = reader.entries<{ folder?: string }>("message");
    const DEST = "ohmail/Screened" as const;
    const target = messages.find((m) => m.entity.folder !== DEST) ?? messages[0];
    expect(target, "the demo world has no message to move — the fixture is empty").toBeTruthy();
    const result = await engine.mutate({ kind: "move", messageId: target!.id, folder: DEST });
    // `confirmed` — the fixture adapter accepted it, so this is a completed write and not a
    // mutation parked in a queue waiting for a server.
    expect(result.status, JSON.stringify(result)).toBe("confirmed");
    // The world actually changed, locally.
    expect(engine.read().version()).not.toBe(before);
    expect(engine.read().get<{ folder?: string }>("message", target!.id)?.folder).toBe(DEST);

    expect(watcher.fetch).not.toHaveBeenCalled();
    expect(watcher.xhrOpen).not.toHaveBeenCalled();
    expect(watcher.ws).not.toHaveBeenCalled();
    expect(watcher.sse).not.toHaveBeenCalled();
    expect(watcher.total()).toBe(0);
  });

  it("…including SENDING A REPLY, the one mutation that would mail a stranger", async () => {
    // `mail_send` is not one more write. Every other verb in the vocabulary
    // moves a row inside the account; this one, on the live adapter, POSTs a draft and then
    // POSTs a send that hands a message to SMTP. If the demo branch ever leaked to the HTTP
    // adapter, this is the verb that would put fictional mail from Mila's world into a real
    // stranger's inbox — so it gets its own zero-network assertion rather than being covered
    // by inference from `move`.
    const engine = createEngine(true, { NEXT_PUBLIC_API_BASE: "/api" });
    await engine.start();

    const target = engine.read().entries<unknown>("message")[0];
    expect(target, "the demo world has no message to reply to").toBeTruthy();
    const result = await engine.mutate({
      kind: "mail_send", inReplyTo: target!.id, body: "Gerne — Donnerstag?",
    });

    // It really ran: a rejected mutation would also have touched no network.
    expect(result.status, JSON.stringify(result)).toBe("confirmed");
    expect(watcher.total()).toBe(0);
  });

  it("…and including a COMPOSE, which addresses a stranger the demo did not choose", async () => {
    // A later change gave the same verb a second entry point, and this is the one where the address comes
    // from a TEXT FIELD rather than from a fixture row. A demo visitor can type their own
    // employer into it. So the zero-network promise is asserted on the compose shape too, and
    // not inferred from the reply's — the two differ in exactly the field that decides who
    // receives the mail.
    const engine = createEngine(true, { NEXT_PUBLIC_API_BASE: "/api" });
    await engine.start();

    const result = await engine.mutate({
      kind: "mail_send",
      inReplyTo: null,
      subject: "Guten Tag",
      body: "Ein neues Gespräch.",
      to: [{ name: null, address: "someone@example.com" }],
      mailboxId: "lichtgrat",
    });

    expect(result.status, JSON.stringify(result)).toBe("confirmed");
    expect(watcher.total()).toBe(0);
  });

  it("…and including OPENING A MESSAGE, which on the live adapter is a GET", async () => {
    /**
     * The body fetch gave the shell a second wire call — `GET /messages/:id/body` — and every
     * reading surface now makes it: selecting an Ohbox row, a card becoming current in Reads
     * or Receipts, selecting a Screener sender. That is a lot of new call sites for one
     * promise to survive, and the promise is unchanged: `?demo=1` reaches nothing.
     *
     * The demo keeps it two ways, and both are asserted rather than reasoned about:
     * `FixturesAdapter.fetchBody` answers `null` (no endpoint at all), and `hydrateBody`
     * short-circuits before the adapter on a message that already carries its `body` — which
     * every fixture row does. So the demo does not merely avoid the network here; it has
     * nothing to ask for.
     */
    const engine = createEngine(true, { NEXT_PUBLIC_API_BASE: "/api" });
    await engine.start();

    const reader = engine.read();
    const withBody = reader.entries<{ body?: string }>("message").find((m) => m.entity.body);
    expect(withBody, "the demo world has no message with a body — the fixture is empty").toBeTruthy();
    await engine.hydrateBody(withBody!.id);
    // The one fixture message that has NO body (the protected verification code) too — the
    // branch that would reach an adapter if there were one to reach.
    const withoutBody = reader.entries<{ body?: string }>("message").find((m) => !m.entity.body);
    if (withoutBody) await engine.hydrateBody(withoutBody.id);

    // Still the whole message, from the mirror, with no record and no request.
    expect(reader.get<{ body?: string }>("message", withBody!.id)?.body).toBeTruthy();
    expect(reader.get("message_body", withBody!.id)).toBeUndefined();
    expect(watcher.total()).toBe(0);
  });

  it("a second start() — the reconnect path — still reaches nothing", async () => {
    const engine = createEngine(true, { NEXT_PUBLIC_API_BASE: "/api" });
    await engine.start();
    await engine.start();
    expect(watcher.total()).toBe(0);
  });

  it("no persistent store either: the demo leaves nothing behind in the browser", () => {
    // `IndexedDbMirrorStore` would write the fixture world into the visitor's browser.
    // "Nothing leaves this tab" should also mean "nothing stays behind in it".
    const engine = createEngine(true, { NEXT_PUBLIC_API_BASE: "/api" });
    const store = (engine as unknown as { store?: { constructor: { name: string } } }).store;
    expect(store?.constructor?.name ?? "none").not.toBe("IndexedDbMirrorStore");
  });

  it("THE CONTROL: the live engine DOES reach the network, so the assertions above bite", async () => {
    const engine = createEngine(false, { NEXT_PUBLIC_API_BASE: "/api" });
    // Unwrapped through `transportOf`: the live engine's adapter is now behind the abort
    // gate (`sync-scheduler.ts`), and the claim under test is unchanged — what this engine
    // TALKS TO is the HTTP transport, never the fixture world.
    expect(transportOf((engine as unknown as { adapter: unknown }).adapter)).toBeInstanceOf(HttpAdapter);
    // The stubbed fetch answers `{}` to everything, so `start()` may reject on a shape it
    // cannot parse. Reaching the network is the assertion; succeeding is not.
    await engine.start().catch(() => { /* the request is what matters */ });
    expect(watcher.fetch).toHaveBeenCalled();
  });
});

/**
 * ── AND IT HAS TO STAY QUIET OVER TIME, NOT ONLY AT REST ──────────────────────────
 *
 * Every assertion above runs to completion in a few microtasks, so all of them describe a
 * demo that has just finished doing its one thing. A later change gave the LIVE shell a poll — a
 * serialized eight-second loop with jittered backoff — and a timer is exactly the kind of
 * egress a synchronous test cannot see: `expect(fetch).not.toHaveBeenCalled()` passes
 * happily one millisecond before the first tick fires.
 *
 * So these run the clock. If a scheduler ever reaches the demo — by someone dropping the
 * `binding.demo === false` guard in `engine.tsx`, or by the demo path acquiring one of its
 * own — the fixtures adapter would be driven forever and "nothing leaves this tab" would
 * still read as true here without them.
 */
describe("?demo=1 — and it is still zero after minutes of wall clock", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("ten poll periods later the demo has touched nothing and armed nothing", async () => {
    const engine = createEngine(true, { NEXT_PUBLIC_API_BASE: "/api" });
    await engine.start();
    expect(watcher.total()).toBe(0);

    // Ten times the live cadence, then some. A `setInterval` or a serialized loop attached
    // to this engine would have fired repeatedly inside this window.
    await vi.advanceTimersByTimeAsync(8_000 * 10 + 5_000);

    expect(watcher.fetch).not.toHaveBeenCalled();
    expect(watcher.xhrOpen).not.toHaveBeenCalled();
    expect(watcher.ws).not.toHaveBeenCalled();
    expect(watcher.sse).not.toHaveBeenCalled();
    expect(watcher.total()).toBe(0);
    // Nothing is even PENDING: the demo leaves no timer behind to fire after the test.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a demo mutation leaves no timer behind either", async () => {
    const engine = createEngine(true, { NEXT_PUBLIC_API_BASE: "/api" });
    await engine.start();
    const target = engine.read().entries<{ folder?: string }>("message")[0];
    expect(target).toBeTruthy();
    await engine.mutate({ kind: "move", messageId: target!.id, folder: "ohmail/Screened" });

    await vi.advanceTimersByTimeAsync(8_000 * 10);
    expect(watcher.total()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * ── THE OTHER HALF OF THE DEMO PROMISE: ITS CONTENT ─────────────────────────
 *
 * Everything above is about EGRESS — nothing leaves the tab. The mirror image of it went
 * unguarded for as long: nothing from Mila's world may reach an account that is not the demo.
 *
 * It had already failed three times in two files, and every one of them was invisible to a test
 * because the import compiles and the strings render. `ComposeView` read a placeholder, an AI
 * tag and a send-note out of `@ohmail/testing` unconditionally, so `#/compose` showed a paying
 * customer copy written for a persona. `ScreenerView` read its three empty states the
 * same way. `SettingsView` was the worst of them: it rendered `notificationSettings.vips` —
 * "Petra Wyss", "Giulia Ferrari" — and a learned suggestion claiming *"You usually open Petra's
 * mail within 5 minutes"*, to people who have never heard of Petra.
 *
 * ── WHY THE GUARD IS THE IMPORT AND NOT THE RENDER ──────────────────────────────────────
 *
 * "Is this string behind a demo condition?" is not decidable by reading source, and asserting it
 * per surface means a new surface is unguarded by default — which is precisely how the third one
 * happened. Whether a module IMPORTS the fixtures package is decidable, exactly, and it is the
 * one question whose answer forecloses the whole class: with no import there is no fixture
 * string to leak, conditionally or otherwise.
 *
 * Demo content still reaches the demo, through the MIRROR — `FixturesAdapter` seeds the world
 * and `/sync` has no `view_meta` entity type, so a Cloud account cannot be sent the rows that
 * carry it. That is a structural gate rather than a boolean a view has to remember.
 */
describe("no fixture content can reach a live account", () => {
  const APP_DIR = fileURLToPath(new URL("../app", import.meta.url));

  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        out.push(...sources(path));
      } else if (/\.tsx?$/.test(name)) {
        out.push(path);
      }
    }
    return out;
  }

  it("NO module under apps/webapp/app imports @ohmail/testing", () => {
    const files = [...sources(APP_DIR), ...sources(fileURLToPath(new URL("../../../packages/app-logic/src", import.meta.url)))];
    // The control: if this walk finds nothing, the assertion below passes for the wrong reason.
    expect(files.length, "the source walk found no modules under app/").toBeGreaterThan(30);

    const offenders = files.filter((f) => /from\s+["']@ohmail\/testing["']/.test(readFileSync(f, "utf8")));
    expect(
      offenders.map((f) => f.slice(APP_DIR.length + 1)),
      "these modules would render Mila's world to whoever is signed in",
    ).toEqual([]);
  });

  it("…and the three sentences that used to prove it are gone from the product's copy", () => {
    // The strings themselves, not the imports: `messages/en.json` is the file a copy change goes
    // through, and it is where the same claim would come back. Each of these was rendered on a
    // live account and each was false there.
    const copy = readFileSync(fileURLToPath(new URL("../messages/en.json", import.meta.url)), "utf8");
    expect(copy).not.toContain("Sending is disabled in the demo");
    expect(copy).not.toContain("sending is disabled");
    // The whole "Demo — X isn't wired" family. A live customer is not in a demo, so a sentence
    // that opens by telling them they are is false whatever follows it.
    expect(copy).not.toMatch(/"Demo\s*[—-]/);
  });
});

describe("the demo branch cannot be reached around", () => {
  it("`demo: true` ignores every API base, including an absolute origin", () => {
    for (const base of ["/api", "https://api.ohmail.app", "http://localhost:3000", undefined]) {
      const engine = createEngine(true, { NEXT_PUBLIC_API_BASE: base });
      expect((engine as unknown as { adapter: unknown }).adapter).toBeInstanceOf(FixturesAdapter);
    }
  });

  it("`demo: false` with NO base THROWS — fixtures are never a fallback", () => {
    // THIS ASSERTION USED TO SAY THE OPPOSITE, and the behaviour it pinned was the bug.
    //
    // It read: "`demo: false` with NO base is still the fixtures adapter, never a broken
    // HTTP one", justified as "what the gate page in `app/page.tsx` relies on". That
    // justification was stale — `(product)/mailbox/page.tsx:42` renders the gate CARD when
    // there is neither a demo nor an API base and never constructs an engine at all, so no
    // consumer has ever depended on this branch. What it actually guaranteed was that a
    // production build which lost `NEXT_PUBLIC_API_BASE` would hand a signed-in customer
    // Mila's fictional mailbox in the live chrome, silently.
    //
    // Inverted rather than deleted, and it is strictly stronger: the old line permitted the
    // failure, this one forbids it. `engine-armed.test.ts` carries the full case.
    expect(() => createEngine(false, {})).toThrow(EngineUnarmedError);
  });
});
