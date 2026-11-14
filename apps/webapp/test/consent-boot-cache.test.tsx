/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ISO, act, answerSyncWith, goTo, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { bootCacheKey } from "@ohmail/app-logic/session/boot-cache";
import { CONSENT_BOOT_SCOPE, useConsentState, type ConsentTransport } from "../app/shell/consent-state";
import { resetStorageOwnerForTest, setDemoStorage, setStorageOwner } from "@ohmail/app-logic/storage/storage-owner";

/**
 * BOOT PRESENTS THE CURRENT STATE, NOT THE RAW PILES — the reload-resurrection guard.
 *
 * ── THE DEFECT, AS SEEN ON THE HOSTED SERVICE (2026-08-12) ────────────────────────────────
 *
 * On every reload the Screener showed the same set of already-decided senders and held them
 * until they "drained away". The mirror was never stale — it hydrates from IndexedDB with every
 * decision in it — and the drain was never the fixer: with `GET /consent` artificially delayed
 * for long seconds against the live app, the stale rows survived THREE completed `/sync` drains untouched
 * and collapsed within moments of the consent answer arriving. The real mechanism: the consent
 * partition is keyed on two server-held scalars (`dormancyDays`, `screeningBaselineAt`), and
 * until they arrived `AppShell` presented the RAW mirror — in which "the Screener" means "every
 * sender whose mail physically sits in `ohmail/Screener`", a set that includes every decided
 * sender for ever, because a decision writes a rule and deliberately moves no mail. A raw view
 * over a stable mirror is the same wrong rows on every boot.
 *
 * The fix is `boot-cache.ts`: the boot applies the account's own cached last answer before the
 * fetch, and the fetch overwrites both the state and the cache. These guards pin every edge of
 * that seam. The fixture worlds reuse `screener-cutline.test.ts`'s shapes, because the rows
 * whose presentation differs between raw and partitioned ARE the defect's visible surface.
 *
 * ── WHAT MUST STAY TRUE ELSEWHERE ─────────────────────────────────────────────────────────
 *
 * "A tab whose /consent never answers partitions NOTHING" (`screener-cutline.test.ts`) still
 * holds — for a tab with NO cache. The cache only ever replays an answer this account's server
 * really gave, so that guard and these are two halves of one rule: never a guessed window,
 * always the freshest known one.
 */

/** ISO is 2026-08-04 and the window is 60 days, so this is comfortably dormant. */
const LONG_AGO = "2024-01-11T09:00:00.000Z";
const SCREENER = "ohmail/Screener";
const OWNER = "acct_live_1";

const message = (o: {
  id: string; from: string; folder?: string; unread?: boolean; date?: string;
}, seq: number) => ({
  type: "message", op: "create", id: o.id, seq, updatedAt: ISO,
  entity: {
    id: o.id, accountId: OWNER, mailboxId: "mb_1",
    threadId: null, messageIdHeader: null,
    subject: `subject of ${o.id}`,
    from: { name: `Sender ${o.id}`, address: o.from },
    to: [], cc: [], date: o.date ?? LONG_AGO, folder: o.folder ?? SCREENER,
    snippet: `snippet of ${o.id}`, unread: o.unread ?? false,
    hasAttachments: false, attachmentCount: 0, sensitivity: {},
    triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
  },
});

const rule = (address: string, seq: number) => ({
  type: "rule", op: "create", id: `rule_${address}`, seq, updatedAt: ISO,
  entity: {
    id: `rule_${address}`, kind: "sender", match: address, destination: "INBOX", priority: 0,
    provenance: "seeded-from-sent", enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
  },
});

/**
 * The three sender shapes whose presentation separates raw from partitioned:
 *  · `loud1`   — active undecided at the gate. A queue row under BOTH readings (the control).
 *  · `known1`  — DECIDED, mail still physically at the gate. Raw: a queue row (the resurrected
 *                ghost that was reported dozens of times). Partitioned: presents in the Ohbox.
 *  · `dorm1`   — dormant undecided. Raw: a queue row. Partitioned: History.
 */
const world = (): Response =>
  new Response(
    JSON.stringify({
      changes: {
        creates: [
          message({ id: "loud1", from: "loud@example.invalid", unread: true }, 1),
          message({ id: "known1", from: "friend@example.invalid" }, 2),
          rule("friend@example.invalid", 3),
          message({ id: "dorm1", from: "quiet@example.invalid" }, 4),
        ],
        updates: [], moves: [], deletes: [],
      },
      cursor: "c1", hasMore: false, serverTime: ISO,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const rowIds = (c: HTMLElement): string[] =>
  [...c.querySelectorAll(".row[data-id]")].map((n) => n.getAttribute("data-id") ?? "");

/** A valid cached answer, as the previous session's successful fetch would have written it. */
const seedConsentCache = (owner: string, over: Record<string, unknown> = {}): void => {
  window.localStorage.setItem(
    bootCacheKey(CONSENT_BOOT_SCOPE, owner),
    JSON.stringify({
      v: 1, seedConfirmedAt: ISO, dormancyDays: 60, screeningBaselineAt: null, ...over,
    }),
  );
};

/** Replace the harness's instant /consent answer with one that never arrives — the boot window. */
const holdConsent = (): void => {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/consent")) return new Promise<Response>(() => {});
    return inner(input as RequestInfo, init);
  }) as typeof globalThis.fetch;
};

const clearIdentity = (): void => {
  document.cookie = "tf_owner=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
  window.localStorage.clear();
};

describe("boot presents the partitioned piles from the account's cached answer", () => {
  beforeEach(() => {
    installShellEnv();
    clearIdentity();
    answerSyncWith(world);
  });
  afterEach(async () => {
    await teardownShellEnv();
    clearIdentity();
  });

  it("THE BUG: a cached answer partitions the Screener before /consent ever answers", async () => {
    document.cookie = `tf_owner=${OWNER}`;
    seedConsentCache(OWNER);
    holdConsent();

    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("screener");

    const ids = rowIds(c);
    // The control: a genuinely undecided active sender queues under both readings.
    expect(ids).toContain("loud1");
    // The resurrection: a DECIDED sender whose mail still physically sits at the gate must not
    // be asked about again at boot — this is the row that reappeared on every reload.
    expect(ids).not.toContain("known1");
    // And the dormant sender is History's business, not the queue's.
    expect(ids).not.toContain("dorm1");

    await goTo("history");
    expect(rowIds(c)).toContain("dorm1");
  });

  it("a fresh answer writes the cache the next boot will read", async () => {
    document.cookie = `tf_owner=${OWNER}`;
    // No seed: this session is the one that earns the cache. The harness answers /consent with
    // seedConfirmedAt: ISO and dormancyDays: 60 (`installShellEnv`).
    await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);

    const raw = window.localStorage.getItem(bootCacheKey(CONSENT_BOOT_SCOPE, OWNER));
    expect(raw).not.toBeNull();
    // `foldersEnabledAt` joined the row with the folders foundation (FOLDERS-SPEC.md §6): the
    // "Use folders" flag gates CHROME over data the mirror already holds — no spend, no send,
    // no content fetch — so caching it is inside the authorisation boundary this file watches.
    // The two that stay out (`autoSuggest`, `blockRemoteImages`) are asserted below unchanged.
    expect(JSON.parse(raw!)).toEqual({
      v: 1, seedConfirmedAt: ISO, dormancyDays: 60, screeningBaselineAt: null,
      foldersEnabledAt: null,
    });
  });

  it("an answer cached for ANOTHER account is never applied", async () => {
    document.cookie = `tf_owner=${OWNER}`;
    seedConsentCache("somebody_else_entirely");
    holdConsent();

    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("screener");

    // No answer for THIS account ⇒ unpartitioned, exactly as a cacheless tab: the raw queue,
    // decided and dormant senders included. Showing MORE is the safe direction; showing another
    // account's window would be a guess wearing a cache's clothes.
    const ids = rowIds(c);
    expect(ids).toContain("known1");
    expect(ids).toContain("dorm1");
  });

  it("with no remembered account the cache is not consulted at all", async () => {
    // A cache row exists (this browser held the account before) but the `tf_owner` cookie is gone and
    // no host named the window — a cleared cookie jar. No key ⇒ no read.
    seedConsentCache(OWNER);
    holdConsent();

    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("screener");

    expect(rowIds(c)).toContain("known1");
  });

  it("a malformed cache degrades to 'no cache', never to a wrong value", async () => {
    document.cookie = `tf_owner=${OWNER}`;
    // The window as a STRING — the shape an older or foreign writer would leave. Applying it
    // would put "60" into date arithmetic; the validator must refuse the row instead.
    seedConsentCache(OWNER, { dormancyDays: "60" });
    holdConsent();

    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("screener");

    expect(rowIds(c)).toContain("known1");
  });

  /**
   * THE AUTHORISATION BOUNDARY, at the hook itself. `known: true` from the cache must arm
   * NOTHING: `autoSuggest` spends the account's credits and `blockRemoteImages: false` loads a
   * sender's content, and a cache is one session stale by construction — the account may have
   * revoked either in between. Both keep their safe resting values until the live answer, which
   * is exactly what a cacheless tab has always shown for the same interval. This is the test
   * that goes red if `ConsentBootCache` ever grows a convenience field.
   */
  it("the cache never authorises: spending stays off and images stay manual", async () => {
    document.cookie = `tf_owner=${OWNER}`;
    seedConsentCache(OWNER);
    holdConsent();

    const captured: { current: ReturnType<typeof useConsentState> | null } = { current: null };
    function Probe(): null {
      captured.current = useConsentState(true);
      return null;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    await tick(0);

    // The cache landed — the partition inputs are known before the server has said a word…
    expect(captured.current!.known).toBe(true);
    expect(captured.current!.dormancyDays).toBe(60);
    expect(captured.current!.seedConfirmedAt).toBe(ISO);
    // …and it armed nothing.
    expect(captured.current!.autoSuggest).toBe(false);
    expect(captured.current!.blockRemoteImages).toBe(true);

    await act(() => root.unmount());
  });

  /**
   * THE OTHER NETWORK-DEPENDENT PARTITION INPUT. With the window cached, the partition runs at
   * boot — and with `GET /mailboxes` still in flight an empty own-set would present the user's
   * own recent self-mail in their own Screener for the whole round trip. The remembered
   * addresses close that window; `facts` still wins the moment it lands.
   */
  it("the boot uses the remembered own addresses while /mailboxes is a round trip away", async () => {
    document.cookie = `tf_owner=${OWNER}`;
    seedConsentCache(OWNER);
    window.localStorage.setItem(
      bootCacheKey("own-addresses", OWNER),
      JSON.stringify(["walker@example.invalid"]),
    );
    answerSyncWith(
      () =>
        new Response(
          JSON.stringify({
            changes: {
              creates: [
                message({ id: "loud1", from: "loud@example.invalid", unread: true }, 1),
                // The user's own note to themselves: INBOX, unread ⇒ active on the unread arm.
                // Unrecognised, this sender queues at the gate; recognised, the mail keeps its
                // place and its "sender" is never asked about.
                message({ id: "self1", from: "walker@example.invalid", folder: "INBOX", unread: true }, 2),
              ],
              updates: [], moves: [], deletes: [],
            },
            cursor: "c1", hasMore: false, serverTime: ISO,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const c = await mountShell([], { probe: () => new Promise(() => {}) });
    await tick(0);
    await goTo("screener");

    const ids = rowIds(c);
    expect(ids).toContain("loud1");
    expect(ids).not.toContain("self1");
  });

  /**
   * THE WEB'S CACHE PATH IS UNCHANGED BY THE RETRY (FIX-025): a cached answer is a known state, so
   * a failing live read is asked once and never again by the ladder, and the cached partition holds.
   */
  it("with a cached answer a failing live read is asked once, not retried", async () => {
    document.cookie = `tf_owner=${OWNER}`;
    seedConsentCache(OWNER);
    const inner = globalThis.fetch;
    let asks = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/consent")) {
        asks += 1;
        return new Response(JSON.stringify({ error: { code: "upstream_unavailable" } }), { status: 503 });
      }
      return inner(input as RequestInfo, init);
    }) as typeof globalThis.fetch;

    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await tick(400_000);
    await goTo("screener");

    expect(asks).toBe(1);
    expect(rowIds(c)).not.toContain("known1");
  });

  /**
   * SIGN-OUT FORGETS THE CACHES in the same act as the mirror and the name — and ONLY the
   * caches: per-machine chrome like the rail fold is not account data and stays.
   */
  it("sign-out drops every boot cache on the origin", async () => {
    seedConsentCache(OWNER);
    window.localStorage.setItem(bootCacheKey("own-addresses", OWNER), JSON.stringify(["a@b.invalid"]));
    window.localStorage.setItem("ohmail.ui.rail.tagsOpen", "1");

    const { signOut } = await import("../app/sign-out");
    await signOut(OWNER);

    expect(window.localStorage.getItem(bootCacheKey(CONSENT_BOOT_SCOPE, OWNER))).toBeNull();
    expect(window.localStorage.getItem(bootCacheKey("own-addresses", OWNER))).toBeNull();
    expect(window.localStorage.getItem("ohmail.ui.rail.tagsOpen")).toBe("1");
  });
});

/**
 * THE PAIRED DESKTOP HAS NO COOKIE, AND ITS HOST NAMES THE WINDOW (PAIRED-DESKTOP-SCREENER-WAITS-FOR-
 * THE-CONSENT-READ). Keyed by the cookie alone, its consent cache was never read or written, so a
 * failing read left the cutline unknown and unruled INBOX mail presenting in the Ohbox. The key is
 * `consentCacheOwner`: the cookie, else the host's identity, never the demo's.
 */
describe("the host's identity keys the consent cache where there is no cookie", () => {
  const HOST = "mb_desktop_1";
  const failing = (): ConsentTransport => ({
    foldersStorable: true,
    state: async () => { throw Object.assign(new Error("down"), { status: 503 }); },
  } as unknown as ConsentTransport);
  const answering = (): ConsentTransport => ({
    foldersStorable: true,
    state: async () => ({ seedConfirmedAt: ISO, dormancyDays: 45, screeningBaselineAt: null, autoSuggestAt: null }),
  } as unknown as ConsentTransport);

  async function hook(transport: ConsentTransport) {
    const captured: { current: ReturnType<typeof useConsentState> | null } = { current: null };
    function Probe(): null { captured.current = useConsentState(true, transport); return null; }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(React.createElement(Probe)); await Promise.resolve(); });
    for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
    return { captured, unmount: () => act(() => root.unmount()) };
  }

  beforeEach(() => { clearIdentity(); resetStorageOwnerForTest(); });
  afterEach(() => { resetStorageOwnerForTest(); clearIdentity(); });

  it("a failing read on the desktop partitions from the host-keyed answer", async () => {
    setStorageOwner(HOST);
    seedConsentCache(HOST);
    const h = await hook(failing());
    expect(h.captured.current!.known, "the cutline stayed unknown under a failing read").toBe(true);
    expect(h.captured.current!.dormancyDays).toBe(60);
    await h.unmount();
  });

  it("an answered read on the desktop writes the cache under the host's key", async () => {
    setStorageOwner(HOST);
    const h = await hook(answering());
    const row = window.localStorage.getItem(bootCacheKey(CONSENT_BOOT_SCOPE, HOST));
    expect(row && JSON.parse(row).dormancyDays).toBe(45);
    await h.unmount();
  });

  it("the demo reads no cache, whatever its host said (the control)", async () => {
    setStorageOwner(HOST);
    setDemoStorage(true);
    seedConsentCache(HOST);
    const h = await hook(failing());
    expect(h.captured.current!.known).toBe(false);
    await h.unmount();
  });
});
