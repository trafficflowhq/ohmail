/**
 * THE REAL SHELL, MOUNTED — the harness the live-walk guards share.
 *
 * Three of the six findings from the 2026-08-04 production walk are about
 * what the SHIPPED shell puts on screen: a strip's sentence, the chrome in the top bar, and a
 * pane that renders headings with nothing under them. None of them can be proven by mounting
 * the component that owns the string — that is precisely how each one shipped. So each guard
 * mounts `AppShell` itself, behind the providers the Cloud entry uses, against a driven
 * `/sync` and a real mailbox probe.
 *
 * Extracted rather than copied a third time: `sync-progress.test.ts` and
 * `sync-visible.test.ts` each carry their own version of this, and the two have already
 * drifted (one stubs `CSS.escape`, the other does not). A fourth copy would be a fourth
 * opinion about what "the shell" means.
 *
 * ── HARNESS ACCOMMODATIONS, STATED ──────────────────────────────────────────────────────
 *
 * React as a global and `NEXT_PUBLIC_API_BASE` before any dynamic import, for the reasons
 * `sync-liveness-shell.test.ts` sets out. `matchMedia`, `CSS.escape`, `scrollIntoView` and
 * `IntersectionObserver` are jsdom gaps, stubbed at their narrowest: `matches: false` is the
 * desktop layout, and an observer that never fires means nothing marks itself seen by
 * scrolling, which is right for a document nobody has scrolled.
 *
 * **`matches: false` is a real limitation and the guard says so where it matters.** jsdom
 * evaluates no CSS at all, so no test here can observe a media query taking effect. What these
 * guards assert instead is the pair that a media query needs in order to work: the rule exists
 * and is spelled correctly, and its selector really does match the element it names.
 */
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { vi } from "vitest";
import type { OhmailEngine } from "@ohmail/client-engine";
import type { OwnerResolver } from "../../app/shell/engine";
import messages from "../../messages/en.json";
import messagesDe from "../../messages/de.json";
import type { MailboxFacts } from "../../app/shell/mail-state";
import type { ConsentTransport } from "../../app/shell/consent-state";
import { settleFirstPaint } from "../_first-paint.js";
import { resetResumeLaneForTests } from "../../app/shell/resume-lane";

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
export const act = (React as unknown as {
  act: (cb: () => Promise<void> | void) => Promise<void>;
}).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export const ISO = "2026-08-04T09:00:00.000Z";

/** A mailbox row as the probe answers it. Defaults to "connected, never synced". */
export const mailbox = (over: Partial<MailboxFacts> = {}): MailboxFacts =>
  ({
    address: "walker@example.invalid",
    status: "connected",
    errorCode: null,
    syncBlockedReason: null,
    syncBlockedSince: null,
    lastSyncAt: null,
    createdAt: ISO,
    ...over,
  }) as MailboxFacts;

let seq = 0;

/** One real-shaped row; the views read `from.address`, `subject` and `folder` for real. */
const message = (id: string, folder: string, n: number) => ({
  type: "message", op: "create", id, seq: n, updatedAt: ISO,
  entity: {
    id, accountId: "acct_live_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
    subject: `subject of ${id}`,
    from: { name: `Sender ${id}`, address: `${id}@example.invalid` },
    to: [], cc: [], date: ISO, folder, snippet: `snippet of ${id}`,
    unread: true, hasAttachments: false, attachmentCount: 0, sensitivity: {},
    triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
  },
});

/**
 * A rule — the record of a screening decision about one sender.
 *
 * The shell presents mail by WHO SENT IT, so since the consent model an account with no rules
 * has decided about nobody and every undecided INBOX message presents in the Screener instead
 * of the Ohbox. That is right for an account that has not been through onboarding, and it is
 * not the account these walks are about: they mount a settled mailbox with mail in its piles.
 * So `page` emits one rule per sender it invents, which makes the fixture an ONBOARDED account
 * rather than a virgin one — the difference the model draws, spelled in the data.
 */
const rule = (address: string, n: number) => ({
  type: "rule", op: "create", id: `rule_${address}`, seq: n, updatedAt: ISO,
  entity: {
    id: `rule_${address}`, kind: "sender", match: address, destination: "INBOX", priority: 0,
    provenance: "seeded-from-sent", enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
  },
});

/** A `/sync` page of `n` new messages in `folder`, with a fresh cursor so the engine advances. */
export const page = (n: number, folder = "INBOX"): Response => {
  const rows = Array.from({ length: n }, () => message(`m${++seq}`, folder, seq));
  // Consent for exactly the senders this page invents. Emitted alongside rather than in a
  // second page, because a message whose sender's rule has not arrived yet would spend one
  // render in the Screener and the walks assert on the frame after the drain.
  //
  // ONLY for a page filed into the INBOX. A page addressed to `ohmail/Screener` is mail from
  // people nobody has screened, which is what a caller asking for one wants; consenting those
  // senders would pull it into the Ohbox and delete the state under test.
  const creates = folder === "INBOX"
    ? [...rows, ...rows.map((m) => rule(m.entity.from.address, ++seq))]
    : rows;
  return new Response(
    JSON.stringify({
      changes: { creates, updates: [], moves: [], deletes: [] },
      cursor: `c${seq}`, hasMore: false, serverTime: ISO,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

const emptyPage = (): Response => page(0);

/** What `/sync` answers next. Set before `mountShell` to start an account with mail in it. */
let answer: () => Response = emptyPage;
export function answerSyncWith(next: () => Response): void {
  answer = next;
}

/**
 * The `GET /consent` body the next mounts see, MERGED over the fixture's onboarded default —
 * `answerSyncWith`'s shape for the same reason: a walk about a consent-gated surface (the
 * folders foundation's "Use folders" flag) has to be able to say what the account stored,
 * and duplicating the whole default body at every call site is how one field of it drifts.
 * Reset by `installShellEnv`, so no walk inherits another's account.
 */
export function answerConsentWith(over: Record<string, unknown>): void {
  consentOver = over;
}

let roots: Root[] = [];
let originalFetch: typeof globalThis.fetch;

type Served = { id: string; date: string | null };
/** Every message `/sync` has served this mount, by id — the harness's store. */
let served = new Map<string, Served>();
/** Rows only the store holds (older than any window), and bodies the body route answers. */
let storeOnly: Served[] = [];
let storeBodies: Record<string, string> = {};
/** Put rows in the store that `/sync` never serves, with their bodies — History's reach. */
export function answerStoreWith(rows: Served[], bodies: Record<string, string> = {}): void {
  storeOnly = rows;
  storeBodies = bodies;
}
/** A `/sync` answer is handed back untouched — a walk may hand a held PROMISE in its place. */
function remember(res: Response): Response {
  void Promise.resolve(res).then((r) => r.clone().json()).then((j: { changes?: { creates?: Array<{ type?: string; id: string; entity?: Served | null }>; deletes?: Array<{ type?: string; id: string }> } }) => {
    for (const ch of j?.changes?.creates ?? []) if (ch.type === "message" && ch.entity) served.set(ch.id, ch.entity);
    for (const ch of j?.changes?.deletes ?? []) if (ch.type === "message") served.delete(ch.id);
  }, () => undefined);
  return res;
}
const newestFirst = (a: Served, b: Served): number =>
  (b.date ?? "").localeCompare(a.date ?? "") || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
function storeAnswer(url: string): Response | null {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const body = /\/messages\/([^/?]+)\/body/.exec(url);
  if (body && storeBodies[decodeURIComponent(body[1]!)] !== undefined) {
    return json({ text: storeBodies[decodeURIComponent(body[1]!)], html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null });
  }
  const rows = [...served.values(), ...storeOnly.filter((m) => !served.has(m.id))].sort(newestFirst);
  if (url.includes("/messages/timeline")) {
    const months: Array<{ month: string; count: number; first: { date: string | null; id: string } }> = [];
    let undated = 0;
    for (const m of rows) {
      if (m.date === null) { undated += 1; continue; }
      const last = months[months.length - 1];
      if (last?.month === m.date.slice(0, 7)) last.count += 1;
      else months.push({ month: m.date.slice(0, 7), count: 1, first: { date: m.date, id: m.id } });
    }
    return json({ total: rows.length, months, undated });
  }
  if (!url.includes("/messages?") || !url.includes("view=all")) return null;
  const q = new URL(url, "https://harness.invalid").searchParams;
  const bid = q.get("beforeId");
  const bdate = q.get("beforeDate");
  const below = bid === null ? rows : rows.filter((m) => (bdate === null
    ? m.date === null && m.id < bid
    : m.date === null || m.date < bdate || (m.date === bdate && m.id < bid)));
  return json({ items: below.slice(0, Number(q.get("limit") ?? 50)), nextCursor: null });
}
let consentOver: Record<string, unknown> = {};

/** Install the jsdom gaps and pin the clock. Call from `beforeEach`. */
export function installShellEnv(): void {
  vi.useFakeTimers();
  // The resume lane is tab state: each case starts cold, on its own clock (older-store's too).
  resetResumeLaneForTests();
  vi.setSystemTime(new Date(ISO));
  window.location.hash = "";
  originalFetch = globalThis.fetch;
  served = new Map();
  storeOnly = [];
  storeBodies = {};
  seq = 0;
  answer = emptyPage;
  consentOver = {};
  globalThis.fetch = vi.fn(async (input: unknown) => {
    /**
     * THE BOOTSTRAP'S RULES-FIRST PASS (`?types=rule`), answered empty and NEVER with
     * `answer()`. The snapshot ask below lands on `answer()` (a `/sync` body with no `asOfSeq`,
     * which the adapter refuses), so a cold walk takes the degraded `since=0` path — and that
     * path now opens with one rules-only drain so decisions land before the mail they govern
     * (`bootstrap-rules-first.test.ts` owns the claim). Handing THAT ask `answer()` would mint a
     * second page of fresh ids per mount and double every row count. Empty is also the honest
     * filtered answer here: `page()` already emits each page's rules beside its messages, so the
     * walks' consent semantics are unchanged. The engine's own drain carries no `types=` at all,
     * so this cannot swallow a counted page.
     */
    if (String(input).includes("types=rule")) return page(0);
    if (String(input).includes("/sync")) return remember(answer());
    /* THE STORE'S DOORS (ARCHIVE-024), answered from the mail this harness has served: History's
       timeline and its pages are what the server holds, which here is what `/sync` handed out. */
    const store = storeAnswer(String(input));
    if (store !== null) return store;
    // The consent state, answered properly rather than by the catch-all below.
    //
    // The shell partitions mail by who sent it, and it refuses to do so until the server has
    // told it the dormancy window — so a mock that answers every url with `{}` leaves the
    // partition switched off and these walks silently stop covering it. This says what the
    // fixtures are: an ONBOARDED account (the review has been answered) on the default window.
    if (String(input).includes("/consent")) {
      return new Response(
        JSON.stringify({
          seedConfirmedAt: ISO, screeningResetAt: null, dormancyDays: 60,
          counts: { decidedSenders: 0, activeUndecidedSenders: 0, dormantUndecidedSenders: 0 },
          ...consentOver,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
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
    takeRecords(): [] {
      return [];
    }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
}

/** Tear the mounts down and restore the globals. Call from `afterEach`. */
export async function teardownShellEnv(): Promise<void> {
  for (const root of roots) await act(() => root.unmount());
  roots = [];
  document.body.innerHTML = "";
  globalThis.fetch = originalFetch;
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  resetResumeLaneForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
}

export async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * The shipped shell, live, wrapped in exactly what the Cloud entry wraps it in.
 *
 * `resolveOwner` is overridable because the SESSION GATE is a surface too. It answers instantly
 * by default — which is what every guard written before this wanted, and which makes the gate
 * unobservable — and a test about a slow connection has to be able to hold it open. Additive:
 * every existing caller passes one argument and gets exactly the behaviour it had.
 */
export async function mountShell(
  facts: MailboxFacts[],
  opts: {
    resolveOwner?: OwnerResolver;
    /**
     * THE MAILBOX PROBE ITSELF, overriding the instant `async () => facts` every existing
     * caller gets. Added for the boot-cache guards, which need `GET /mailboxes` to be a round
     * trip that has not answered yet — an instant probe makes the boot window unobservable,
     * exactly as an instant `resolveOwner` made the session gate unobservable. Additive: absent
     * means the old behaviour, and `facts` is ignored only when this is passed.
     */
    probe?: () => Promise<MailboxFacts[]>;
    /**
     * AN ENGINE THE CALLER BUILT — the desktop app's seam, and the only way to mount this shell
     * on a build with no API base.
     *
     * Absent (every caller written before this) is unchanged: `EngineProvider` builds the live
     * network engine from `NEXT_PUBLIC_API_BASE`, which this file pins. A caller that clears that
     * variable MUST pass one, because `createEngine` throws `EngineUnarmedError` rather than
     * serve fixtures to a live account — which is the same reason the standalone tier hands its
     * engine in rather than letting the provider choose.
     *
     * A TYPE-ONLY import, so this fixture still pulls no client-engine code into its module
     * graph — and typed rather than `unknown`, because `apps/webapp` typechecks its tests and
     * an `unknown` here is an `any` at the call site of the one prop that decides whether the
     * shell talks to a network.
     */
    engine?: OhmailEngine;
    /**
     * THE LOCALE THIS SHELL RENDERS IN. Default "en", which is every caller written before
     * this. A copy guard about a German window has no other way to see the shipped control:
     * the words come from the catalogue through `NextIntlClientProvider`, and that provider is
     * built here.
     */
    locale?: "en" | "de";
    /** A HOST'S CONSENT WIRE — the desktop's hosted and paired doors pass one. Absent is the Cloud client. */
    consentTransport?: ConsentTransport;
    /** The host's providers between the toast host and `AppShell` — the Cloud's locale seam. Absent: none. */
    wrap?: (shell: React.ReactElement) => React.ReactElement;
  } = {},
): Promise<HTMLElement> {
  const { AppShell } = await import("../../app/shell/AppShell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const { localStorageDoor } = await import("../../app/shell/durable.js");

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);

  const props = {
    demo: false,
    resolveOwner: opts.resolveOwner
      ?? (async () => ({ kind: "owner", accountId: "acct_live_1" }) as const),
    mailboxFacts: opts.probe ?? (async (): Promise<MailboxFacts[]> => facts),
    ...(opts.engine ? { engine: opts.engine } : {}),
    ...(opts.consentTransport ? { consentTransport: opts.consentTransport } : {}),
  };

  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: opts.locale ?? "en",
        messages: opts.locale === "de" ? messagesDe : messages,
        timeZone: "UTC",
        now: new Date(ISO),
        children: h(ThemeProvider, {
          // the product door's shape: the face axis is ACTIVE here and only here, and the
          // appearance persists through the same durable door `(product)/providers.tsx` passes —
          // without it the provider is `unpersisted` and every device pin here is a memory.
          faces: true,
          storage: localStorageDoor("theme"),
          children: h(ToastHost, { children: (opts.wrap ?? ((s) => s))(h(AppShell, props)) }),
        }),
      }),
    );
    await Promise.resolve();
  });
  await tick(0);
  await settleFirstPaint();
  return container;
}

/** Move to a view the way the product does — the hash IS the route. */
export async function goTo(view: string): Promise<void> {
  await act(async () => {
    window.location.hash = `#/${view}`;
    window.dispatchEvent(new Event("hashchange"));
    await vi.advanceTimersByTimeAsync(0);
  });
  // The lazy Settings/Compose chunks and the deferred Screener derivation both settle here.
  await settleFirstPaint();
}

export const textOf = (el: HTMLElement): string => el.textContent ?? "";
