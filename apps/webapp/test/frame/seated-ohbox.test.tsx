/** @vitest-environment jsdom */
/**
 * THE SEATED OHBOX OVER THE MAIL SHELL, as every web host hands it: the Ohbox's own place of the frame, its letter
 * in the frame's reading column, fed by the composition that stands above the panes.
 *
 * - ONE READER: a row opened at 1440 and at 390 wide stands in one region, the frame's; today's sheet is not in the
 *   document and no pane of today's is mounted beside it; the file door holds the open letter's list alone.
 * - THE SELECTION IS THE ADDRESS: after a press, `j`, `k`, a link and Back, at every commit the row the list marks is
 *   the letter the address names.
 * - ONE EDITOR: over the walk Ohbox, History, Ohbox one reply editor is mounted at a time, and under 700 wide a reply
 *   begun at the Ohbox leaves no sheet open at History.
 * - THE CARD AND THE RIBBON STAND ONCE: over the list at the Ohbox, in the stage at News; and while the seed review is
 *   owed it stands at the Ohbox's address with the rail around it and no row of the list.
 * - ONE SURFACE A REPORT: a delete at the Ohbox and a filing at History use the frame's slot.
 *   `z` takes back the newest, and the walk between them ends no Undo.
 * - A TAG THAT DOES NOT EXIST ends at the Ohbox's address, in place, and no list is drawn under the tag's.
 * - THE KEYBOARD: Enter on a row puts it in the reading column and Escape back on that row; a verb that takes the open
 *   row opens the next. On one column `j` and `k` move the cursor row in the list, which stays drawn: no letter is
 *   shown and nothing is read until a row is entered.
 * - ROWS PICKED: `a`, `e`, `b`, `m`, `d`, ⌫ and ⌦ act on the picked set and never on the open letter, whichever row
 *   the walk started from and whichever letter is shown.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { EngineMessage, EngineMutation } from "@ohmail/wire";
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NONE, type FeatureEntry } from "@ohmail/app/host";
import { DEMO_NOTICE } from "../../app/(product)/demo/notice";
import type { ConsentTransport } from "@ohmail/app-logic/consent/consent-state";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { AFTER_VERB_STORAGE_KEY } from "@ohmail/app-logic/press/after-verb";
import { LANDING_REST_MS } from "@ohmail/app-logic/reading/reader-seen";
import { resetUiVitalsForTest, takeUiVitals } from "@ohmail/app-logic/session/ui-vitals";
import {
  mutationEffects, MutationRejectedError, OhmailEngine,
  type MirrorStore, type SyncChange,
} from "@ohmail/client-engine";
import en from "../../messages/en.json";
import { act, consentTransport, msg, NOW, S, setup, storeWith, teardown, tombstone, waitFor } from "../_view-shell";
import { stubThreadLayout } from "../fixtures/thread-layout";

const seen = vi.hoisted(() => ({
  /** At every commit of the Ohbox's columns: the row its model marks, and the letter the frame's address names. */
  pairs: [] as Array<{ selected: string | null; open: string | null }>,
  /** Every letter the one file door was asked to hold a list for. */
  held: [] as string[],
}));

/* What the Ohbox's own seat stands above its columns, by the file the seat itself reads it from. */
vi.mock("../../../../packages/app/src/ohbox/OhboxAbove", async (load) => {
  const real = await load<typeof import("../../../../packages/app/src/ohbox/OhboxAbove")>();
  const React = await import("react");
  const { useFrame } = await import("@ohmail/app/frame");
  return {
    ...real,
    OhboxAbove: (props: Parameters<typeof real.OhboxAbove>[0]) => {
      const open = useFrame().route.open;
      const selected = props.model.selected?.id ?? null;
      React.useLayoutEffect(() => {
        seen.pairs.push({ selected, open });
      });
      return React.createElement(real.OhboxAbove, props);
    },
  };
});

/* The one file door, where the mail ground mounts it. */
vi.mock("@ohmail/app-logic/reader/attachments", async (load) => {
  const real = await load<typeof import("@ohmail/app-logic/reader/attachments")>();
  return {
    ...real,
    useMessageAttachments: (...args: Parameters<typeof real.useMessageAttachments>) => {
      const door = real.useMessageAttachments(...args);
      if (door === undefined) return door;
      return { ...door, hold: (id: string) => { seen.held.push(id); return door.hold(id); } };
    },
  };
});

/* The seed review's wire and the pictures' door exist only where the page has a server to name: this page has one. */
vi.mock("../../app/api-client", async (load) => {
  const real = await load<typeof import("../../app/api-client")>();
  return { ...real, API_BASE: "/api", apiConfigured: () => true };
});

const ROSTER: MailboxFacts[] = [{
  id: "mb1", address: "me@example.invalid", status: "connected", errorCode: null,
  disabledReason: null, syncBlockedReason: null, syncBlockedSince: null,
  lastSyncAt: "2026-09-16T08:59:00.000Z", createdAt: "2026-09-01T00:00:00.000Z",
  organizerRole: "organizer" as const, organizedBy: null, organizeConsentedAt: "2026-09-01T00:00:00.000Z",
}];

/** One file on every letter: the reader holds a letter's list while it draws it. */
const FILE = { id: "a0000000-0000-4000-8000-000000000001", filename: "plan.pdf", contentType: "application/pdf", sizeBytes: 1000, inline: false };
const filed = { hasAttachments: true, attachmentCount: 1 } as Partial<EngineMessage>;

interface Seated {
  readonly sent: EngineMutation[];
  /** Every letter whose text the mirror asked the server for. */
  readonly asked: string[];
  readonly changeScope: (scope: string) => Promise<void>;
}

/** The mail shell over a memory mirror, at the address named. */
async function seat(o: {
  letters: EngineMessage[];
  hash: string;
  consent?: ConsentTransport | typeof NONE;
  demo?: boolean;
  stageNotice?: NonNullable<FeatureEntry["notice"]>;
  roster?: MailboxFacts[];
  beforeMutation?: (mutation: EngineMutation) => Promise<void>;
}): Promise<Seated> {
  const store: MirrorStore = await storeWith(o.letters);
  const sent: EngineMutation[] = [];
  const asked: string[] = [];
  const engine = new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => {
        const page = S.pending;
        S.pending = [];
        return {
          changes: { creates: page, updates: [], moves: [], deletes: [] },
          cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
        };
      },
      mutate: async (m: EngineMutation) => {
        sent.push(m);
        if (o.beforeMutation) await o.beforeMutation(m);
        const changes = mutationEffects(store, m, { now: () => NOW, uuid: () => `id-${++S.seq}` }).map((e) => ({
          type: e.type, op: e.entity === null ? "delete" : e.move ? "move" : "update",
          id: e.id, seq: ++S.seq, updatedAt: NOW.toISOString(), entity: e.entity, ...(e.move ? { move: e.move } : {}),
        })) as SyncChange[];
        await store.applyChanges(changes);
        return { changes, seq: changes[changes.length - 1]?.seq ?? null };
      },
      fetchBody: async (id: string) => {
        asked.push(id);
        return { text: `The text of ${id}.`, html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null };
      },
      listAttachments: async (id: string) => [{ ...FILE, messageId: id }],
      fetchAttachment: async () => new Blob(["x"]),
    },
  } as never);
  S.store = store;
  S.engine = engine;
  window.location.hash = o.hash;
  const { MailShell } = await import("../_mail-shell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  S.roots.push(root);
  const draw = (scope?: string) => act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages: en, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, { children: h(ToastHost, {
        children: h(MailShell as never, {
          scope, demo: o.demo === true, engine, consentTransport: o.consent ?? consentTransport,
          mailboxFacts: async () => o.roster ?? ROSTER, stageNotice: o.stageNotice,
        } as never),
      }) }),
    } as never));
  });
  await draw();
  return { sent, asked, changeScope: draw };
}

const width = { w: 0, h: 0 };
function sized(w: number, hgt: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: w });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: hgt });
  /* Today's own narrow rule reads the same width, by its media queries. */
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (query: string) => {
      const max = /max-width:\s*([\d.]+)px/.exec(query);
      const min = /min-width:\s*([\d.]+)px/.exec(query);
      const matches = (max === null || w <= Number(max[1])) && (min === null || w >= Number(min[1])) && (max !== null || min !== null);
      return {
        matches, media: query, onchange: null, addListener() {}, removeListener() {},
        addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
      };
    },
  });
}

async function rounds(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
}
async function press(el: Element | null, what: string): Promise<void> {
  if (!el) throw new Error(`nothing to press: ${what}`);
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}
async function key(k: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init }));
  });
}
async function visit(hash: string): Promise<void> {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

/** The seated list's rows, and one by its letter's subject. */
const rows = (): HTMLElement[] => screen.queryAllByRole("option");
const row = (id: string): HTMLElement => screen.getByRole("option", { name: new RegExp(`Subject ${id}$`) });
/** The frame's reading column: the region named Open message. */
const readers = (): HTMLElement[] => screen.queryAllByRole("region", { name: en.reader.pane });
const reader = (): HTMLElement => screen.getByRole("region", { name: en.reader.pane });
const letterShown = (id: string): boolean =>
  readers().length === 1 && within(reader()).queryByRole("heading", { name: `Subject ${id}` }) !== null;
/** Today's sheet over the app, in the document at all. */
const todaysSheet = (): HTMLElement | null => screen.queryByRole("dialog", { name: en.reader.pane, hidden: true });
/** The Ohbox's Messages region and History's own list distinguish the two places. */
const atTheOhbox = (): boolean => screen.queryByRole("region", { name: "Messages" }) !== null;
const atHistory = (): boolean => screen.queryByRole("listbox", { name: "History" }) !== null;
const editors = (): HTMLElement[] => screen.queryAllByRole("textbox", { name: "Reply body", hidden: true });
/** The two surfaces a report can stand on, by their hosts' own boxes (no role tells them apart). */
const inTheFramesSlot = (): string => document.querySelector(".fr-report")?.textContent ?? "";
const inTheCapsule = (): string => [...document.querySelectorAll(".toast")].map((el) => el.textContent ?? "").join(" ");
const deletes = (s: Seated) => s.sent.filter((m) => m.kind === "message_delete");
/** The row the list marks as the one the keys are on, by its letter; null where it marks none. */
const cursorOn = (): string | null => {
  const marked = screen.queryAllByRole("option", { selected: true });
  return marked.length === 1 ? (/Subject (m\d)/.exec(marked[0]!.getAttribute("aria-label") ?? "")?.[1] ?? null) : null;
};
/** The letters the walk marked read, as the wire was told. */
const reads = (s: Seated): string[] =>
  s.sent.flatMap((m) => (m.kind === "mark_seen" && !m.unread ? m.messageIds : []));
/** A row's letter, the list's order, the rows picked, the letter the address names, and the letters parked. */
const idOf = (el: Element): string => /Subject (m\d)/.exec(el.getAttribute("aria-label") ?? "")?.[1] ?? "?";
const order = (): string[] => rows().map(idOf);
const picked = (): string[] => [...document.querySelectorAll<HTMLElement>('[role="option"][data-picked]')].map(idOf).sort();
const openId = (): string | null => /\/m\/(m\d)$/.exec(window.location.hash)?.[1] ?? null;
const parks = (s: Seated): string[] =>
  s.sent.flatMap((m) => (m.kind === "triage_set" && m.state === "set_aside" ? [m.messageId] : [])).sort();
/** The list's own menu button, in its head: the one control of the list that opens a menu and is no row's. */
const listMenu = (list: HTMLElement): HTMLElement =>
  within(list).getAllByRole("button").filter((b) => b.getAttribute("aria-haspopup") === "menu" && b.closest('[role="option"]') === null)[0]!;
/** A key as a browser sends it: one a handler may refuse. */
const typed = (k: string, init: KeyboardEventInit = {}): Promise<void> => key(k, { cancelable: true, ...init });

beforeEach(() => {
  setup();
  width.w = window.innerWidth;
  width.h = window.innerHeight;
  seen.pairs.length = 0;
  seen.held.length = 0;
  resetUiVitalsForTest();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
});
afterEach(async () => {
  await teardown();
  sized(width.w, width.h);
});

describe("one reader of one letter", () => {
  for (const [w, hgt] of [[1440, 900], [390, 844]] as const) {
    it(`at ${w} wide a row opened stands in the frame's column alone: no sheet, no pane of today's, the door holds it alone`, async () => {
      sized(w, hgt);
      await seat({ letters: [msg("m1", filed), msg("m2", filed)], hash: "#/ohbox" });
      await waitFor(() => rows().length === 2, "the seated list");
      expect(seen.held, "nothing is held before a letter is opened").toEqual([]);

      await press(row("m1"), "the row of m1");
      await waitFor(() => letterShown("m1"), "m1 in the frame's reading column");
      await waitFor(() => seen.held.length > 0, "the letter's list held");
      await rounds(8);
      expect(window.location.hash, "the address names the letter").toBe("#/ohbox/m/m1");
      expect(readers(), "one region named Open message").toHaveLength(1);
      expect(todaysSheet(), "today's sheet").toBeNull();
      /* Today's pane would stand a second Reply and a second copy of the letter's subject in the hidden stage. */
      expect(screen.getAllByRole("button", { name: /^Reply/, hidden: true }), "one Reply: the reader's panel").toHaveLength(1);
      expect(screen.getAllByRole("heading", { name: "Subject m1", hidden: true }), "the letter is drawn once").toHaveLength(1);
      expect([...new Set(seen.held)], "the file door holds the open letter's list, and no other").toEqual(["m1"]);
    }, 30_000);
  }
});

describe("the selection is the address", () => {
  it("a press, j, k, a link that names a letter and Back: at every commit the marked row is the letter the address names", async () => {
    sized(1440, 900);
    await seat({ letters: [msg("m1"), msg("m2"), msg("m3")], hash: "#/ohbox" });
    await waitFor(() => rows().length === 3, "the seated list");
    const first = rows()[0]!;
    await press(first, "the first row");
    await waitFor(() => readers().length === 1 && within(reader()).queryByRole("article") !== null, "a letter open");
    const opened = window.location.hash;
    await act(async () => { first.focus(); });
    await key("j");
    await waitFor(() => window.location.hash !== opened, "j moved the open letter");
    const afterJ = window.location.hash;
    await key("k");
    await waitFor(() => window.location.hash === opened, "k moved it back");
    await visit("#/ohbox/m/m3");
    await waitFor(() => letterShown("m3"), "the linked letter");
    await act(async () => { window.history.back(); });
    await waitFor(() => window.location.hash !== "#/ohbox/m/m3", "Back");
    await rounds(8);

    expect(afterJ, "j named the next letter in the address").toMatch(/^#\/ohbox\/m\/m[123]$/);
    expect(seen.pairs.length, "the columns committed over the walk").toBeGreaterThan(4);
    expect(seen.pairs.filter((p) => p.selected !== p.open), "a commit whose marked row is not the address's letter").toEqual([]);
    expect(seen.pairs.map((p) => p.open), "the walk opened the linked letter").toContain("m3");
  }, 30_000);
});

describe("one reply editor", () => {
  it("over the walk Ohbox, History, Ohbox one editor is mounted at a time, the keyboard in it when it opens", async () => {
    sized(1440, 900);
    await seat({ letters: [msg("m1"), msg("m2")], hash: "#/ohbox/m/m1" });
    await waitFor(() => letterShown("m1"), "m1 open");
    await press(within(reader()).getByRole("button", { name: "Reply" }), "Reply");
    await waitFor(() => editors().length === 1, "the editor under the letter");
    await waitFor(() => editors()[0]!.contains(document.activeElement), "the keyboard in the editor");
    expect(reader().contains(editors()[0]!), "the editor stands in the frame's reading column").toBe(true);

    await visit("#/history");
    await waitFor(atHistory, "History");
    await rounds(8);
    expect(editors().length, "at History no more than one editor is mounted").toBeLessThanOrEqual(1);

    await visit("#/ohbox/m/m1");
    await waitFor(() => letterShown("m1"), "m1 again");
    await rounds(8);
    expect(editors().length, "back at the Ohbox no more than one editor is mounted").toBeLessThanOrEqual(1);
  }, 30_000);

  it("under 700 wide a reply begun at the Ohbox opens no sheet there, and none at History after", async () => {
    sized(390, 844);
    await seat({ letters: [msg("m1"), msg("m2")], hash: "#/ohbox" });
    await waitFor(() => rows().length === 2, "the seated list");
    await press(row("m1"), "the row of m1");
    await waitFor(() => letterShown("m1"), "m1 over the list");
    await press(within(reader()).getByRole("button", { name: "Reply" }), "Reply");
    await waitFor(() => editors().length === 1, "the editor under the letter");
    expect(todaysSheet(), "today's sheet at the Ohbox").toBeNull();
    expect(readers(), "one reader").toHaveLength(1);

    await visit("#/history");
    await waitFor(atHistory, "History");
    await rounds(12);
    expect(todaysSheet(), "today's sheet at History, with nothing opened there").toBeNull();
  }, 30_000);
});

describe("the stage's card and the demo's ribbon stand once", () => {
  const CARD = "The host's one card";
  const useHostNotice: NonNullable<FeatureEntry["notice"]> = () => [{ kind: "mailLinks", title: CARD }];
  const useHostAndDemoNotices: NonNullable<FeatureEntry["notice"]> = () => [
    ...useHostNotice(), ...DEMO_NOTICE.notice(),
  ];
  const cards = (): HTMLElement[] => screen.queryAllByRole("status", { hidden: true })
    .filter((status) => status.textContent === CARD);
  const ribbons = (): HTMLElement[] => screen.queryAllByRole("button", { name: en.ribbon.dismiss, hidden: true });
  const overTheList = (el: HTMLElement): boolean => el.closest('section[aria-label="Messages"]') !== null;

  it("over the list at the Ohbox, in the stage at News", async () => {
    sized(800, 900);
    await seat({ letters: [msg("m1")], hash: "#/ohbox", demo: true, stageNotice: useHostAndDemoNotices });
    async function capture() {
      const ribbon = ribbons();
      const ribbonOverList = ribbon[0] !== undefined && overTheList(ribbon[0]);
      await press(screen.getByRole("button", { name: /more notice/i }), "show the other notices");
      await press(screen.getByRole("menuitem", { name: CARD }), "show the host card");
      const card = cards();
      const cardOverList = card[0] !== undefined && overTheList(card[0]);
      await press(screen.getByRole("button", { name: /more notice/i }), "show the other notices");
      await press(screen.getByRole("menuitem", { name: /^demo\b/i }), "show the demo ribbon");
      return { counts: { cards: card.length, ribbons: ribbon.length }, placement: { card: cardOverList, ribbon: ribbonOverList } };
    }
    await waitFor(() => atTheOhbox() && ribbons().length > 0, "the demo ribbon over the Ohbox");
    const ohbox = await capture();
    expect(ohbox.counts, "each once at the Ohbox").toEqual({ cards: 1, ribbons: 1 });
    expect(ohbox.placement, "both over the list").toEqual({
      card: true, ribbon: true,
    });

    // The upright rail seats the slot over the list. At desktop width News keeps it outside the list.
    await act(async () => {
      sized(1440, 900);
      window.dispatchEvent(new Event("resize"));
    });
    await visit("#/reads");
    await waitFor(() => screen.queryByRole("region", { name: "News" }) !== null && ribbons().length > 0,
      "News with the demo ribbon");
    const news = await capture();
    expect(news.counts, "each once at News").toEqual({ cards: 1, ribbons: 1 });
    expect(news.placement, "both in the stage").toEqual({
      card: false, ribbon: false,
    });
  }, 30_000);

  it("while the seed review is owed it stands at the Ohbox's address, the rail around it, and no row of the list", async () => {
    // esbuild and Chromium must run in Node, outside this file's jsdom environment.
    await promisify(execFile)(process.execPath, [
      join(process.cwd(), "apps/webapp/test/frame/first-run-page/seed-visibility.mjs"),
    ], { timeout: 55_000 });
  }, 60_000);

  it("the host card stands once above the seed review", async () => {
    sized(1440, 900);
    const unseeded = {
      ...consentTransport,
      state: async () => ({ ...(await consentTransport.state()), seedConfirmedAt: null }),
    } as unknown as ConsentTransport;
    await seat({ letters: [msg("m1"), msg("m2")], hash: "#/ohbox", consent: unseeded, stageNotice: useHostNotice });
    await waitFor(() => screen.queryByRole("button", { name: en.seed.later }) !== null, "the seed review");
    await rounds(8);
    expect(cards(), "the card stands once, above the review").toHaveLength(1);
    const stage = within(screen.getByRole("dialog", { name: en.frame.landmark.stage }));
    expect(stage.getAllByRole("status").filter((status) => status.textContent === CARD)).toHaveLength(1);
    expect(cards()[0]!.compareDocumentPosition(stage.getByRole("button", { name: en.seed.later })) &
      Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }, 30_000);
});

describe("one surface a report", () => {
  it("a delete at the Ohbox is said in the frame's slot, a filing at History uses the same slot, z takes back the newest, and the walk ends no Undo", async () => {
    sized(1440, 900);
    const s = await seat({ letters: [msg("m1"), msg("m2")], hash: "#/ohbox/m/m1" });
    await waitFor(() => letterShown("m1"), "m1 open");
    await act(async () => { row("m1").focus(); });
    await key("Backspace");
    await waitFor(() => inTheFramesSlot().includes(en.ohbox.toastDeleted.replace(/\.$/, "")), "the delete said in the frame's slot");
    expect(inTheCapsule(), "no second report surface").not.toContain(en.ohbox.toastDeleted.replace(/\.$/, ""));
    expect(deletes(s), "the delete is held for its window: nothing left yet").toEqual([]);

    await visit("#/history");
    /* History opens its first letter in the shared reading column. */
    await waitFor(() => atHistory() && readers().length === 1 && within(reader()).queryByRole("button", { name: /^Park/ }) !== null, "History, its first letter shown");
    await press(within(reader()).getByRole("button", { name: /^Park/ }), "Park the open letter");
    await waitFor(() => inTheFramesSlot().includes(en.ohbox.toastAside), "the filing said in the same report slot");
    expect(inTheCapsule(), "no second report surface").not.toContain(en.ohbox.toastAside);
    const filings = s.sent.length;

    await key("z");
    await waitFor(() => s.sent.length > filings, "z took back the newest: the filing at History");
    expect(deletes(s), "the walk and the second report ended no Undo: the delete's window still holds").toEqual([]);
  }, 30_000);
});

describe("a tag that does not exist", () => {
  it("ends at the Ohbox's address, in place, and no list is ever drawn under the tag's address", async () => {
    sized(1440, 900);
    window.location.hash = "#/tag/no-such-tag";
    const before = window.history.length;
    await seat({ letters: [msg("m1")], hash: "#/tag/no-such-tag" });
    const drawnUnderTheTag: number[] = [];
    for (let i = 0; i < 60 && window.location.hash !== "#/ohbox"; i++) {
      drawnUnderTheTag.push(rows().length);
      await rounds(1);
    }
    expect(window.location.hash, "the address became the Ohbox's").toBe("#/ohbox");
    expect(drawnUnderTheTag.filter((n) => n > 0), "a list drawn under the tag's address").toEqual([]);
    expect(window.history.length, "in place: no history entry was added").toBe(before);
    await waitFor(() => rows().length === 1, "the seated Ohbox");
  }, 30_000);

  it("on an account that holds no letter at all it ends at the Ohbox's address too, once the mirror has arrived: never a blank stage for good", async () => {
    sized(1440, 900);
    window.location.hash = "#/tag/no-such-tag";
    const before = window.history.length;
    await seat({ letters: [], hash: "#/tag/no-such-tag" });
    for (let i = 0; i < 120 && window.location.hash !== "#/ohbox"; i++) await rounds(1);
    expect(window.location.hash, "the address became the Ohbox's").toBe("#/ohbox");
    expect(window.history.length, "in place: no history entry was added").toBe(before);
    await waitFor(() => screen.queryByRole("region", { name: "Messages" }) !== null, "the seated Ohbox, with nothing in it");
    expect(rows(), "no row").toEqual([]);
  }, 30_000);
});

describe("the open's measure at the seated Ohbox", () => {
  /** Two frames and the effects behind them: the measure is taken after the paint that shows the text. */
  const painted = (): Promise<void> => rounds(6);

  it("at 1440 wide one open is one reading: begun at the press, ended by the letter's text on screen", async () => {
    sized(1440, 900);
    await seat({ letters: [msg("m1"), msg("m2")], hash: "#/ohbox" });
    await waitFor(() => rows().length === 2, "the seated list");
    await painted();
    takeUiVitals(); // the window so far
    await press(row("m1"), "the row of m1");
    await waitFor(() => letterShown("m1") && within(reader()).queryByText("The text of m1.") !== null, "m1 with its text");
    await painted();
    expect(takeUiVitals().openCount, "one open, one reading").toBe(1);
  }, 30_000);

  it("on one column the cursor row's text is asked ahead, and Enter on it is one reading", async () => {
    sized(390, 844);
    const s = await seat({ letters: [msg("m1"), msg("m2")], hash: "#/ohbox" });
    await waitFor(() => rows().length === 2, "the seated list");
    const first = order()[0]!;
    await typed("j");
    await waitFor(() => cursorOn() === first, "the cursor on the first row");
    await waitFor(() => s.asked.includes(first), "the cursor row's text asked for before it is entered");
    expect(readers(), "no letter is shown for it").toHaveLength(0);
    await painted();
    takeUiVitals(); // the window so far
    await typed("Enter");
    await waitFor(() => letterShown(first) && within(reader()).queryByText(`The text of ${first}.`) !== null, "the letter with its text");
    await painted();
    expect(takeUiVitals().openCount, "one open, one reading").toBe(1);
  }, 30_000);
});

describe("under 700 wide a menu is a sheet, and closing it gives the keyboard back to what opened it", () => {
  const menus = (): HTMLElement[] => [...screen.queryAllByRole("menu"), ...screen.queryAllByRole("dialog")];

  it("the list's own menu, and More on the open letter's panel: each closed by Escape, the keyboard is back on its button", async () => {
    sized(390, 844);
    await seat({ letters: [msg("m1"), msg("m2")], hash: "#/ohbox" });
    await waitFor(() => rows().length === 2, "the seated list");
    const list = screen.getByRole("region", { name: "Messages" });
    const ofTheList = (): HTMLElement => listMenu(list);
    await act(async () => { ofTheList().focus(); });
    await press(ofTheList(), "the list's menu");
    await waitFor(() => menus().length === 1, "the list's menu as a sheet");
    await typed("Escape");
    await waitFor(() => menus().length === 0, "Escape closed it");
    await rounds(4);
    expect(document.activeElement, "the keyboard is back on the list's menu button").toBe(ofTheList());

    await press(row("m1"), "the row of m1");
    await waitFor(() => letterShown("m1"), "m1 over the list");
    const readingSheet = screen.getByRole("dialog");
    expect(readingSheet.contains(reader())).toBe(true);
    expect(menus()).toEqual([readingSheet]);
    const more = (): HTMLElement => within(reader()).getByRole("button", { name: "More" });
    await act(async () => { more().focus(); });
    await press(more(), "More on the panel");
    await waitFor(() => screen.queryByRole("menu", { name: "More" }) !== null, "More as a sheet");
    expect(menus()).toEqual([screen.getByRole("menu", { name: "More" }), readingSheet]);
    await typed("Escape");
    await waitFor(() => menus().length === 1 && menus()[0] === readingSheet, "Escape closed only More");
    await rounds(4);
    expect(letterShown("m1"), "the letter stays over the list: one Escape closes one thing").toBe(true);
    expect(document.activeElement, "the keyboard is back on More").toBe(more());
  }, 30_000);
});

describe("the keyboard at the seated Ohbox", () => {
  it("on one column a row opened by Enter hands the keyboard to the reading column, and Escape closes it and puts it back on that row", async () => {
    sized(390, 844);
    await seat({ letters: [msg("m1"), msg("m2")], hash: "#/ohbox" });
    await waitFor(() => rows().length === 2, "the seated list");
    await press(row("m1"), "the row of m1");
    await waitFor(() => letterShown("m1"), "m1 over the list");
    await waitFor(() => reader().contains(document.activeElement), "the keyboard in the reading column");
    expect(todaysSheet(), "today's sheet").toBeNull();

    await key("Escape");
    await waitFor(() => window.location.hash === "#/ohbox", "Escape took the letter out of the address");
    await waitFor(() => readers().length === 0, "the letter closed");
    expect(document.activeElement, "the keyboard is back on the letter's row").toBe(row("m1"));
  }, 30_000);

  it("on one column j and k move the cursor row in the list that stays drawn, showing and reading nothing; Enter shows the letter and reads it; Escape leaves the cursor on it", async () => {
    sized(390, 844);
    const layout = stubThreadLayout();
    try {
      const fresh = { unread: true } as Partial<EngineMessage>;
      const s = await seat({ letters: [msg("m1", fresh), msg("m2", fresh), msg("m3", fresh)], hash: "#/ohbox" });
      await waitFor(() => rows().length === 3, "the seated list");
      const order = rows().map((r) => /Subject (m\d)/.exec(r.getAttribute("aria-label") ?? "")![1]!);
      expect(cursorOn(), "an untouched list has no cursor row").toBeNull();

      await key("j");
      await waitFor(() => cursorOn() === order[0], "j put the cursor on the first row");
      await key("j");
      await waitFor(() => cursorOn() === order[1], "j moved the cursor to the next row");
      await key("k");
      await waitFor(() => cursorOn() === order[0], "k moved it back");
      await rounds(8);
      await layout.passDwell();
      await rounds(4);
      expect(window.location.hash, "the walk named no letter in the address").toBe("#/ohbox");
      expect(readers(), "no letter is shown over the list").toHaveLength(0);
      expect(todaysSheet(), "today's sheet").toBeNull();
      expect(rows(), "the list stays drawn").toHaveLength(3);
      expect(reads(s), "nothing was read by the walk").toEqual([]);

      await key("Enter");
      await waitFor(() => letterShown(order[0]!), "Enter showed the cursor row's letter over the list");
      expect(window.location.hash, "the address names the letter entered").toBe(`#/ohbox/m/${order[0]}`);
      await rounds(8);
      await layout.passDwell();
      await waitFor(() => reads(s).includes(order[0]!), "the letter entered is read by the rule, as today");
      expect(reads(s).filter((id) => id !== order[0]), "and no other letter").toEqual([]);

      /* With the letter over the list the keys move the cursor under it, as they did under today's sheet. */
      await key("j");
      await rounds(4);
      expect(letterShown(order[0]!), "j under an open letter leaves that letter shown").toBe(true);
      expect(window.location.hash, "and the address on it").toBe(`#/ohbox/m/${order[0]}`);
      await key("k");
      await rounds(4);

      await key("Escape");
      await waitFor(() => window.location.hash === "#/ohbox" && readers().length === 0, "Escape closed the letter");
      await rounds(4);
      expect(cursorOn(), "the cursor stays on the row read").toBe(order[0]);

      await key("Enter");
      await waitFor(() => letterShown(order[0]!), "the letter over the list again");
      await press(within(reader()).getByRole("button", { name: "Ohbox" }), "the column's way back");
      await waitFor(() => window.location.hash === "#/ohbox" && readers().length === 0, "the way back closed the letter");
      await rounds(4);
      expect(cursorOn(), "the way back keeps the cursor on its row too").toBe(order[0]);
    } finally {
      layout.restore();
    }
  }, 30_000);

  it("beside the list a letter landed on by j and rested on is read by the rule, and the ones only passed are not", async () => {
    sized(1440, 900);
    const layout = stubThreadLayout();
    try {
      const fresh = { unread: true } as Partial<EngineMessage>;
      const s = await seat({ letters: [msg("m1", fresh), msg("m2", fresh), msg("m3", fresh), msg("m4", fresh)], hash: "#/ohbox" });
      await waitFor(() => rows().length === 4, "the seated list");
      const ids = order();
      for (const n of [0, 1, 2]) {
        await typed("j");
        await waitFor(() => letterShown(ids[n]!), "j showed the next row's letter");
      }
      expect(reads(s), "nothing was read by passing").toEqual([]);
      /* The landing's rest, then the dwell: the letter rested on is entered and read, as on the shipped Ohbox. */
      await act(async () => { await new Promise((r) => setTimeout(r, LANDING_REST_MS + 200)); });
      await rounds(4);
      await layout.passDwell();
      await waitFor(() => reads(s).includes(ids[2]!), "the letter rested on is read by the rule");
      expect(reads(s).filter((id) => id !== ids[2]), "and the two passed are not").toEqual([]);
    } finally {
      layout.restore();
    }
  }, 30_000);

  it("u on a letter that was read, left and opened again marks it unread, and its row stands in New again at once", async () => {
    sized(1440, 900);
    const layout = stubThreadLayout();
    try {
      const fresh = { unread: true } as Partial<EngineMessage>;
      const s = await seat({ letters: [msg("m1", fresh), msg("m2", fresh), msg("m3", fresh), msg("m4", fresh)], hash: "#/ohbox" });
      await waitFor(() => rows().length === 4, "the seated list");
      const group = (name: string): string[] =>
        screen.queryAllByRole("listbox", { name }).flatMap((box) => within(box).queryAllByRole("option").map(idOf));
      const ids = order();
      const [, second, third] = ids;
      expect(group("New"), "the premise: every letter waits in New").toEqual(ids);

      await press(row(second!), "the second row");
      await waitFor(() => letterShown(second!), "its letter open");
      await rounds(8);
      await layout.passDwell();
      await waitFor(() => reads(s).includes(second!), "read by the rule while open");
      await press(row(third!), "the third row");
      await waitFor(() => letterShown(third!), "moved on to the next letter");
      await waitFor(() => group("Earlier").includes(second!), "the letter read and left is under Earlier");

      await press(row(second!), "the read letter's row again");
      await waitFor(() => letterShown(second!), "opened again");
      await act(async () => { row(second!).focus(); });
      const unreads = (): string[] => s.sent.flatMap((m) => (m.kind === "mark_seen" && m.unread ? m.messageIds : []));
      await typed("u");
      await waitFor(() => unreads().includes(second!), "u wrote the unread");
      await rounds(4);
      expect(group("New"), "its row stands in New again, at its arrival place").toEqual(ids);
      expect(group("Earlier"), "and no longer under Earlier").not.toContain(second);
    } finally {
      layout.restore();
    }
  }, 30_000);

  it("on one column a letter deleted while it stands over the list leaves the screen, as today's sheet closed: the list stands, the delete is said and held", async () => {
    sized(390, 844);
    const s = await seat({ letters: [msg("m1"), msg("m2")], hash: "#/ohbox" });
    await waitFor(() => rows().length === 2, "the seated list");
    await press(row("m1"), "the row of m1");
    await waitFor(() => letterShown("m1"), "m1 over the list");
    await key("Backspace");
    await waitFor(() => inTheFramesSlot().includes(en.ohbox.toastDeleted.replace(/\.$/, "")), "the delete said in the frame's slot");
    await waitFor(() => readers().length === 0, "the letter left the screen");
    expect(window.location.hash, "the address names no letter").toBe("#/ohbox");
    expect(rows().map((r) => r.getAttribute("aria-label")), "the list stands without the deleted row").toEqual([row("m2").getAttribute("aria-label")]);
    expect(deletes(s), "the delete is held for its window: nothing left yet").toEqual([]);
  }, 30_000);

  it("the window widened with a letter over the list and the cursor moved under it: that letter stands beside the list and the cursor comes to it", async () => {
    sized(390, 844);
    await seat({ letters: [msg("m1"), msg("m2"), msg("m3")], hash: "#/ohbox" });
    await waitFor(() => rows().length === 3, "the seated list");
    const order = rows().map((r) => /Subject (m\d)/.exec(r.getAttribute("aria-label") ?? "")![1]!);
    await key("j");
    await waitFor(() => cursorOn() === order[0], "the cursor on the first row");
    await key("Enter");
    await waitFor(() => letterShown(order[0]!), "its letter over the list");
    await key("j");
    await waitFor(() => cursorOn() === order[1], "the cursor moved under the letter");

    await act(async () => {
      sized(1440, 900);
      window.dispatchEvent(new Event("resize"));
    });
    await waitFor(() => atTheOhbox() && rows().length === 3, "two columns");
    await rounds(8);
    expect(letterShown(order[0]!), "the letter that was on screen stays on screen").toBe(true);
    expect(window.location.hash, "the address keeps it").toBe(`#/ohbox/m/${order[0]}`);
    expect(cursorOn(), "the cursor row is that letter's").toBe(order[0]);
  }, 30_000);

  it("on one column the cursor row's verbs act with no letter shown, as today's: e parks the row the cursor is on, and r stands its letter over the list with the reply's editor", async () => {
    sized(390, 844);
    const s = await seat({ letters: [msg("m1"), msg("m2"), msg("m3")], hash: "#/ohbox" });
    await waitFor(() => rows().length === 3, "the seated list");
    const order = rows().map((r) => /Subject (m\d)/.exec(r.getAttribute("aria-label") ?? "")![1]!);
    const filings = (): string[] => s.sent.flatMap((m) => (m.kind === "triage_set" ? [m.messageId] : []));

    await key("j");
    await waitFor(() => cursorOn() === order[0], "the cursor on the first row");
    await key("e");
    await waitFor(() => filings().length > 0, "e filed the cursor row");
    expect(filings(), "one filing, of the row the cursor was on").toEqual([order[0]]);
    expect(inTheFramesSlot(), "said in the frame's slot").toContain(en.ohbox.toastAside);
    expect(readers(), "no letter was shown for it").toHaveLength(0);
    expect(window.location.hash, "and none was named in the address").toBe("#/ohbox");

    await waitFor(() => rows().length === 2, "the filed row left the list");
    await key("j");
    await waitFor(() => cursorOn() === order[1], "the cursor on the next row");
    await key("r");
    await waitFor(() => letterShown(order[1]!) && editors().length === 1, "r stood the letter over the list with the reply's editor");
    expect(reader().contains(editors()[0]!), "the editor stands in the frame's reading column").toBe(true);
    expect(todaysSheet(), "today's sheet").toBeNull();
    expect(window.location.hash, "the address names the letter answered").toBe(`#/ohbox/m/${order[1]}`);
  }, 30_000);

  it("a link that names a letter brings its row on screen in the seated list", async () => {
    sized(1440, 900);
    await seat({ letters: [msg("m1"), msg("m2"), msg("m3")], hash: "#/ohbox" });
    await waitFor(() => rows().length === 3, "the seated list");
    /* jsdom lays nothing out: what is brought on screen is the element asked to scroll into view, and how. */
    const brought: Array<{ el: Element; how: unknown }> = [];
    Element.prototype.scrollIntoView = function (this: Element, how?: unknown) { brought.push({ el: this, how }); };

    await visit("#/ohbox/m/m3");
    await waitFor(() => letterShown("m3"), "the linked letter");
    await waitFor(() => brought.some((b) => b.el === row("m3")), "the linked letter's row brought on screen");
    expect(brought.find((b) => b.el === row("m3"))!.how, "to the middle of the list, as a located row is").toEqual({ block: "center" });
  }, 30_000);

  it("a verb's first press with no cursor puts the cursor on the seated list's first row, says so in the frame's slot and files nothing; the second press files it", async () => {
    sized(1440, 900);
    const s = await seat({ letters: [msg("m1"), msg("m2")], hash: "#/ohbox" });
    await waitFor(() => rows().length === 2, "the seated list");
    const first = /Subject (m\d)/.exec(rows()[0]!.getAttribute("aria-label") ?? "")![1]!;
    const said = en.cursor.placed.replace("{label}", en.shortcuts.park);
    expect(cursorOn(), "an untouched list has no cursor row").toBeNull();

    await key("e");
    await waitFor(() => cursorOn() === first, "the first press put the cursor on the first row");
    await waitFor(() => inTheFramesSlot().includes(said), "and said so in the frame's slot");
    expect(inTheCapsule(), "no second report surface").not.toContain(said);
    await rounds(4);
    expect(s.sent.filter((m) => m.kind === "triage_set"), "the first press filed nothing").toEqual([]);

    await key("e");
    await waitFor(() => s.sent.some((m) => m.kind === "triage_set" && m.messageId === first), "the second press filed the row the cursor is on");
  }, 30_000);

  it("the rail put up over the app, the window widened and Escape pressed in the rail: the keyboard goes to the seated list's cursor row", async () => {
    sized(760, 900);
    await seat({ letters: [msg("m1"), msg("m2")], hash: "#/ohbox/m/m1" });
    await waitFor(() => letterShown("m1"), "m1 open beside the list");
    await act(async () => { row("m1").focus(); });
    await key("h");
    await waitFor(() => screen.queryByRole("dialog", { name: "More" }) !== null, "h put the whole rail up over the app");

    await act(async () => {
      sized(1440, 900);
      window.dispatchEvent(new Event("resize"));
    });
    await waitFor(() => screen.queryByRole("dialog", { name: "More" }) === null, "the rail stands at the side once the window is wide");
    await act(async () => { row("m1").focus(); });
    await key("h");
    const rail = screen.getByRole("navigation", { name: "Places" });
    await waitFor(() => rail.contains(document.activeElement), "h walked into the rail");
    await key("Escape");
    await waitFor(() => !rail.contains(document.activeElement), "Escape left the rail");
    await rounds(4);
    expect(document.activeElement, "the keyboard is on the cursor's row").toBe(row("m1"));
  }, 30_000);

  for (const cursor of [false, true] as const) {
    it(`a row's own Done taken away under the keyboard leaves it in the seated list: on ${cursor ? "the cursor's row" : "the list's own stop, where no cursor stands"}`, async () => {
      sized(1440, 900);
      await seat({ letters: [msg("m1", { unread: true } as Partial<EngineMessage>)], hash: "#/ohbox" });
      await waitFor(() => rows().length === 1, "the seated list");
      const list = screen.getByRole("region", { name: "Messages" });
      if (cursor) {
        await key("j");
        await waitFor(() => cursorOn() === "m1", "the cursor on the one row");
      }
      const done = (): HTMLElement | null => within(list).queryByRole("button", { name: "Done" });
      await waitFor(() => done() !== null, "the row's own Done");
      await act(async () => { done()!.focus(); });
      await press(done(), "Done on the row");
      await waitFor(() => done() === null, "the letter read, its Done gone");
      await rounds(4);
      if (cursor) expect(document.activeElement, "the keyboard is on the cursor's row").toBe(row("m1"));
      else {
        expect(document.activeElement, "the keyboard did not fall to the page").not.toBe(document.body);
        expect(list.contains(document.activeElement), "it stands in the list").toBe(true);
        expect(document.activeElement, "on the list's own stop, not on a row nobody chose").not.toBe(row("m1"));
      }
    }, 30_000);
  }

  it("at 1440 wide l walks into the open letter and Escape back to its row, the letter still open", async () => {
    sized(1440, 900);
    await seat({ letters: [msg("m1"), msg("m2")], hash: "#/ohbox" });
    await waitFor(() => rows().length === 2, "the seated list");
    await press(row("m1"), "the row of m1");
    await waitFor(() => letterShown("m1"), "m1 open");
    await act(async () => { row("m1").focus(); });
    await key("l");
    await waitFor(() => reader().contains(document.activeElement), "the keyboard in the reading column");
    await key("Escape");
    await waitFor(() => document.activeElement === row("m1"), "the keyboard back on the row");
    expect(letterShown("m1"), "the letter is still open beside the list").toBe(true);
  }, 30_000);

  it("a verb that takes the open row opens the next row, by the list's own path, and says so in the frame's slot", async () => {
    sized(1440, 900);
    let answer!: (refused?: boolean) => void;
    const holdAnswer = () => {
      const pending = new Promise<void>((resolve, reject) => {
        answer = (refused) => refused ? reject(new MutationRejectedError("Park refused")) : resolve();
      });
      void pending.catch(() => undefined);
      return pending;
    };
    let pending = holdAnswer();
    const s = await seat({
      letters: [msg("m1"), msg("m2")], hash: "#/ohbox",
      beforeMutation: (m) => m.kind === "triage_set" && m.state === "set_aside" ? pending : Promise.resolve(),
    });
    await waitFor(() => rows().length === 2, "the seated list");
    const [top, next] = rows().map((r) => /Subject (m\d)$/.exec(r.getAttribute("aria-label") ?? "")![1]!);
    await press(row(top!), "the first row");
    await waitFor(() => letterShown(top!), "the first letter open");
    try {
      await press(within(reader()).getByRole("button", { name: "Park" }), "Park on the panel");
      await waitFor(() => letterShown(next!), "the next row's letter opened");
      expect(window.location.hash, "the address follows").toBe(`#/ohbox/m/${next}`);
      expect(s.sent.filter((m) => m.kind === "triage_set").length, "one filing").toBe(1);
      expect(inTheFramesSlot(), "the verb's answer is said in the frame's slot").toContain(en.ohbox.toastAside);
      expect(inTheCapsule(), "and not in today's capsule").not.toContain(en.ohbox.toastAside);
      await press(screen.getByRole("button", { name: /Undo/ }), "Undo Park while the server answers");
      expect(parks(s)).toEqual([top]);
      expect(s.sent.filter((m) => m.kind === "triage_set").map((m) => m.state)).toEqual(["set_aside"]);
    } finally {
      await act(async () => { answer(); });
    }
    await waitFor(() => rows().length === 2 && letterShown(top!), "Undo brought back the original letter");
    expect(s.sent.filter((m) => m.kind === "triage_set").map((m) => m.state)).toEqual(["set_aside", "none"]);

    pending = holdAnswer();
    try {
      await press(within(reader()).getByRole("button", { name: "Park" }), "Park on the panel again");
      await waitFor(() => rows().length === 1 && parks(s).length === 2, "the row is parked again while the server answers");
      await press(screen.getByRole("button", { name: /Undo/ }), "Undo before the refusal");
    } finally {
      await act(async () => { answer(true); });
    }
    await waitFor(() => rows().length === 2 && inTheFramesSlot().includes("Nothing changed"), "the refusal restores the row");
    expect(s.sent.filter((m) => m.kind === "triage_set").map((m) => m.state)).toEqual(["set_aside", "none", "set_aside"]);
  }, 30_000);
});

describe("a mailbox another install organizes", () => {
  it("Move over two picked rows is refused at the press: said once, nothing on the wire, and the two stay picked", async () => {
    sized(1440, 900);
    const organizedElsewhere: MailboxFacts[] = [{
      ...ROSTER[0]!, organizerRole: "reader" as const,
      organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-09-02T09:00:00.000Z" },
    } as MailboxFacts];
    const s = await seat({ letters: [msg("m1"), msg("m2"), msg("m3")], hash: "#/ohbox", roster: organizedElsewhere });
    await waitFor(() => rows().length === 3, "the seated list");
    const ids = order();
    await press(row(ids[0]!), "the first row");
    await waitFor(() => letterShown(ids[0]!), "the first letter open");
    await act(async () => { row(ids[0]!).focus(); });
    await typed("x");
    await typed("j");
    await waitFor(() => openId() === ids[1], "j showed the next row's letter");
    await typed("x");
    await waitFor(() => picked().length === 2, "two rows picked");
    /* The roster's answer has arrived: the refusal names who organizes the mailbox. */
    await rounds(8);
    const before = s.sent.length;

    await typed("m");
    const news = await (async () => {
      await waitFor(() => screen.queryByRole("menuitem", { name: "News" }) !== null, "the set's Move asks where to");
      return screen.getByRole("menuitem", { name: "News" });
    })();
    await press(news, "News");
    const refused = en.screener.readerMoveRefused.replace("{name}", "ohmail Cloud").replace(/\.$/, "");
    await waitFor(() => inTheFramesSlot().includes(refused), "the refusal said in the frame's slot");
    await rounds(8);
    expect(s.sent.slice(before), "nothing reached the wire").toEqual([]);
    expect(picked(), "the two rows stay picked").toEqual([ids[0]!, ids[1]!].sort());
    expect(order(), "and stay in the list").toEqual(ids);
  }, 30_000);
});

describe("a verb that takes the open row follows the stored choice", () => {
  /* "advance" with one row: the default, and no row to advance to. */
  for (const [choice, n] of [["stay", 3], ["close", 3], ["advance", 1]] as const) {
    it(`"${choice}"${n === 1 ? " with no row left" : ""}: Park on the open row files it, opens no next letter, and the reading column rests; Undo puts the row and the cursor back`, async () => {
      sized(1440, 900);
      window.localStorage.setItem(AFTER_VERB_STORAGE_KEY, choice);
      const s = await seat({ letters: ["m1", "m2", "m3"].slice(0, n).map((id) => msg(id)), hash: "#/ohbox" });
      await waitFor(() => rows().length === n, "the seated list");
      const ids = order();
      await press(row(ids[0]!), "the first row");
      await waitFor(() => letterShown(ids[0]!), "the first letter open");
      await act(async () => { row(ids[0]!).focus(); });
      await typed("e");
      await waitFor(() => parks(s).length > 0 && rows().length === n - 1, "e parked the open row and it left the list");
      await rounds(12);
      expect(parks(s), "one filing, of the open row").toEqual([ids[0]]);
      expect(ids.filter((id) => letterShown(id)), "no letter is shown: not the next row's, not the one filed").toEqual([]);
      expect(cursorOn(), "and the list marks no row").toBeNull();
      expect(window.location.hash, "the address names no letter").toBe("#/ohbox");

      await typed("z");
      await waitFor(() => rows().length === n, "Undo put the row back");
      await waitFor(() => cursorOn() === ids[0] && letterShown(ids[0]!), "and the cursor on it, its letter beside the list again");
    }, 30_000);
  }
});

describe("the composer, closed, gives the keyboard back to the list it left", () => {
  /** `c` leaves the Ohbox for the composer, and Escape comes back to a list drawn again. */
  async function openComposer(): Promise<void> {
    await typed("c");
    await waitFor(() => window.location.hash.startsWith("#/compose"), "c reached the composer");
    await rounds(6);
  }
  async function composeAndBack(n: number, whileWriting?: () => Promise<void>): Promise<void> {
    await openComposer();
    await whileWriting?.();
    await typed("Escape");
    await waitFor(() => window.location.hash.startsWith("#/ohbox") && rows().length === n, "Escape came back to the Ohbox");
    await rounds(12);
  }
  const keyboardOn = (): string => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return "the page";
    return `${el.getAttribute("role") ?? el.tagName.toLowerCase()} ${el.getAttribute("aria-label") ?? (el.textContent ?? "").trim().slice(0, 30)}`;
  };
  const list = (): HTMLElement => screen.getByRole("region", { name: "Messages" });

  it("from the open letter's row: back on that row, never on a control of the page, where the next Enter would press it", async () => {
    sized(1440, 900);
    await seat({ letters: [msg("m1"), msg("m2"), msg("m3"), msg("m4")], hash: "#/ohbox" });
    await waitFor(() => rows().length === 4, "the seated list");
    const second = order()[1]!;
    await press(row(second), "the second row");
    await waitFor(() => readers().length === 1 && openId() === second, "its letter open");
    await act(async () => { row(second).focus(); });
    expect(document.activeElement, "the premise: the row holds the keyboard").toBe(row(second));
    await composeAndBack(4);
    expect(keyboardOn(), "after the composer closed the keyboard is on the row it left").toBe(`option ${row(second).getAttribute("aria-label")}`);
    expect(document.activeElement).toBe(row(second));
  }, 30_000);

  it("from a row that holds the keyboard with no letter open: back on that row", async () => {
    sized(1440, 900);
    await seat({ letters: [msg("m1"), msg("m2"), msg("m3"), msg("m4")], hash: "#/ohbox" });
    await waitFor(() => rows().length === 4, "the seated list");
    const third = order()[2]!;
    await act(async () => { row(third).focus(); });
    expect(cursorOn(), "the premise: no cursor row").toBeNull();
    expect(document.activeElement, "the premise: the row holds the keyboard").toBe(row(third));
    await composeAndBack(4);
    expect(keyboardOn(), "after the composer closed the keyboard is on the row it left").toBe(`option ${row(third).getAttribute("aria-label")}`);
  }, 30_000);

  async function threeRows(): Promise<Seated> {
    sized(1440, 900);
    const host = await seat({ letters: [msg("m1"), msg("m2"), msg("m3")], hash: "#/ohbox" });
    await waitFor(() => rows().length === 3, "the seated list");
    return host;
  }

  it("returns to the focused row when a different letter is open", async () => {
    await threeRows();
    const [open, origin] = order();
    await press(row(open!), "the first row");
    await waitFor(() => openId() === open, "its letter open");
    await act(async () => { row(origin!).focus(); });
    await composeAndBack(3);
    expect(document.activeElement).toBe(row(origin!));
  }, 30_000);

  it("returns to the next row when the original row disappears while writing", async () => {
    await threeRows();
    const [, origin, next] = order();
    await act(async () => { row(origin!).focus(); });
    await composeAndBack(2, () => tombstone(origin!));
    expect(document.activeElement).toBe(row(next!));
  }, 30_000);

  it("returns from the letter's foot to the row that opened it", async () => {
    await threeRows();
    const origin = order()[1]!;
    await act(async () => { row(origin).focus(); });
    await composeAndBack(3, async () => {
      const letter = screen.getByRole("region", { name: en.write.letter });
      const foot = within(letter).getByRole("toolbar", { name: en.write.verbs });
      const discard = within(foot).getByRole("button", { name: en.write.discard });
      await act(async () => { discard.focus(); });
      expect(document.activeElement).toBe(discard);
    });
    expect(document.activeElement).toBe(row(origin));
  }, 30_000);

  it("preserves a deliberate move from the letter to the rail", async () => {
    await threeRows();
    await act(async () => { rows()[1]!.focus(); });
    await openComposer();
    const rail = screen.getByRole("navigation", { name: "Places" });
    const control = within(rail).getAllByRole("button")[0]!;
    await act(async () => { control.focus(); });
    expect(document.activeElement).toBe(control);
    await visit("#/ohbox");
    await waitFor(() => rows().length === 3, "the list returned");
    await rounds(12);
    expect(document.activeElement).toBe(control);
  }, 30_000);

  it("leaves the originating row behind when the host switches accounts", async () => {
    const host = await threeRows();
    const origin = order()[1]!;
    await act(async () => { row(origin).focus(); });
    await openComposer();
    await act(async () => {
      window.location.hash = "#/ohbox";
      await host.changeScope("other-account");
    });
    await waitFor(() => rows().length === 3, "the next account has the same message ids");
    await rounds(12);
    expect(document.activeElement).not.toBe(row(origin));
  }, 30_000);

  it("leaves the keyboard in a host dialog that stays open as the letter closes", async () => {
    await threeRows();
    await act(async () => { rows()[1]!.focus(); });
    await openComposer();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const close = dialog.appendChild(document.createElement("button"));
    close.textContent = "Close";
    document.body.append(dialog);
    try {
      await visit("#/ohbox");
      await waitFor(() => rows().length === 3, "the list returned under the dialog");
      await rounds(12);
      expect(document.activeElement).toBe(close);
    } finally {
      dialog.remove();
    }
  }, 30_000);

  it("from a control of the list's head with a letter open: on the cursor's row", async () => {
    sized(1440, 900);
    await seat({ letters: [msg("m1"), msg("m2"), msg("m3"), msg("m4")], hash: "#/ohbox" });
    await waitFor(() => rows().length === 4, "the seated list");
    const second = order()[1]!;
    await press(row(second), "the second row");
    await waitFor(() => readers().length === 1 && openId() === second, "its letter open");
    const head = listMenu(list());
    await act(async () => { head.focus(); });
    expect(document.activeElement, "the premise: a control of the head holds the keyboard").toBe(head);
    await composeAndBack(4);
    expect(keyboardOn(), "after the composer closed the keyboard is on the cursor's row").toBe(`option ${row(second).getAttribute("aria-label")}`);
  }, 30_000);

  it("with no cursor in the list and nothing holding the keyboard: on the list's own stop", async () => {
    sized(1440, 900);
    await seat({ letters: [msg("m1"), msg("m2"), msg("m3"), msg("m4")], hash: "#/ohbox" });
    await waitFor(() => rows().length === 4, "the seated list");
    expect(cursorOn(), "the premise: no cursor row").toBeNull();
    await composeAndBack(4);
    const at = document.activeElement as HTMLElement | null;
    expect(at !== null && list().contains(at), `after the composer closed the keyboard is on ${keyboardOn()}: in the list`).toBe(true);
    expect([at?.getAttribute("role") ?? null, at?.tagName], "on the list's own stop: no row, no control").not.toContain("option");
    expect(at?.tagName, "and no button").not.toBe("BUTTON");
  }, 30_000);
});

describe("with rows picked the verb keys act on the picked set, never on the open letter", () => {
  const some = (n: number): EngineMessage[] => ["m1", "m2", "m3", "m4", "m5"].slice(0, n).map((id) => msg(id));

  /** At 1440: the row at `from` opened and picked. */
  async function openedAndPicked(n: number, from: number): Promise<{ s: Seated; ids: string[] }> {
    sized(1440, 900);
    const s = await seat({ letters: some(n), hash: "#/ohbox" });
    await waitFor(() => rows().length === n, "the seated list");
    const ids = order();
    await press(row(ids[from]!), "the row the walk starts from");
    await waitFor(() => readers().length === 1 && openId() === ids[from], "its letter open");
    await act(async () => { row(ids[from]!).focus(); });
    await typed("x");
    await waitFor(() => picked().length === 1, "x picked the open row");
    return { s, ids };
  }
  /** One row further: `j` shows the next letter, `x` picks it too when asked. */
  async function next(ids: string[], to: number, pick: boolean): Promise<void> {
    await typed("j");
    await waitFor(() => openId() === ids[to], "j showed the next row's letter");
    await rounds(4);
    if (!pick) return;
    const before = picked().length;
    await typed("x");
    await waitFor(() => picked().length === before + 1, "x picked it");
  }
  /** On one column: the first two rows picked by the cursor, then the cursor row's letter stood over the list. */
  async function twoPickedAndALetterOver(): Promise<{ s: Seated; ids: string[] }> {
    sized(390, 844);
    const s = await seat({ letters: some(4), hash: "#/ohbox" });
    await waitFor(() => rows().length === 4, "the seated list");
    const ids = order();
    for (const n of [1, 2]) {
      await typed("j");
      await rounds(2);
      await typed("x");
      await waitFor(() => picked().length === n, "x picked the cursor row");
    }
    await typed("Enter");
    await waitFor(() => readers().length === 1, "Enter stood a letter over the list");
    await rounds(6);
    return { s, ids };
  }

  it("one row picked, its own letter open: e parks it", async () => {
    const { s, ids } = await openedAndPicked(4, 0);
    await typed("e");
    await waitFor(() => parks(s).length > 0, "e parked something");
    await rounds(6);
    expect(parks(s), "the one picked letter").toEqual([ids[0]]);
  }, 30_000);

  for (const from of [0, 1] as const) {
    it(`two rows picked from the ${from === 0 ? "first" : "second"} row, the second one's letter open: e parks the two`, async () => {
      const { s, ids } = await openedAndPicked(5, from);
      await next(ids, from + 1, true);
      await typed("e");
      await waitFor(() => parks(s).length > 0, "e parked something");
      await rounds(8);
      expect(parks(s), `e with two picked and ${ids[from + 1]} open parked`).toEqual([ids[from]!, ids[from + 1]!].sort());
    }, 30_000);

    it(`two rows picked from the ${from === 0 ? "first" : "second"} row: Backspace takes both into its window, and the rows nobody picked stay`, async () => {
      const { ids } = await openedAndPicked(5, from);
      await next(ids, from + 1, true);
      await typed("Backspace");
      await waitFor(() => rows().length < 5, "Backspace took something");
      await rounds(8);
      expect(order().sort(), "the rows left").toEqual(ids.filter((_, i) => i !== from && i !== from + 1).sort());
    }, 30_000);
  }

  it("shift+j from the open first letter picks two, and e parks both", async () => {
    sized(1440, 900);
    const s = await seat({ letters: some(4), hash: "#/ohbox" });
    await waitFor(() => rows().length === 4, "the seated list");
    const ids = order();
    await press(row(ids[0]!), "the first row");
    await waitFor(() => readers().length === 1 && openId() === ids[0], "the first letter open");
    await act(async () => { row(ids[0]!).focus(); });
    await typed("J", { shiftKey: true });
    await waitFor(() => picked().length === 2, "shift+j picked two rows");
    await rounds(6);
    await typed("e");
    await waitFor(() => parks(s).length > 0, "e parked something");
    await rounds(8);
    expect(parks(s), "e after shift+j parked").toEqual([ids[0]!, ids[1]!].sort());
  }, 30_000);

  it("on one column, two rows picked and a letter over the list: e parks the two picked", async () => {
    const { s, ids } = await twoPickedAndALetterOver();
    await typed("e");
    await waitFor(() => parks(s).length > 0, "e parked something");
    await rounds(8);
    expect(parks(s), `e with two picked and ${openId()} over the list parked`).toEqual([ids[0]!, ids[1]!].sort());
  }, 30_000);

  it("on one column, two rows picked and a letter over the list: Backspace takes the two picked", async () => {
    const { ids } = await twoPickedAndALetterOver();
    await typed("Backspace");
    await waitFor(() => rows().length < 4, "Backspace took something");
    await rounds(8);
    expect(order().sort(), "the rows left").toEqual([ids[2]!, ids[3]!].sort());
  }, 30_000);

  it("one row picked and another letter open that nobody picked: Backspace takes the picked row, and the open letter stays", async () => {
    const { s, ids } = await openedAndPicked(5, 1);
    await next(ids, 2, false);
    await next(ids, 3, false);
    expect(picked(), "the premise: only the second row is picked").toEqual([ids[1]]);
    await typed("Backspace");
    await waitFor(() => rows().length < 5, "Backspace took something");
    await rounds(8);
    expect(order().sort(), `the rows left with ${ids[1]} picked and ${ids[3]} open`).toEqual(ids.filter((_, i) => i !== 1).sort());
    expect(deletes(s), "held for its window: nothing left yet").toEqual([]);
  }, 30_000);

  it("two rows picked: d asks about the set, and opens no More of the open letter", async () => {
    const { ids } = await openedAndPicked(5, 1);
    await next(ids, 2, true);
    await typed("d");
    await rounds(8);
    expect(screen.queryAllByRole("menu").map((m) => m.getAttribute("aria-label") ?? "?"), "the menus d opened").toEqual([]);
    expect(screen.queryByRole("dialog", { name: /\b2\b/ }), "the set's ask, naming the two").not.toBeNull();
  }, 30_000);
});
