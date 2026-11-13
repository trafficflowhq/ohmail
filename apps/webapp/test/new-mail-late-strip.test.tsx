/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import type { MailboxFacts } from "../app/shell/mail-state";
import { setActiveFormatZone } from "../app/shell/locale";

/**
 * NEW MAIL IS LATE, SAID WHERE A PERSON LOOKS FOR NEW MAIL. For 26 hours the service fetched no
 * mailbox while the server answered and every app looked healthy. The server now says so on each
 * mailbox row (`fetching`), and the strip says it: here the real provider reads a probe and the
 * real strip draws what it derives, so the notice arrives and leaves with the server's word.
 *
 * Mutations watched red: the strip's `behind` arm removed (every "says" case reads the first-sync
 * sentence); the ladder's arm removed (nothing is drawn); `managed` ignored (the self-hosted cases
 * say Cloud); `behind` out of the offline set (the offline case); the day test `>= 1` made `> 1`
 * (the day case); a role test added to the selector (the reader case).
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const NOW = new Date("2026-11-13T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

const { MemoryMirrorStore, OhmailEngine } = await import("@ohmail/client-engine");
const { FACTS_POLL_MS } = await import("../app/shell/MailStateProvider.js");

type Fetching = MailboxFacts["fetching"];
/** A healthy, synced mailbox row; `fetching` is left off the row unless a case names it. */
const row = (fetching?: Fetching, over: Partial<MailboxFacts> = {}): MailboxFacts => ({
  id: "mb_1", address: "person@example.invalid", status: "connected", errorCode: null, disabledReason: null,
  syncBlockedReason: null, syncBlockedSince: null, lastSyncAt: ago(50 * MIN),
  initialImportCompletedAt: ago(30 * 24 * HOUR), createdAt: ago(40 * 24 * HOUR),
  ...(fetching === undefined ? {} : { fetching }),
  ...over,
});

/** What `GET /mailboxes` answers next. */
let served: MailboxFacts[] = [];
let root: Root | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  setActiveFormatZone("UTC");
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  document.body.innerHTML = "";
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
  setActiveFormatZone(null);
  vi.useRealTimers();
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
};

/** The real provider over a probe, the real strip under it. `managed`: the host's own word. */
async function mount(opts: { managed?: boolean; locale?: "en" | "de"; variant?: "rail" } = {}): Promise<HTMLElement> {
  const store = new MemoryMirrorStore();
  await store.load();
  const engine = new OhmailEngine({
    store, now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async () => ({ changes: [], seq: null }),
      fetchBody: async () => null,
    } as never,
  });
  const { EngineProvider } = await import("../app/shell/engine.js");
  const { MailStateProvider } = await import("../app/shell/MailStateProvider.js");
  const { ManagedServiceContext } = await import("../app/shell/managed-service.js");
  const { SyncBar } = await import("../app/shell/SyncBar.js");
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const strip = h(SyncBar, opts.variant ? { variant: opts.variant } : null);
  const locale = opts.locale ?? "en";
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale, messages: (locale === "en" ? en : de) as never, timeZone: "UTC", now: NOW,
      children: h(ManagedServiceContext.Provider, {
        value: opts.managed ?? true,
        children: h(EngineProvider as never, {
          demo: false, engine,
          children: h(MailStateProvider as never, {
            probe: async () => structuredClone(served), mirrored: 12, children: strip,
          } as never),
        } as never),
      }),
    } as never));
  });
  await settle();
  return host;
}

/** One facts poll later. */
async function nextPoll(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(FACTS_POLL_MS + 50); });
  await settle();
}

const notice = (el: HTMLElement): HTMLElement | null => el.querySelector<HTMLElement>('[role="status"]');
const said = (el: HTMLElement): string => notice(el)?.textContent ?? "";
const tEn = createTranslator({ locale: "en", messages: en as never, namespace: "sync" as never }) as unknown as
  (key: string, values?: Record<string, string | number>) => string;
const tDe = createTranslator({ locale: "de", messages: de as never, namespace: "sync" as never }) as unknown as
  (key: string, values?: Record<string, string | number>) => string;

describe("the strip says new mail is late, for as long as the server says so", () => {
  it("arrives within one read of the mailboxes and leaves when fetching runs again", async () => {
    served = [row({ behind: true, since: ago(50 * MIN) })];
    const el = await mount();
    expect(said(el)).toContain(tEn("behindTitle"));
    expect(said(el)).toContain(tEn("behindLineCloud", { hasSince: "yes", since: "11:10" }));

    served = [row({ behind: false, since: ago(1 * MIN) })];
    await nextPoll();
    expect(notice(el), "the notice stayed after the server said fetching runs").toBeNull();
    expect(el.textContent ?? "", "an all-clear sentence was drawn").toBe("");

    served = [row({ behind: true, since: ago(51 * MIN) })];
    await nextPoll();
    expect(said(el)).toContain(tEn("behindTitle"));
  });

  it.each([
    ["null: this server does not say", null],
    ["absent: an older server", undefined],
    ["not behind", { behind: false, since: ago(1 * MIN) }],
  ] as Array<[string, Fetching | undefined]>)("says nothing for %s", async (_what, fetching) => {
    served = [row(fetching)];
    const el = await mount();
    await nextPoll();
    expect(notice(el)).toBeNull();
    expect(el.textContent ?? "").toBe("");
  });

  it("is a calm status with nothing to press and no way to dismiss it, in both placements", async () => {
    served = [row({ behind: true, since: ago(50 * MIN) })];
    for (const variant of [undefined, "rail"] as const) {
      const el = await mount(variant ? { variant } : {});
      expect(notice(el), "not a status region").not.toBeNull();
      expect(el.querySelector('[role="alert"]')).toBeNull();
      expect(el.querySelectorAll("a, button, [role='button']")).toHaveLength(0);
      // Standing still: nothing is running, so nothing spins.
      expect(el.querySelector('[role="progressbar"], svg')).toBeNull();
      await act(async () => { root!.unmount(); });
      root = null;
    }
  });

  it("with no time on record it says so without one", async () => {
    served = [row({ behind: true, since: null })];
    const el = await mount();
    expect(said(el)).toContain(tEn("behindTitle"));
    expect(said(el)).toContain(tEn("behindLineCloud", { hasSince: "no", since: "" }));
    expect(said(el)).not.toMatch(/since/);
  });

  it("after a day it says so plainly, and that it is on us", async () => {
    served = [row({ behind: true, since: ago(26 * HOUR) })];
    const el = await mount();
    expect(said(el)).toContain(tEn("behindTitleDays", { days: 1 }));
    expect(said(el)).toContain(tEn("behindLineCloudDay", { since: "Thu 10:00" }));
    expect(said(el)).not.toContain(tEn("behindTitle"));
  });

  it("23 hours is not yet a day, and 49 hours are two", async () => {
    served = [row({ behind: true, since: ago(23 * HOUR) })];
    expect(said(await mount())).toContain(tEn("behindTitle"));
    await act(async () => { root!.unmount(); });
    served = [row({ behind: true, since: ago(49 * HOUR) })];
    expect(said(await mount())).toContain(tEn("behindTitleDays", { days: 2 }));
  });

  it("the sentence turns to its day form by the clock alone, with the tab left open", async () => {
    served = [row({ behind: true, since: ago(23 * HOUR + 59 * MIN) })];
    const el = await mount();
    expect(said(el)).toContain(tEn("behindTitle"));
    await act(async () => { await vi.advanceTimersByTimeAsync(2 * MIN); });
    await settle();
    expect(said(el)).toContain(tEn("behindTitleDays", { days: 1 }));
  });

  it("offline, the nearer fact is said instead", async () => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => false });
    served = [row({ behind: true, since: ago(50 * MIN) })];
    const el = await mount();
    expect(said(el)).toContain(tEn("offline"));
    expect(said(el)).not.toContain(tEn("behindTitle"));
  });

  it("a mailbox's own trouble does not hide it: the rows say theirs, the strip says this", async () => {
    served = [
      row({ behind: true, since: ago(50 * MIN) }),
      row(null, { id: "mb_2", address: "second@example.invalid", status: "error", errorCode: "auth" }),
    ];
    expect(said(await mount())).toContain(tEn("behindTitle"));
  });

  /* Which mailboxes the server speaks for is the server's rule: every mailbox it is on duty to
     fetch, also one it reads for another organizer, and none it has left out. The strip has no
     role test of its own and draws each row as given. */
  it("a mailbox the server reads for another organizer is late like any other, and silent once the server leaves it out", async () => {
    const reader = { organizerRole: "reader" as const };
    served = [row({ behind: true, since: ago(50 * MIN) }, reader)];
    const el = await mount();
    expect(said(el)).toContain(tEn("behindTitle"));
    expect(said(el)).toContain(tEn("behindLineCloud", { hasSince: "yes", since: "11:10" }));
    // Past the server's capacity it is off the roster, and the server takes its word off the row.
    served = [row(null, { ...reader, syncBlockedReason: "at_capacity", syncBlockedSince: ago(MIN) })];
    await nextPoll();
    expect(el.textContent ?? "").not.toContain(tEn("behindTitle"));
  });

  it("is German in German", async () => {
    served = [row({ behind: true, since: ago(50 * MIN) })];
    const el = await mount({ locale: "de" });
    expect(said(el)).toContain(tDe("behindTitle"));
    expect(said(el)).toContain(tDe("behindLineCloud", { hasSince: "yes", since: "11:10" }));
    expect(tDe("behindTitle")).not.toBe(tEn("behindTitle"));
  });
});

describe("a self-hosted server is never called ohmail Cloud", () => {
  it.each([
    ["with a time", ago(50 * MIN), "11:10"],
    ["with none", null, ""],
    ["after a day", ago(26 * HOUR), "Thu 10:00"],
  ] as Array<[string, string | null, string]>)("names your ohmail server, %s", async (_what, since, stamp) => {
    served = [row({ behind: true, since })];
    for (const locale of ["en", "de"] as const) {
      const el = await mount({ managed: false, locale });
      const t = locale === "en" ? tEn : tDe;
      expect(said(el)).toContain(t("behindLineServer", { hasSince: since === null ? "no" : "yes", since: stamp }));
      expect(el.textContent ?? "", `${locale}: a self-hosted server was called Cloud`).not.toMatch(/Cloud/);
      // "On us" is said of our own service only.
      expect(said(el)).not.toContain(locale === "en" ? "on us" : "liegt an uns");
      await act(async () => { root!.unmount(); });
      root = null;
    }
  });

  it("the day still shows in the title", async () => {
    served = [row({ behind: true, since: ago(26 * HOUR) })];
    expect(said(await mount({ managed: false }))).toContain(tEn("behindTitleDays", { days: 1 }));
  });
});
