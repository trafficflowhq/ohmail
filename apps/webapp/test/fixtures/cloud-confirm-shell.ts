/**
 * THE REAL CLOUD ENTRY, MOUNTED, WITH THE SESSION CHECK SCRIPTABLE PER CALL.
 *
 * A sibling of `live-walk-shell.ts` rather than an option on it, and deliberately so: that
 * fixture INJECTS a `resolveOwner` that answers instantly, which is exactly the seam the
 * defect lived behind. A guard about the confirm has to mount the component that owns the
 * confirm — `(product)/mailbox/CloudShell.tsx` — and drive `GET /api/auth/session` on the wire,
 * or it proves something about the harness instead of about the product. `live-walk-shell.ts`
 * is untouched by this slice's guards for the same reason its own header gives for existing:
 * a second opinion about what "the shell" means is worse than a second file.
 *
 * What is scriptable here is only what the slice is about: the session read, the refresh, and
 * the clock. Everything else answers the way the account really answers — `/hello` with pairing
 * off, `/mailboxes` empty, `/consent` onboarded, `/sync` an empty page — because a guard that
 * has to stub twelve endpoints to see one screen is measuring the stubs.
 *
 * ── THE RESPONSES ARE QUEUES, NOT PREDICATES ───────────────────────────────────────────────
 *
 * `scriptSession(a, b, c)` means "the first call gets `a`, the second `b`, the third `c`, and
 * every call after that gets `c`". The last entry repeating is what makes "…then 200 for ever"
 * one argument rather than a count somebody has to keep in step with the retry ladder. A
 * SCRIPT THAT RUNS SHORT would otherwise be indistinguishable from a ladder that stopped.
 */
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { vi } from "vitest";
import messages from "../../messages/en.json";
import { resetResumeLaneForTests } from "../../app/shell/resume-lane";

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
export const act = (React as unknown as {
  act: (cb: () => Promise<void> | void) => Promise<void>;
}).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export const ISO = "2026-09-04T12:40:00.000Z";
export const ACCOUNT = "acct_confirm_1";

/**
 * A scripted answer: a FACTORY for a `Response`, or a thrown network failure.
 *
 * A factory rather than a `Response`, and that is not a style choice. A `Response` body may be
 * read once, the retry ladder asks repeatedly, and the last script entry repeats by design —
 * so a stored `Response` has to be cloned per delivery, and a clone of an already-read body is
 * a `TypeError` that surfaces as a *different* failure than the one under test. A factory
 * mints a fresh body every time and has no such state.
 */
export type Scripted = (() => Response) | "reject";

const json = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/* ── The session answers, named after what the SERVER did ──────────────────────────────────── */

/** 200, a live full session for {@link ACCOUNT}. */
export const sessionFull = (accountId = ACCOUNT): Response =>
  json({
    user: {
      userId: "usr_confirm_1", accountId, email: "confirm@example.invalid",
      displayName: "Confirm", emailVerified: true,
      twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true },
    },
    scope: "full",
  }, 200);

/** 200, the password factor alone. An ANSWERED refusal — the verdict arm. */
export const sessionEnrollment = (): Response =>
  json({
    user: {
      userId: "usr_confirm_1", accountId: ACCOUNT, email: "confirm@example.invalid",
      displayName: "Confirm", emailVerified: false,
      twofaEnrolled: { webauthn: false, totp: false, recoveryCodes: false },
    },
    scope: "enrollment",
  }, 200);

/**
 * The production failure this slice exists for, byte-for-byte as the API sends it:
 * `packages/api/src/middleware.ts`'s `dbBusyResponse` — a coded envelope, `retryable: true`
 * and `Retry-After: 5`. Every one of those three said "come back"; the shell said "signed out".
 */
export const db503 = (): Response =>
  json({
    error: {
      code: "db_busy", retryable: true,
      message: "the server's database connection was busy and this request could not be started; retry shortly",
    },
  }, 503, { "retry-after": "5" });

/** A gateway with no envelope of ours. `code` becomes `"internal"`; `wire.coded` must be false. */
export const html502 = (): Response =>
  new Response("<html><body>Bad Gateway</body></html>", {
    status: 502, headers: { "content-type": "text/html" },
  });

/** 429 with the same advice as {@link db503}. */
export const rate429 = (): Response =>
  json({ error: { code: "rate_limited", message: "slow down", retryable: true } }, 429,
    { "retry-after": "5" });

/** Our own 401 envelope — the shape a revoked session really answers with. */
export const coded401 = (): Response =>
  json({ error: { code: "unauthorized", message: "no session" } }, 401);

/** A 401 from a platform: no envelope, so nothing of ours refused anything. */
export const uncoded401 = (): Response =>
  new Response("<html><body>Unauthorized</body></html>", {
    status: 401, headers: { "content-type": "text/html" },
  });

/** `POST /auth/refresh` succeeding: a fresh session, no body. */
export const refresh204 = (): Response => new Response(null, { status: 204 });

/* ── The script ────────────────────────────────────────────────────────────────────────────── */

/**
 * ═══ A REAL `/sync` PAGE, BECAUSE THE OLD STUB MADE EVERY DRAIN THROW ═════════════════════
 *
 * This fixture used to answer `/sync` with `{ items, nextCursor, hasMore }`. That is not a
 * `SyncResponse` — the engine's `flattenResponse` reads `changes.creates` and friends — so
 * EVERY drain in every warm case here failed inside the engine before it reached the store.
 * Nothing merged, ever, and a "no foreign mail was merged" assertion written against it would
 * have been green with the gate deleted. That is the fixture-blindness failure in its purest
 * form: the negative control has to be shown MERGING before the negative means anything.
 *
 * So: a real page, one message, whose subject is the thing a test looks for on screen. The
 * consent rule rides along for the reason `live-walk-shell.ts` gives — a message whose
 * sender has no rule yet lands in the Screener rather than the Ohbox.
 */
export function syncPage(subject: string, accountId = ACCOUNT): Response {
  const id = `m_${subject.replace(/\W+/g, "_")}`;
  const address = `${id}@example.invalid`;
  return json({
    changes: {
      creates: [
        {
          type: "message", op: "create", id, seq: 1, updatedAt: ISO,
          entity: {
            id, accountId, mailboxId: "mb_1", threadId: null, messageIdHeader: null,
            subject,
            from: { name: `Sender ${id}`, address },
            to: [], cc: [], date: ISO, folder: "INBOX", snippet: `snippet of ${subject}`,
            unread: true, hasAttachments: false, attachmentCount: 0, sensitivity: {},
            triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
          },
        },
        {
          type: "rule", op: "create", id: `rule_${address}`, seq: 2, updatedAt: ISO,
          entity: {
            id: `rule_${address}`, kind: "sender", match: address, destination: "INBOX",
            priority: 0, provenance: "seeded-from-sent", enabled: true,
            stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
          },
        },
      ],
      updates: [], moves: [], deletes: [],
    },
    cursor: "c1", hasMore: false, serverTime: ISO,
  }, 200);
}

let syncScript: (() => Response) | null = null;
let syncAt = 0;

/** What `/sync` answers. Absent ⇒ an empty page, which merges nothing and throws nothing. */
export function scriptSync(next: () => Response): void {
  syncScript = next;
}
/** How many delta drains actually left the browser. The fact a zero-merge claim rests on. */
export const syncCalls = (): number => syncAt;

let sessionScript: Scripted[] = [];
let refreshScript: Scripted[] = [];
let sessionAt: number[] = [];
let refreshAt: number[] = [];

/** Queue the answers `GET /api/auth/session` gives. The last one repeats. */
export function scriptSession(...answers: Scripted[]): void {
  sessionScript = answers;
}

/** Queue the answers `POST /auth/refresh` gives. The last one repeats; default is a coded 401. */
export function scriptRefresh(...answers: Scripted[]): void {
  refreshScript = answers;
}

/** When each session read happened, in ms since the pinned clock. One entry per call. */
export const sessionCallsAt = (): number[] => sessionAt.map((t) => t - Date.parse(ISO));
export const sessionCalls = (): number => sessionAt.length;
export const refreshCalls = (): number => refreshAt.length;

let logoutScript: Scripted[] = [];
let logoutAt = 0;

/** Queue the answers the sign-out door gives. The last one repeats; default is its 204. */
export function scriptLogout(...answers: Scripted[]): void {
  logoutScript = answers;
}
/** How many presses reached the door at its BARE path. */
export const logoutCalls = (): number => logoutAt;

function take(script: Scripted[], n: number): Scripted {
  // `n` is one-based. Past the end, the LAST entry repeats — see the header.
  if (script.length === 0) return () => json({}, 200);
  return script[Math.min(n, script.length) - 1]!;
}

async function serve(script: Scripted[], n: number): Promise<Response> {
  const answer = take(script, n);
  if (answer === "reject") throw new TypeError("Failed to fetch");
  return answer();
}

let roots: Root[] = [];
let originalFetch: typeof globalThis.fetch;

/** Install the jsdom gaps, pin the clock, and arm the scripted wire. Call from `beforeEach`. */
export function installConfirmEnv(): void {
  vi.useFakeTimers();
  // The resume lane is tab state: each case starts cold, on its own clock.
  resetResumeLaneForTests();
  vi.setSystemTime(new Date(ISO));
  window.location.hash = "";
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  originalFetch = globalThis.fetch;
  sessionScript = [];
  syncScript = null;
  syncAt = 0;
  refreshScript = [coded401];
  sessionAt = [];
  refreshAt = [];
  logoutScript = [() => new Response(null, { status: 204 })];
  logoutAt = 0;

  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/auth/session")) {
      sessionAt.push(Date.now());
      return serve(sessionScript, sessionAt.length);
    }
    // The sign-out door at its BARE path, exactly; anything else below the refresh path is no
    // route. Before the refresh branch, which would otherwise answer the door as a renewal.
    const pathname = new URL(url, "http://localhost").pathname;
    if (pathname === "/auth/refresh/logout") {
      logoutAt += 1;
      return serve(logoutScript, logoutAt);
    }
    if (url.includes("/auth/refresh/")) return json({ error: { code: "not_found", message: "no route" } }, 404);
    // The BARE path, not `/api/auth/refresh` — `session-refresh.ts` explains why the refresh
    // cookie is only ever in scope for that one URL, and a stub that matched the prefixed form
    // would let a wrong-path regression pass.
    if (url.includes("/auth/refresh")) {
      refreshAt.push(Date.now());
      return serve(refreshScript, refreshAt.length);
    }
    if (url.includes("/hello")) return json({ features: { pairing: false } }, 200);
    if (url.includes("/mailboxes")) return json({ items: [] }, 200);
    if (url.includes("/billing/subscription")) {
      return json({ plan: "solo", status: "active", aiEnabled: false }, 200);
    }
    if (url.includes("/consent")) {
      return json({
        seedConfirmedAt: ISO, screeningResetAt: null, dormancyDays: 60,
        counts: { decidedSenders: 0, activeUndecidedSenders: 0, dormantUndecidedSenders: 0 },
      }, 200);
    }
    /*
     * `/sync/snapshot` is answered 404 DELIBERATELY, and the decision is recorded rather than
     * inherited: the engine latches the route unusable and falls back to `since=0`, which is
     * the delta path these cases are about. Serving a snapshot instead would put the bootstrap
     * on a second route with its own paging and its own gate question.
     */
    if (url.includes("/sync/snapshot")) return new Response("", { status: 404 });
    if (url.includes("/sync")) {
      syncAt += 1;
      if (syncScript) return syncScript();
      return json({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: "c0", hasMore: false, serverTime: ISO,
      }, 200);
    }
    void init;
    return json({}, 200);
  }) as unknown as typeof globalThis.fetch;

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false, media: query,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {},
      onchange: null, dispatchEvent: () => false,
    }),
  });
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] { return []; }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
}

export async function teardownConfirmEnv(): Promise<void> {
  for (const root of roots) await act(() => root.unmount());
  roots = [];
  document.body.innerHTML = "";
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  globalThis.fetch = originalFetch;
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  resetResumeLaneForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
}

/**
 * REMEMBER AN ACCOUNT, so the next mount takes the WARM path.
 *
 * `tf_owner` is the account name the API sets beside the session (`shell/owner-cookie.ts`),
 * readable by script on purpose. Setting it is what turns the mount into the case that was
 * actually met: a mirror already painting while the confirm runs beside it.
 */
export function rememberOwner(accountId = ACCOUNT): void {
  document.cookie = `tf_owner=${accountId}; Path=/`;
}

/** Mount the real `CloudShell` behind the provider the Cloud route wraps it in. */
export async function mountCloudShell(): Promise<HTMLElement> {
  const { CloudShell } = await import("../../app/(product)/mailbox/CloudShell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const { localStorageDoor } = await import("../../app/shell/durable.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en",
      messages,
      timeZone: "UTC",
      now: new Date(ISO),
      children: h(ThemeProvider, {
        // The product door's persistence, through the same durable door its providers pass.
        storage: localStorageDoor("theme"),
        children: h(ToastHost, { children: h(CloudShell, { demo: false }) }),
      }),
    }));
  });
  return container;
}

/**
 * Advance the pinned clock and let every settled promise run.
 *
 * ── ONE `act` PER STEP, AND THAT IS THE WHOLE POINT OF THIS HELPER ─────────────────────────
 *
 * A single `act(() => advanceTimersByTimeAsync(30_000))` measures this ladder as TWO asks long
 * instead of four, and it is worth writing down because of the shape of the lie: a retry that
 * never happened looks exactly like a retry that was never owed, and the natural assertion
 * beside it — "the verdict pane never appeared" — is GREEN either way, because a shell that
 * never re-asked also never got a second refusal to render.
 *
 * The cause is `act`, not the timers. React batches inside an `act` scope and commits when the
 * scope EXITS, so within one long block the chain `503 → setBinding → re-render → effect →
 * setTimeout(next ask)` never reaches its last link: the next timer is not armed while the
 * clock is still moving, and the advance runs past its due time. Splitting the advance into
 * steps that each open and close their own `act` is what lets the ladder arm rung n+1 before
 * the clock reaches it. Measured: 4 asks at 0 / 2531 / 8798 / 16055 ms, then `unconfirmed`.
 *
 * The microtask flush inside each step is the smaller half — one attempt is `fetch` →
 * `res.text()` → `.then` → commit, which is several hops.
 *
 * Stepping keeps the assertions honest in the other direction too: `tick(2_400)` advances
 * exactly 2 400 ms, so a retry that came back before the server's `Retry-After` is caught
 * rather than absorbed. Timer due times are exact within a step, so the recorded call times
 * are the real ones and not multiples of the step.
 */
export async function tick(ms: number): Promise<void> {
  const STEP = 250;
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  };
  await act(flush);
  for (let left = ms; left > 0; left -= STEP) {
    const span = Math.min(STEP, left);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(span);
      await flush();
    });
  }
}

/* ── Reading the screen ────────────────────────────────────────────────────────────────────── */

const textOf = (el: HTMLElement): string => el.textContent ?? "";

/** The verdict pane — `session.endedBody`. The sentence this slice exists to stop showing. */
export const showsEnded = (el: HTMLElement): boolean =>
  textOf(el).includes(messages.session.endedBody);

/** The end of the ladder — `session.unconfirmedTitle`. */
export const showsUnconfirmed = (el: HTMLElement): boolean =>
  textOf(el).includes(messages.session.unconfirmedTitle);

/** The mailbox itself. `AppShell`'s root node, which `isSameNode` comparisons hang off. */
export const shellRoot = (el: HTMLElement): HTMLElement | null =>
  el.querySelector<HTMLElement>(".app-root");

/** The blocking overlay's node, `SessionEnded`'s markup — present only at `unconfirmed`. */
export const overlay = (el: HTMLElement): HTMLElement | null =>
  el.querySelector<HTMLElement>(".session-end");

/** The `Try again` button, wherever it is rendered. */
export function tryAgainButton(el: HTMLElement): HTMLButtonElement {
  const found = [...el.querySelectorAll("button")]
    .find((b) => (b.textContent ?? "").includes(messages.session.tryAgain));
  if (!found) throw new Error("no Try again button on screen");
  return found as HTMLButtonElement;
}

export { messages };
