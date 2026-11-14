/** @vitest-environment jsdom */
/**
 * NEW MAIL IS LATE, SAID ON THE PHONE. For 26 hours the service fetched no mailbox while its server
 * answered: a paired phone showed its mail as ever and a pull spun and settled on nothing. The
 * server now says so on each mailbox row and on the pull's answer (`fetching`). Here the phone's
 * own read of the rows feeds the strip over the Ohbox, and the pull says it at once.
 *
 * Mutations watched red: the row read dropping `fetching` (the strip never draws); `lateWho`
 * answering "cloud" for every session (the self-hosted cases say Cloud, the standalone one draws);
 * the strip ignoring the top line (the offline and outage cases); `heard` never called by the
 * pull (the pull cases).
 */
import { createElement as h, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount as mountDom } from "./_rendered-dom";
import type { PhoneMailbox } from "../src/net/mailboxes";

const scene = vi.hoisted(() => ({ world: null as unknown, session: null as unknown }));

vi.mock("react-native", async () => (await import("./_rendered-dom")).rnDom);
vi.mock("../src/state/world", () => ({ useWorld: () => scene.world }));
vi.mock("../src/net/connection", () => ({ useConnection: () => ({ state: { k: "live", session: scene.session } }) }));
/* The parts keep what a screen reader is told (the role) and what can be pressed. */
vi.mock("../src/ui/base", () => ({
  Panel: (p: { children?: ReactNode }) => h("div", { "data-panel": "" }, p.children),
  Txt: (p: { children?: ReactNode; accessibilityRole?: string }) => h("span", { role: p.accessibilityRole }, p.children),
  Button: (p: { label: string; onPress?: () => void }) => h("button", { onClick: p.onPress }, p.label),
}));

import { Copy, DECKS } from "../src/copy";
import { setActiveLocale } from "../src/i18n/locale";
import { readMailboxes } from "../src/net/mailboxes";
import { installNetworkReader } from "../src/net/network-door";
import type { ConnectedSession } from "../src/net/pairing";
import { pullRound } from "../src/state/pull-round";
import { readerZone, setTimeLabel } from "../src/state/live";
import { LateStrip } from "../src/ui/LateStrip";
import { lateStripSaid, lateWho, notCheckedNoteSaid } from "../src/ui/late-lines";

const NOW = new Date("2026-11-13T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
/** The time as the phone says it in a sentence. */
const stamp = (iso: string, locale = "en"): string => setTimeLabel(iso, NOW, readerZone(), locale);

/** One mailbox row as `GET /mailboxes` carries it; `fetching` only when a case names it. */
const wireRow = (fetching?: unknown, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "m-1", address: "person@example.test", status: "connected", organizerRole: "organizer",
  lastSyncAt: ago(50 * MIN), ...(fetching === undefined ? {} : { fetching }), ...over,
});

/** A paired session whose server answers `rows` for the mailbox list. */
function sessionOf(flavor: string, rows: Record<string, unknown>[], standalone = false): ConnectedSession {
  return {
    standalone,
    profile: { origin: "https://server.example", apiBase: null, flavor },
    async fetch() { return Response.json({ items: rows }); },
  } as unknown as ConnectedSession;
}

/** The world a screen reads, over the rows this phone's own read returned. */
async function worldOver(session: ConnectedSession, boot: Record<string, unknown> = {}): Promise<PhoneMailbox[]> {
  const rows = (await readMailboxes(session)) ?? [];
  scene.session = session;
  scene.world = {
    standalone: session.standalone,
    boot: { connection: null, staleAsOf: null, draining: false, ...boot },
    mailboxes: { known: true, rows },
  };
  return rows;
}

/** Every view a case mounted, taken down before the network door or the clock is put back. */
const views: Array<{ unmount(): void }> = [];
const mount = (node: ReactNode): ReturnType<typeof mountDom> => {
  const view = mountDom(node);
  const unmount = view.unmount;
  let gone = false;
  view.unmount = () => { if (!gone) { gone = true; unmount(); } };
  views.push(view);
  return view;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  installNetworkReader({ read: () => "online", subscribe: () => () => undefined });
});
afterEach(() => {
  while (views.length > 0) views.pop()!.unmount();
  vi.useRealTimers();
  installNetworkReader(null);
  setActiveLocale("en");
  document.body.innerHTML = "";
});

describe("the phone's read of a mailbox row carries the server's word on fetching", () => {
  const read = async (fetching?: unknown): Promise<PhoneMailbox> =>
    (await readMailboxes(sessionOf("managed", [wireRow(fetching)])))![0]!;

  it("behind with its time, behind with none, and not behind", async () => {
    expect((await read({ behind: true, since: ago(50 * MIN) })).fetching).toEqual({ behind: true, since: ago(50 * MIN) });
    expect((await read({ behind: true, since: null })).fetching).toEqual({ behind: true, since: null });
    expect((await read({ behind: false, since: ago(MIN) })).fetching).toEqual({ behind: false, since: ago(MIN) });
  });

  it("null stays null, an absent key stays absent, and an unreadable value says nothing", async () => {
    expect((await read(null)).fetching).toBeNull();
    expect("fetching" in (await read(undefined))).toBe(false);
    expect((await read("late")).fetching).toBeNull();
    // Only a plain `true` is behind: anything else on the wire is not a statement that it is.
    expect((await read({ behind: "yes", since: ago(MIN) })).fetching).toEqual({ behind: false, since: ago(MIN) });
  });
});

describe("the strip over the Ohbox says new mail is late, for as long as the server says so", () => {
  const notice = (el: HTMLElement): HTMLElement | null => el.querySelector<HTMLElement>('[role="summary"]');

  it("arrives with the server's time, and leaves when the next read says fetching runs", async () => {
    await worldOver(sessionOf("managed", [wireRow({ behind: true, since: ago(50 * MIN) })]));
    const view = mount(h(LateStrip));
    expect(notice(view.el)?.textContent).toBe(Copy.lateTitle);
    expect(view.el.textContent).toContain(Copy.lateLineCloud(stamp(ago(50 * MIN))));

    await worldOver(sessionOf("managed", [wireRow({ behind: false, since: ago(MIN) })]));
    view.render(h(LateStrip));
    expect(view.el.textContent ?? "", "the strip stayed, or an all-clear was drawn").toBe("");
  });

  it.each([
    ["null: this server does not say", null],
    ["absent: an older server", undefined],
    ["not behind", { behind: false, since: ago(MIN) }],
  ] as Array<[string, unknown]>)("draws nothing for %s", async (_what, fetching) => {
    await worldOver(sessionOf("managed", [wireRow(fetching)]));
    expect(mount(h(LateStrip)).el.textContent ?? "").toBe("");
  });

  /* Which mailboxes the server speaks for is the server's rule: every mailbox it is on duty to fetch,
     also one it reads for another organizer, and none it has left out. The phone has no role test
     of its own and draws each row as given. */
  it("a mailbox the server reads for another organizer is late like any other, and silent once the server leaves it out", async () => {
    const reader = { organizerRole: "reader" };
    await worldOver(sessionOf("managed", [wireRow({ behind: true, since: ago(50 * MIN) }, reader)]));
    const view = mount(h(LateStrip));
    expect(notice(view.el)?.textContent).toBe(Copy.lateTitle);
    // Past the server's capacity it is off the roster, and the server takes its word off the row.
    const leftOut = { ...reader, syncBlockedReason: "at_capacity", syncBlockedSince: ago(MIN) };
    await worldOver(sessionOf("managed", [wireRow(null, leftOut)]));
    view.render(h(LateStrip));
    expect(view.el.textContent ?? "").toBe("");
  });

  it("is one calm strip with nothing to press and no way to dismiss it", async () => {
    await worldOver(sessionOf("managed", [wireRow({ behind: true, since: ago(50 * MIN) })]));
    const view = mount(h(LateStrip));
    expect(notice(view.el)).not.toBeNull();
    expect(view.el.querySelector('[role="alert"]')).toBeNull();
    expect(view.el.querySelectorAll("button")).toHaveLength(0);
  });

  it("with no time on record it says so without one; after a day it says that plainly", async () => {
    await worldOver(sessionOf("managed", [wireRow({ behind: true, since: null })]));
    let view = mount(h(LateStrip));
    expect(view.el.textContent).toContain(Copy.lateLineCloudNoTime);
    view.unmount();

    await worldOver(sessionOf("managed", [wireRow({ behind: true, since: ago(26 * HOUR) })]));
    view = mount(h(LateStrip));
    expect(notice(view.el)?.textContent).toBe(Copy.lateTitleDays(1));
    expect(view.el.textContent).toContain(Copy.lateLineCloudDay(stamp(ago(26 * HOUR))));
  });

  it("the time is the newest the behind rows carry", async () => {
    const rows = await worldOver(sessionOf("managed", [
      wireRow({ behind: true, since: ago(3 * HOUR) }),
      wireRow({ behind: true, since: ago(50 * MIN) }, { id: "m-2", address: "second@example.test" }),
      wireRow({ behind: false, since: ago(MIN) }, { id: "m-3", address: "third@example.test" }),
    ]));
    expect(lateStripSaid(rows, NOW.getTime(), readerZone(), "en", "cloud")?.line)
      .toBe(Copy.lateLineCloud(stamp(ago(50 * MIN))));
  });

  it.each(["en", "de"] as const)("%s: a server somebody runs is named your ohmail server, never ohmail Cloud", async (locale) => {
    setActiveLocale(locale);
    for (const since of [ago(50 * MIN), null, ago(26 * HOUR)]) {
      await worldOver(sessionOf("selfhost", [wireRow({ behind: true, since })]));
      const view = mount(h(LateStrip));
      expect(view.el.textContent)
        .toContain(since === null ? Copy.lateLineServerNoTime : Copy.lateLineServer(stamp(since, locale)));
      expect(view.el.textContent ?? "", "a self-hosted server was called Cloud").not.toMatch(/Cloud/);
      view.unmount();
    }
    // The day still shows in the title; "on us" is said of our own service only.
    expect(lateStripSaid(await worldOver(sessionOf("selfhost", [wireRow({ behind: true, since: ago(26 * HOUR) })])),
      NOW.getTime(), readerZone(), locale, "server")?.title).toBe(Copy.lateTitleDays(1));
  });

  it("a phone that organizes on its own draws nothing, whatever a row carries", async () => {
    await worldOver(sessionOf("local", [wireRow(null)], true));
    expect(mount(h(LateStrip)).el.textContent ?? "").toBe("");
    expect(lateWho(sessionOf("local", [], true))).toBeNull();
    expect(lateWho(sessionOf("managed", []))).toBe("cloud");
    expect(lateWho(sessionOf("selfhost", []))).toBe("server");
    expect(lateWho(null)).toBeNull();
  });

  it("with no network, or the server not answering, the top line says that and this stays out", async () => {
    await worldOver(sessionOf("managed", [wireRow({ behind: true, since: ago(50 * MIN) })]));
    installNetworkReader({ read: () => "offline", subscribe: () => () => undefined });
    const offline = mount(h(LateStrip));
    expect(offline.el.textContent ?? "").toBe("");
    offline.unmount();

    installNetworkReader({ read: () => "online", subscribe: () => () => undefined });
    await worldOver(sessionOf("managed", [wireRow({ behind: true, since: ago(50 * MIN) })]), { connection: { kind: "lost" } });
    expect(mount(h(LateStrip)).el.textContent ?? "").toBe("");
  });

  it("is German in German, and both decks carry every sentence", async () => {
    setActiveLocale("de");
    await worldOver(sessionOf("managed", [wireRow({ behind: true, since: ago(50 * MIN) })]));
    const view = mount(h(LateStrip));
    expect(notice(view.el)?.textContent).toBe(DECKS.de.lateTitle);
    expect(view.el.textContent).toContain(DECKS.de.lateLineCloud(stamp(ago(50 * MIN), "de")));
    for (const key of ["lateTitle", "pullBehind", "pullBehindServer"] as const) {
      expect(DECKS.de[key], `${key} is English in the German deck`).not.toBe(DECKS.en[key]);
    }
    for (const deck of [DECKS.en, DECKS.de]) {
      for (const said of [deck.lateLineServer("09:14"), deck.lateLineServerNoTime, deck.pullBehindServer,
        deck.notCheckedNoteServer("09:14"), deck.notCheckedNoteServerNoTime]) {
        expect(said).not.toMatch(/Cloud/);
      }
      expect(deck.lateLineCloud("09:14")).toContain("ohmail Cloud");
      expect(deck.lateLineCloud("09:14")).toContain("09:14");
    }
  });
});

describe("a pull says at once when the server is not fetching", () => {
  /** A round whose ring answers `fetching` now and whose drain settles only when released. */
  function round(fetching: unknown) {
    let release = (): void => undefined;
    const settled = new Promise<void>((r) => { release = r; });
    const ring = (heard: (ring: never) => void): Promise<void> => {
      heard({ requested: 1, requestedAt: ago(0), mailboxes: [], ...(fetching === undefined ? {} : { fetching }) } as never);
      return settled;
    };
    return { ring, release };
  }

  it("the sentence is said when the ring answers, before the round settles", async () => {
    const said: string[] = [];
    const r = round({ behind: true, since: ago(50 * MIN) });
    const pulling = pullRound("online", r.ring, (x) => said.push(x.say), "cloud");
    expect(said).toEqual(["pullBehind"]);
    r.release();
    await pulling;
    expect(said).toEqual(["pullBehind"]);
  });

  it("names a server somebody runs, and says nothing on a phone that organizes on its own", async () => {
    const said: string[] = [];
    const late = round({ behind: true, since: null });
    late.release();
    await pullRound("online", late.ring, (x) => said.push(x.say), "server");
    expect(said).toEqual(["pullBehindServer"]);
    await pullRound("online", late.ring, (x) => said.push(x.say), null);
    expect(said).toEqual(["pullBehindServer"]);
  });

  it.each([
    ["not behind", { behind: false, since: ago(MIN) }],
    ["null: this server does not say", null],
    ["absent: an older server", undefined],
  ] as Array<[string, unknown]>)("CONTROL: %s says nothing, and the round is the round", async (_what, fetching) => {
    const said: string[] = [];
    const r = round(fetching);
    r.release();
    await pullRound("online", r.ring, (x) => said.push(x.say), "cloud");
    expect(said).toEqual([]);
  });

  it("CONTROL: a ring that was refused answers null and says nothing", async () => {
    const said: string[] = [];
    await pullRound("online", (heard) => { heard(null); return Promise.resolve(); }, (x) => said.push(x.say), "cloud");
    expect(said).toEqual([]);
  });

  it("CONTROL: with no network the pull still says that and rings nothing", async () => {
    const said: string[] = [];
    let rung = 0;
    await pullRound("offline", () => { rung += 1; return Promise.resolve(); }, (x) => said.push(x.say), "cloud");
    expect(rung).toBe(0);
    expect(said).toEqual(["networkOffline"]);
  });
});

describe("the mailbox's own note", () => {
  it("is the notice's sentence for that mailbox, and absent where its row says nothing", async () => {
    const [late, quiet] = await worldOver(sessionOf("managed", [
      wireRow({ behind: true, since: ago(50 * MIN) }),
      wireRow(null, { id: "m-2", address: "second@example.test" }),
    ])) as [PhoneMailbox, PhoneMailbox];
    expect(notCheckedNoteSaid(late, NOW.getTime(), readerZone(), "en", "cloud"))
      .toBe(Copy.notCheckedNoteCloud(stamp(ago(50 * MIN))));
    expect(notCheckedNoteSaid(late, NOW.getTime(), readerZone(), "en", "server"))
      .toBe(Copy.notCheckedNoteServer(stamp(ago(50 * MIN))));
    expect(notCheckedNoteSaid(quiet, NOW.getTime(), readerZone(), "en", "cloud")).toBeNull();
    expect(notCheckedNoteSaid(late, NOW.getTime(), readerZone(), "en", null)).toBeNull();
  });
});
