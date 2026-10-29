import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryMirrorStore, OhmailEngine, type EngineMessage, type SyncChange, type SyncResponse } from "@ohmail/client-engine";
import { MOBILE_WINDOW } from "../src/engine/boot";
import { createProjector, type ProjectionInputs } from "../src/state/world-projection";
import { SCREENING_UNSUPPLIED, type WorldActions } from "../src/state/live";
import { setActiveLocale } from "../src/i18n/locale";
import { readMailboxes } from "../src/net/mailboxes";
import { screenerSegParam } from "../src/state/model";
import {
  FILED_PILE_ROUTE, FILED_SINCE_SCAN_MAX, checkedAgoSaid, filedPileSaid, ohboxVisitStep, ohboxWhereSaid,
  type FiledSince, type OhboxVisitState,
} from "../src/state/live";

/**
 * THE PHONE'S OHBOX SAYS WHEN MAIL WAS LAST CHECKED AND WHERE IT WENT (row
 * OHBOX-QUIET-READS-AS-STALLED) — the web's line in this app's own words: the facts off the mailbox
 * read, the counts off the projection, the top line's sentence when it has one, and the visit's end
 * decided by a pure step the screen drives.
 */

const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

afterEach(() => { setActiveLocale("en"); });

describe("readMailboxes carries the check facts", () => {
  const session = (rows: unknown[]) => ({
    profile: { origin: "https://srv.test", accountId: "a" },
    fetch: vi.fn(async () => ({ status: 200, json: async () => ({ items: rows }) }) as unknown as Response),
  }) as unknown as Parameters<typeof readMailboxes>[0];

  it("forwards lastSyncAt, syncBlockedSince and hostedLastSyncAt, an empty string as null", async () => {
    const out = await readMailboxes(session([
      { id: "m1", address: "a@b.test", lastSyncAt: iso(NOW - 60_000), syncBlockedSince: "", hostedLastSyncAt: null },
      { id: "m2", address: "c@d.test", lastSyncAt: "", syncBlockedSince: iso(NOW - 600_000), hostedLastSyncAt: iso(NOW) },
    ]));
    expect(out?.[0]).toMatchObject({ lastSyncAt: iso(NOW - 60_000), syncBlockedSince: null, hostedLastSyncAt: null });
    expect(out?.[1]).toMatchObject({ lastSyncAt: null, syncBlockedSince: iso(NOW - 600_000), hostedLastSyncAt: iso(NOW) });
  });

  it("adds no key the wire did not send", async () => {
    const [row] = (await readMailboxes(session([{ id: "m1", address: "a@b.test" }])))!;
    expect("lastSyncAt" in row!).toBe(false);
    expect("syncBlockedSince" in row!).toBe(false);
    expect("hostedLastSyncAt" in row!).toBe(false);
  });
});

describe("ohboxWhereSaid", () => {
  const FILED: FiledSince = { at: iso(NOW - 3_600_000), counts: [{ pile: "reads", count: 12 }, { pile: "receipts", count: 3 }] };
  const base = {
    settled: true, network: "online" as const, connection: null, stale: null, draining: false,
    mailboxes: [{ status: "connected", lastSyncAt: iso(NOW - 120_000), syncBlockedSince: null }],
    mailboxesReadAt: NOW - 5_000, nowMs: NOW, filed: FILED,
  };

  it("nothing before the mirror has settled", () => {
    expect(ohboxWhereSaid({ ...base, settled: false })).toBeNull();
  });

  it("nothing while the top line has a sentence: the top bar above the title says it once", () => {
    expect(ohboxWhereSaid({ ...base, network: "offline" })).toBeNull();
    expect(ohboxWhereSaid({ ...base, connection: { kind: "lost" } })).toBeNull();
    expect(ohboxWhereSaid({ ...base, stale: "Fri 09:00" })).toBeNull();
  });

  it("otherwise the check and the piles", () => {
    expect(ohboxWhereSaid(base)).toEqual({ kind: "where", checked: iso(NOW - 120_000), piles: FILED.counts });
    // Facts older than the bound withhold the check, never the counts.
    expect(ohboxWhereSaid({ ...base, mailboxesReadAt: NOW - 91_000 })).toEqual({ kind: "where", checked: null, piles: FILED.counts });
    expect(ohboxWhereSaid({ ...base, mailboxes: null, filed: null })).toEqual({ kind: "where", checked: null, piles: [] });
  });
});

describe("the words", () => {
  it("relative times from the deck, in English and German", () => {
    expect(checkedAgoSaid(iso(NOW - 10_000), NOW)).toBe("just now");
    expect(checkedAgoSaid(iso(NOW - 120_000), NOW)).toBe("2 minutes ago");
    expect(checkedAgoSaid(iso(NOW - 3 * 3_600_000), NOW)).toBe("3 hours ago");
    expect(checkedAgoSaid(iso(NOW - 2 * 86_400_000), NOW)).toBe("2 days ago");
    expect(filedPileSaid("screened")).toBe("Screened out");
    setActiveLocale("de");
    expect(checkedAgoSaid(iso(NOW - 120_000), NOW)).toBe("vor 2 Minuten");
    expect(checkedAgoSaid(iso(NOW - 10_000), NOW)).toBe("gerade eben");
    expect(filedPileSaid("receipts")).toBe("Belege");
  });

  it("the line names no Intl relative-time formatter", () => {
    expect(src("src/ui/OhboxWhere.tsx")).not.toMatch(/RelativeTimeFormat/);
  });
});

describe("the links", () => {
  it("each pile opens its tab, the Screener's two by its seg param", () => {
    expect(FILED_PILE_ROUTE).toEqual({
      reads: { pathname: "/(tabs)/reads" },
      receipts: { pathname: "/(tabs)/receipts" },
      screened: { pathname: "/(tabs)/screener", params: { seg: "screened" } },
      spam: { pathname: "/(tabs)/screener", params: { seg: "spam" } },
    });
    const line = src("src/ui/OhboxWhere.tsx");
    expect(line).toMatch(/accessibilityRole="link"/);
    expect(line).toMatch(/accessibilityLabel=\{text\}/);
  });

  it("the Screener follows a changed seg param while mounted", () => {
    expect(screenerSegParam("spam")).toBe("spam");
    expect(screenerSegParam("screened")).toBe("screened");
    expect(screenerSegParam("waiting")).toBe("waiting");
    expect(screenerSegParam(undefined)).toBeNull();
    expect(screenerSegParam("junk")).toBeNull();
    const screen = src("app/(tabs)/screener.tsx");
    expect(screen).toMatch(/useEffect\(\(\) => \{\s*if \(asked !== null\) setSeg\(asked\);\s*\}, \[asked\]\);/);
  });

  it("the scan bound sits inside the phone's window", () => {
    if (MOBILE_WINDOW.mode !== "windowed") throw new Error("the phone mirror is windowed");
    expect(FILED_SINCE_SCAN_MAX).toBeLessThanOrEqual(MOBILE_WINDOW.minRows);
  });
});

describe("when a visit ends", () => {
  const on: OhboxVisitState = { onOhbox: true, seenActive: true };

  it("a tab change away from a seen Ohbox is a leave, and only once", () => {
    const a = ohboxVisitStep(on, { kind: "tab", ohbox: false, active: true });
    expect(a.leave).toBe(true);
    expect(ohboxVisitStep(a.next, { kind: "tab", ohbox: false, active: true }).leave).toBe(false);
  });

  it("the background while on the Ohbox is a leave; the next active spell is a new visit", () => {
    const bg = ohboxVisitStep(on, { kind: "app", state: "background" });
    expect(bg.leave).toBe(true);
    expect(ohboxVisitStep(bg.next, { kind: "app", state: "background" }).leave).toBe(false);
    const back = ohboxVisitStep(bg.next, { kind: "app", state: "active" });
    expect(ohboxVisitStep(back.next, { kind: "app", state: "background" }).leave).toBe(true);
  });

  it("a pushed reader (no tab change) and iOS inactive are not leaves", () => {
    expect(ohboxVisitStep(on, { kind: "tab", ohbox: true, active: true })).toEqual({ next: on, leave: false });
    expect(ohboxVisitStep(on, { kind: "app", state: "inactive" })).toEqual({ next: on, leave: false });
  });

  it("a visit never active writes nothing", () => {
    const unseen: OhboxVisitState = { onOhbox: true, seenActive: false };
    expect(ohboxVisitStep(unseen, { kind: "tab", ohbox: false, active: false }).leave).toBe(false);
    expect(ohboxVisitStep(unseen, { kind: "app", state: "background" }).leave).toBe(false);
    // Arriving on the Ohbox while active starts a seen visit.
    const arrived = ohboxVisitStep({ onOhbox: false, seenActive: false }, { kind: "tab", ohbox: true, active: true });
    expect(arrived.next).toEqual(on);
  });

  it("the Ohbox screen drives the step from the tab state and the app state", () => {
    const screen = src("app/(tabs)/index.tsx");
    expect(screen).toMatch(/useOhboxVisit\(w\.actions\.markOhboxVisit\)/);
    expect(screen).toMatch(/navigation\.addListener\("state"/);
    expect(screen).toMatch(/AppState\.addEventListener\("change"/);
  });
});

describe("the projection counts what was filed since the visit", () => {
  function msg(id: string, at: number, folder: string): EngineMessage {
    return {
      id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
      subject: `Subject ${id}`, from: { name: null, address: `${id}@example.test` }, to: [], cc: [],
      date: iso(at), folder, snippet: "", unread: true, hasAttachments: false, attachmentCount: 0,
      sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
      triage: null, labels: [], remoteContent: "none", updatedAt: iso(at),
    } as EngineMessage;
  }
  let seq = 0;
  const created = (ms: EngineMessage[]): SyncChange[] =>
    ms.map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m } as SyncChange));

  it("News, Spam and the rest after the mark; a held routing press is left out; nothing before a mark", async () => {
    const pages: SyncChange[][] = [created([msg("old", NOW - 7_200_000, "INBOX")])];
    const store = new MemoryMirrorStore();
    await store.load();
    const engine = new OhmailEngine({
      store, now: () => new Date(NOW), storePolicy: { mode: "full" },
      adapter: {
        sync: async (): Promise<SyncResponse> => ({
          changes: { creates: pages.shift() ?? [], updates: [], moves: [], deletes: [] },
          cursor: `c${seq}`, hasMore: false, serverTime: iso(NOW),
        }),
        mutate: async () => ({ changes: [], seq: null }),
        fetchBody: async () => null,
      } as never,
    });
    await engine.syncOnce();
    const projector = createProjector();
    const project = (heldPlaces: ReadonlyMap<string, string>, foldersOn = false) => projector.project({
      engine, worldKey: "rig", standalone: false, bearer: null, images: "direct" as never,
      zone: "Europe/Zurich", locale: "en", now: new Date(NOW), foldersOn, foldersPending: false, foldersStorable: true,
      signatures: null, resurfaceTime: null, screenerServer: null, relayed: null, mailboxes: null, mailboxesReadAt: () => null,
      walker: null, searchWalker: null, openOffMirror: () => undefined,
      scopes: {}, leavingWaiting: [], heldDeletes: new Set<string>(), heldPlaces: heldPlaces as never,
      ownAddresses: ["me@example.test"], posture: SCREENING_UNSUPPLIED,
      actions: {} as WorldActions, onPresented: () => undefined, account: () => ({ name: "rig", email: "" }),
      setFoldersEnabled: async () => true, folderSummary: async () => null, rememberResurfaceTime: () => undefined,
    } as unknown as ProjectionInputs);
    expect(project(new Map()).ohbox.filed, "a count with no mark").toBeNull();

    expect(await engine.markOhboxVisit()).toBe(true);
    pages.push(created([
      msg("n1", NOW - 3_000_000, "ohmail/News"), msg("n2", NOW - 2_000_000, "ohmail/News"),
      msg("q1", NOW - 1_000_000, "ohmail/Quarantine"), msg("i1", NOW - 500_000, "INBOX"),
    ]));
    await engine.syncOnce();
    expect(project(new Map()).ohbox.filed?.counts).toEqual([{ pile: "reads", count: 2 }, { pile: "spam", count: 1 }]);
    expect(project(new Map([["n2", "ohmail/News"]])).ohbox.filed?.counts).toEqual([{ pile: "reads", count: 1 }, { pile: "spam", count: 1 }]);
    // With folders on the phone keeps its Spam count: its Spam shelf lists the mirror's pile, and it
    // has no window into the provider's Junk folder (the web's line leaves the count out there).
    expect(project(new Map(), true).ohbox.filed?.counts).toEqual([{ pile: "reads", count: 2 }, { pile: "spam", count: 1 }]);
    expect(FILED_PILE_ROUTE.spam).toEqual({ pathname: "/(tabs)/screener", params: { seg: "spam" } });
  });
});
