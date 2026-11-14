/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import type { EngineMessage, ScreenerWaitingWire } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OhmailEngine, MemoryMirrorStore, type SyncChange } from "@ohmail/client-engine";
import type { ShellConsentFacts } from "@ohmail/app-logic/press/consent-options";
import {
  ISO, act, answerConsentWith, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell.js";

const NOW = new Date("2026-09-26T09:00:00.000Z");
let seq = 0;

function held(id: string, from: string): EngineMessage {
  return {
    id, accountId: "acct_live_1", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: "2026-09-26T08:00:00.000Z", folder: "ohmail/Screener", snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-26T08:00:00.000Z",
  };
}

const FIRST: ScreenerWaitingWire = {
  items: [held("m0", "a@one.test"), held("m1", "b@one.test")].map((m) => ({
    messageId: m.id, address: m.from.address, name: null, receivedAt: m.date!, subject: m.subject, snippet: m.snippet, mailboxId: "mb",
  })),
  nextCursor: "n", total: 250, inFlight: [],
};
const ONWARD: ScreenerWaitingWire = {
  items: [{ messageId: "far", address: "far@away.test", name: "Far", receivedAt: "2026-01-01T08:00:00.000Z", subject: "An old note", snippet: "old", mailboxId: "mb" }],
  nextCursor: null, total: null, inFlight: [],
};

type Door = "answers" | "refuses" | "none";

async function engineWith(door: Door, given?: MemoryMirrorStore): Promise<OhmailEngine> {
  const store = given ?? new MemoryMirrorStore();
  if (!given) {
    await store.load();
    await store.applyChanges([held("m0", "a@one.test"), held("m1", "b@one.test")].map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })));
  }
  return new OhmailEngine({
    store, now: () => NOW,
    adapter: {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString() }),
      mutate: async () => ({ changes: [], seq: null }),
      fetchBody: async () => null,
      ...(door === "none" ? {} : {
        screenerWaiting: async (p?: { cursor?: string }) => {
          if (door === "refuses") throw new Error("offline");
          return p?.cursor ? ONWARD : FIRST;
        },
      }),
    } as never,
  });
}

let host: HTMLElement;

function setUp() {
  installShellEnv();
  vi.setSystemTime(NOW);
}
beforeEach(() => {
  window.localStorage.clear();
  setUp();
});
afterEach(teardownShellEnv);

interface Over { store: MemoryMirrorStore; consent: ShellConsentFacts }

async function mount(
  door: Door,
  degrade: { state: "unread" | "unstated"; holderName: string | null } | null = null,
  locale: "en" | "de" = "en",
  over?: Over,
) {
  const windowFacts = over?.consent;
  answerConsentWith({
    dormancyDays: windowFacts?.dormancyDays ?? 60,
    screeningBaselineAt: windowFacts?.screeningBaselineAt ?? null,
    screeningScope: windowFacts?.screeningScope ?? "window",
    screeningByMailbox: windowFacts ? windowFacts.screeningByMailbox : {
      mb: {
        baselineAt: null, dormancyDays: 60, scope: "window", source: degrade?.state ?? "organizer",
        holder: degrade?.holderName ? { name: degrade.holderName } : null,
      },
    },
  });
  window.location.hash = "#/screener";
  const engine = await engineWith(door, over?.store);
  host = await mountShell([mailbox({
    id: "mb", lastSyncAt: ISO,
    organizerRole: degrade ? "reader" : "organizer",
    organizeConsentedAt: ISO,
    organizedBy: degrade ? { kind: "cloud", name: degrade.holderName, since: ISO } : null,
  })], { engine, locale, suggestWire: "none", junkWire: "none" });
  await tick(50);
}

const text = (): string => host.textContent ?? "";

describe("the Screener head says why its count is the folder whole", () => {
  function expectWaiting(locale: "en" | "de" = "en") {
    const sections = within(host).getByRole("group", { name: locale === "en" ? "Screener sections" : "Screener-Bereiche" });
    expect(within(sections).getByRole("button", {
      name: locale === "en" ? "Waiting 250" : "Wartend 250", pressed: true,
    })).toBeTruthy();
  }

  async function expectNotice(line: string, title = "Everyone in the Screener folder is shown",
    moreName = "More that needs you here") {
    const screen = within(host);
    const notice = () => screen.queryAllByRole("status").find((node) => node.textContent?.startsWith(title));
    if (!notice()) {
      await act(async () => { screen.getByRole("button", { name: moreName }).click(); });
      await act(async () => { screen.getByRole("menuitem", { name: title }).click(); });
    }
    expect(notice()?.textContent).toBe(`${title} ${line}`);
  }

  it("unstated, naming the holder", async () => {
    await mount("answers", { state: "unstated", holderName: "Studio Mac" });
    expectWaiting();
    await expectNotice("Studio Mac runs an older ohmail that does not share its screening settings.");
  });

  it("unread, naming the holder", async () => {
    await mount("answers", { state: "unread", holderName: "Studio Mac" });
    expectWaiting();
    await expectNotice("Studio Mac has not shared its screening settings yet.");
  });

  it("with no name for the holder, the organizing device", async () => {
    await mount("answers", { state: "unread", holderName: null });
    expectWaiting();
    await expectNotice("The ohmail that organizes this mailbox has not shared its screening settings yet.");
  });

  it("in German", async () => {
    await mount("answers", { state: "unstated", holderName: "Studio Mac" }, "de");
    expectWaiting("de");
    await expectNotice("Auf Studio Mac läuft ein älteres ohmail, das seine Screening-Einstellungen nicht teilt.", "Alle Absender im Screener-Ordner werden angezeigt", "Mehr, das dich hier braucht");
  });

  it("CONTROL: every window stated — the count alone", async () => {
    await mount("answers", null);
    expectWaiting();
    const screen = within(host);
    const title = "Everyone in the Screener folder is shown";
    expect(screen.queryAllByRole("status").some((status) => status.textContent?.startsWith(title))).toBe(false);
    const more = screen.queryByRole("button", { name: "More that needs you here" });
    if (more) {
      await act(async () => { more.click(); });
      expect(screen.queryByRole("menuitem", { name: title })).toBeNull();
    }
  });
});

describe("the shell partitions with each mailbox's window, and never whose it is", () => {
  it("shellConsentOptions carries the map's windows alone; no map, no key", async () => {
    const { shellConsentOptions } = await import("@ohmail/app-logic/press/consent-options");
    const base = {
      known: true, standalone: false, dormancyDays: 60, screeningBaselineAt: null,
      screeningScope: "window" as const, foldersEnabled: false,
    };
    const withMap = shellConsentOptions({
      ...base,
      screeningByMailbox: { mb: { baselineAt: null, dormancyDays: 30, scope: "window", source: "organizer", holderName: "Studio Mac" } },
    }, NOW, []);
    expect(withMap.byMailbox).toEqual({ mb: { baselineAt: null, dormancyDays: 30, scope: "window" } });
    expect("byMailbox" in shellConsentOptions({ ...base, screeningByMailbox: null }, NOW, [])).toBe(false);
  });
});

describe("a held letter is dated by its arrival, as the gate dated it", () => {
  it("an old Date received now waits, read or unread; one received before the window does not; a remount says the same", async () => {
    const { writeBootCache, readBootCache } = await import("@ohmail/app-logic/session/boot-cache");
    const { CONSENT_BOOT_SCOPE } = await import("@ohmail/app-logic/consent/consent-state");
    const JUNE = "2026-06-02T09:00:00.000Z";
    const letter = (id: string, from: string, unread: boolean, sortAt: string): EngineMessage =>
      ({ ...held(id, from), date: JUNE, unread, sortAt });
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges([
      letter("u1", "udo@arrived.test", true, "2026-09-26T08:30:00.000Z"),
      letter("o1", "olga@arrived.test", false, "2026-09-26T08:30:00.000Z"),
      letter("j1", "june@received.test", true, JUNE),
    ].map((m): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })));
    // The account's answer as the boot cache holds it: 60 days from a baseline of 1 September.
    writeBootCache(CONSENT_BOOT_SCOPE, "acct", { v: 1, seedConfirmedAt: null, dormancyDays: 60, screeningBaselineAt: "2026-09-01T00:00:00.000Z" });
    const consent = (): ShellConsentFacts => {
      const c = readBootCache(CONSENT_BOOT_SCOPE, "acct", (p) => p as { dormancyDays: number; screeningBaselineAt: string | null })!;
      return { known: true, standalone: false, dormancyDays: c.dormancyDays, screeningBaselineAt: c.screeningBaselineAt,
        screeningScope: "window", foldersEnabled: false, screeningByMailbox: null };
    };
    for (const pass of ["first", "remount"]) {
      await mount("none", null, "en", { store, consent: consent() });
      expect(text(), pass).toContain("udo@arrived.test");
      expect(text(), pass).toContain("olga@arrived.test");
      expect(text(), pass).not.toContain("june@received.test");
      await teardownShellEnv();
      setUp();
    }
  });
});
