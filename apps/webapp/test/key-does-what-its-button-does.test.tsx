/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { FixturesAdapter, type EngineMutation } from "@ohmail/client-engine";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";

/**
 * A KEY THE SHEET LISTS DOES IN THAT VIEW WHAT ITS BUTTON DOES.
 *
 * Measured on 0.25.1: `b` on a booked row cancelled the booking where
 * the Resurface button printing `b` opens the horizon chooser; in News `m` and `d` opened a strip
 * on the cursor's card while the only bar on screen was another card's. Driven through the shell,
 * counted at the adapter, each key beside its button.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let sent: EngineMutation[] = [];

function setViewport(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

async function settle(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await act(async () => { await Promise.resolve(); });
}

async function mountShell(hash: string, opts: { faces?: boolean } = {}): Promise<void> {
  await unmount();
  window.location.hash = hash;
  const { AppShell } = await import("../app/shell/AppShell.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          ...(opts.faces ? { faces: true } : {}),
          children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
        }),
      }),
    );
  });
  await settle();
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
  await settle(2);
};

const click = async (el: Element | null | undefined): Promise<void> => {
  expect(el, "nothing to click").toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle(2);
};

/** Every bar on screen, by its text — the strip a panel puts in the bar's place included. */
const bars = (): string[] =>
  [...host!.querySelectorAll(".abar")].map((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim());
const barButton = (label: string): HTMLButtonElement | undefined =>
  [...host!.querySelectorAll<HTMLButtonElement>(".abar button")]
    .find((b) => (b.textContent ?? "").trim().startsWith(label));
const kinds = (kind: string) => sent.filter((m) => m.kind === kind);

beforeEach(() => {
  vi.useFakeTimers();
  setViewport();
  sent = [];
  const real = FixturesAdapter.prototype.mutate;
  vi.spyOn(FixturesAdapter.prototype, "mutate").mockImplementation(async function (
    this: FixturesAdapter,
    ...args: Parameters<FixturesAdapter["mutate"]>
  ) {
    sent.push(args[0] as EngineMutation);
    return real.apply(this, args);
  } as never);
});

afterEach(async () => {
  await unmount();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/* The shell's first import is paid once here, not inside the first case's five seconds. */
beforeAll(async () => { await import("../app/shell/AppShell.js"); }, 120_000);

/** `g b`, and the hash change's own task — jsdom dispatches `hashchange` on a timer. */
async function goToThePile(): Promise<void> {
  await key("g"); await key("b");
  await act(async () => { vi.advanceTimersByTime(50); });
  await settle();
}

/** The strip a bar panel puts in the bar's place, by what it asks. */
const STRIP = { m: /move to/i, d: /Delete this message\?/, b: /Resurface when\?/ } as const;
const stripShown = (k: keyof typeof STRIP): boolean => bars().some((b) => STRIP[k].test(b));

describe("`b` on a booked row opens the chooser its button opens", () => {
  it("in the Resurface pile, `b` offers Now instead of cancelling the booking; Now pins it", async () => {
    await mountShell("#/ohbox");
    await key("j");
    await key("b");
    expect(kinds("triage_set").map((m) => (m as { state: string }).state), "the quick default did not book").toEqual(["bubbled_up"]);
    await goToThePile();
    sent = [];
    await key("b");
    expect(kinds("triage_set"), "`b` cancelled the booking — the button offers a chooser").toEqual([]);
    expect(stripShown("b"), `no chooser on screen: ${JSON.stringify(bars())}`).toBe(true);
    await click(barButton("Now"));
    expect(kinds("triage_set").map((m) => (m as { state: string }).state)).toEqual(["resurfaced"]);
  });

  it("the control: the bar's own Resurface button opens the same chooser", async () => {
    await mountShell("#/ohbox");
    await key("j");
    await key("b");
    await goToThePile();
    await click(host!.querySelector(".abar-resurface"));
    expect(stripShown("b"), `no chooser on screen: ${JSON.stringify(bars())}`).toBe(true);
  });
});

/** Put the stream's cursor on its first card WITHOUT opening it — `j`, as the tester did. */
async function cursorOnStream(hash: string): Promise<void> {
  await mountShell(hash);
  await settle();
  await key("j");
  await settle();
}

describe("in the streams `m` and `d` open their strip on the card the cursor names", () => {
  for (const [view, hash] of [["News", "#/reads"], ["Receipts", "#/receipts"]] as const) {
    for (const k of ["m", "d"] as const) {
      it(`${view}: \`${k}\` on a card with no bar opens that card with the strip`, async () => {
        await cursorOnStream(hash);
        expect(stripShown(k), "a strip was up before the key").toBe(false);
        await key(k);
        await settle();
        expect(stripShown(k), `${view}: \`${k}\` opened nothing: ${JSON.stringify(bars())}`).toBe(true);
      });
    }
  }
});

describe("the census — every bar-twinned key the sheet lists, pressed in each view, opens its strip", () => {
  const VIEWS = [["the Ohbox", "#/ohbox"], ["News", "#/reads"], ["Receipts", "#/receipts"]] as const;
  /** What `k` does in the view mounted now: true when its strip is on screen afterwards. */
  async function pressIn(hash: string, k: "m" | "d"): Promise<boolean> {
    await cursorOnStream(hash);
    await key(k);
    await settle();
    const ok = stripShown(k);
    await key("Escape");
    return ok;
  }
  for (const [name, hash] of VIEWS) {
    it(`${name}: m and d do what the Move and Delete buttons do`, async () => {
      expect(await pressIn(hash, "m"), `m in ${name}`).toBe(true);
      expect(await pressIn(hash, "d"), `d in ${name}`).toBe(true);
    });
  }

  /* THE PLANTED CONTROL — the probe above, over a surface under the real registry where `m` is
     bound to nothing and then to a binding that raises a strip. A probe that cannot read the
     first as dead would pass every view for nothing. */
  it("the planted control: the probe reads a key bound to nothing as dead, and a live one as live", async () => {
    const { KeymapProvider, useKeyBindings } = await import("../app/shell/keymap.js");
    function Surface({ live }: { live: boolean }): React.ReactElement {
      const [open, setOpen] = React.useState(false);
      useKeyBindings([{ chord: "m", group: "message", label: "Move to another place", run: () => { if (live) setOpen(true); } }]);
      return h("div", { className: "abar" }, open ? "move to → Ohbox" : "Reply Forward");
    }
    for (const live of [false, true]) {
      await unmount();
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => { root!.render(h(KeymapProvider, { children: h(Surface, { live }) })); });
      await settle();
      await key("m");
      expect(stripShown("m"), `planted live=${live}`).toBe(live);
    }
  });
});

/* ── `z`, "Undo last action", over every delayed-commit press ──────────────────
   Measured on 0.25.1: in the Screener `r` then `z` inside the Undo window left the decision to
   commit, while the toast's own Undo took it back. Each press here is driven twice — the button,
   then the key — and both must leave the wire empty past the window and say the same sentence. */

/** The Undo capsule's button, while one stands. */
const undoCapsule = (): HTMLButtonElement | null => host!.querySelector<HTMLButtonElement>(".toast-held .toast-act");
/** Every sentence on screen, the capsule's and the notice's. */
const said = (): string =>
  [...host!.querySelectorAll('[role="status"]')].map((s) => (s.textContent ?? "").trim()).join(" | ");
const tick = async (ms: number): Promise<void> => {
  await act(async () => { vi.advanceTimersByTime(ms); });
  await settle();
};
const buttonStarting = (label: string): HTMLButtonElement | undefined =>
  [...host!.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => (b.textContent ?? "").trim().startsWith(label));

interface HeldPress {
  name: string;
  /** Mount, and press: the Undo capsule stands afterwards. */
  press: () => Promise<void>;
  /** What the window sends when it closes. */
  sends: () => number;
  /** What Undo says, whichever door took it. */
  undone: RegExp;
  /** A press that names its set: what the closed window sent, and what the press named. */
  named?: () => { sent: string[]; named: string[] };
}

/** The Screener's rows, top to bottom. */
const screenerRows = (): string[] =>
  [...host!.querySelectorAll(".view-screener .row")].map((r) => r.getAttribute("data-id") ?? "");
/** Each Screener decision sent, as "sender destination". */
const decisions = (): string[] =>
  kinds("screener_decide").map((m) => `${(m as { senderId: string }).senderId} ${(m as { dest?: string }).dest}`);
/** The senders Mark all spam's question named: the rows on screen when it opened. */
let asked: string[] = [];
/** Mark all spam, then its confirm. No key opens the question, and it states the number it moves. */
async function markAllSpamConfirmed(): Promise<void> {
  asked = screenerRows();
  expect(asked.length, "one waiting sender: no pile to mark").toBeGreaterThan(1);
  await click(buttonStarting(messages.screener.markAllSpam));
  const ask = host!.querySelector("[role=alertdialog]");
  expect(ask?.textContent?.match(/(\d+) waiting senders? as spam\?/)?.[1], "the question names another number").toBe(String(asked.length));
  const yes = messages.screener.askAllSpamYes.replace("{count}", String(asked.length));
  await click([...ask!.querySelectorAll("button")].find((b) => b.textContent === yes));
}

const HELD: readonly HeldPress[] = [
  {
    name: "the Screener decide (r → News)",
    press: async () => { await mountShell("#/screener"); await tick(2000); await key("r"); },
    sends: () => kinds("screener_decide").length,
    undone: /^Undone — 1 waiting again\.$/,
  },
  {
    name: "a Screener pile (Mark all spam, its question, Mark N as spam)",
    press: async () => { await mountShell("#/screener"); await tick(2000); await markAllSpamConfirmed(); await tick(2000); },
    sends: () => kinds("screener_decide").length,
    // Every sender it named comes back, not some.
    get undone() { return new RegExp(`^Undone — ${asked.length} waiting again\\.$`); },
    named: () => ({ sent: decisions().sort(), named: asked.map((id) => `${id} spam`).sort() }),
  },
  {
    name: "the Move strip (Move → News)",
    press: async () => {
      await mountShell("#/ohbox");
      await key("j");
      await click(buttonStarting("Move"));
      await click(buttonStarting("→ News"));
    },
    sends: () => sent.filter((m) => m.kind.startsWith("rule_")).length,
    undone: /^The mail is back where it was, and no rule was made/,
  },
  {
    name: "the delete window (Backspace)",
    press: async () => { await mountShell("#/ohbox"); await key("j"); await key("Backspace"); },
    sends: () => kinds("message_delete").length,
    undone: new RegExp(`^${messages.ohbox.deleteUndone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
  },
];

/** The notice slot's sentence — where Undo's answer lands once the capsule has gone. */
const notice = (): string => (host!.querySelector(".toast:not(.toast-held)")?.textContent ?? "").trim();

describe("z takes back what the toast's Undo takes back, inside the window", () => {
  for (const p of HELD) {
    it(`${p.name}: the button (control) sends nothing and says it`, async () => {
      await p.press();
      expect(undoCapsule(), `no Undo capsule after the press: ${said()}`).toBeTruthy();
      await tick(1200);
      await click(undoCapsule());
      const answer = notice();
      await tick(30_000);
      expect(p.sends(), "the button left the press to commit").toBe(0);
      expect(answer).toMatch(p.undone);
    });

    it(`${p.name}: z at +1.2 s does the same — nothing sent, the same sentence, the capsule gone`, async () => {
      await p.press();
      expect(undoCapsule(), `no Undo capsule after the press: ${said()}`).toBeTruthy();
      await tick(1200);
      await key("z");
      const standing = undoCapsule();
      const answer = notice();
      await tick(30_000);
      expect(p.sends(), "z left the press to commit").toBe(0);
      expect(answer).toMatch(p.undone);
      expect(standing, "z left the capsule offering Undo").toBeNull();
      // Taken once: a second z has nothing to take and says nothing new.
      await key("z");
      await tick(30_000);
      expect(p.sends()).toBe(0);
    });

    it(`${p.name}: z outside the window keeps its meaning — nothing is taken back`, async () => {
      await p.press();
      await tick(30_000);
      const committed = p.sends();
      expect(committed, "the window never committed").toBeGreaterThan(0);
      if (p.named) {
        const { sent: got, named } = p.named();
        expect(got, "the window sent other senders than the press named").toEqual(named);
      }
      await key("z");
      const answer = notice();
      await tick(30_000);
      expect(p.sends()).toBe(committed);
      // Past the window `z` says so rather than nothing; it never claims an undo.
      expect(answer).toBe(messages.shortcuts.nothingToUndo);
    });
  }

  it("the newest offer holds the door: z after Park then a Screener decide takes back the decide, not the Park", async () => {
    await mountShell("#/ohbox");
    await key("j");
    await key("e");
    expect(kinds("triage_set").map((m) => (m as { state: string }).state)).toEqual(["set_aside"]);
    await key("g"); await key("s");
    await tick(2000);
    await key("r");
    expect(undoCapsule(), `no Undo capsule after the decide: ${said()}`).toBeTruthy();
    await tick(1200);
    await key("z");
    await tick(30_000);
    expect(kinds("screener_decide"), "the decide committed under z").toEqual([]);
    expect(kinds("triage_set").map((m) => (m as { state: string }).state), "z took back the Park behind the decide")
      .toEqual(["set_aside"]);
  });

  /* Mark all read is not held — its Undo sends the reversal — and it is an Undo on screen, so `z`
     answers it too: the button, `z`, and `z` past its six seconds. */
  for (const via of ["the button", "z", "z past the window"] as const) {
    it(`mark all read: ${via}`, async () => {
      await mountShell("#/ohbox");
      const unread = () => (host!.querySelector(".view-ohbox")?.textContent ?? "").match(/(\d+) unread/)?.[1];
      await tick(500);
      const before = unread();
      expect(Number(before), "the Ohbox shows no unread").toBeGreaterThan(0);
      await click(host!.querySelector(".mark-all-read"));
      await tick(500);
      expect(unread()).toBe("0");
      if (via === "the button") await click(undoCapsule());
      if (via === "z past the window") await tick(7000);
      if (via !== "the button") await key("z");
      await tick(500);
      const back = kinds("mark_seen").filter((m) => (m as { unread?: boolean }).unread === true);
      if (via === "z past the window") {
        expect(back, "z took back a closed offer").toEqual([]);
        expect(unread()).toBe("0");
      } else {
        expect(back.length, `${via} sent no reversal`).toBeGreaterThan(0);
        expect(unread()).toBe(before);
      }
    });
  }

  /* THE PLANTED MISS — the same probe over a surface under the real keymap with a held commit of
     its own: its Undo raised through the door is live under z, raised beside it is dead. A probe
     that cannot read the second as a miss would pass every press above for nothing. */
  it("the planted control: z reads an offer raised beside the door as dead, and one at the door as live", async () => {
    const { KeymapProvider, useKeyBindings } = await import("../app/shell/keymap.js");
    const { createUndoDoor } = await import("../app/shell/undo-door.js");
    const { useToast } = await import("@ohmail/ui");
    let commits = 0;
    function Surface({ atDoor }: { atDoor: boolean }): React.ReactElement {
      const toast = useToast();
      const door = React.useMemo(() => createUndoDoor(toast), [toast]);
      useKeyBindings([{ chord: "z", group: "app", label: "Undo last action", run: () => { door.press(); } }], "global");
      React.useEffect(() => {
        const timer = setTimeout(() => { commits++; }, 8400);
        const take = () => clearTimeout(timer);
        if (atDoor) door.toast("Held.", { action: "Undo", duration: 8000, undo: true, onAction: take });
        else toast("Held.", { action: "Undo", duration: 8000, onAction: take });
      }, [door, toast]);
      return h("div", null);
    }
    for (const atDoor of [false, true]) {
      await unmount();
      commits = 0;
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => {
        root!.render(h(ToastHost, { children: h(KeymapProvider, { children: h(Surface, { atDoor }) }) }));
      });
      await settle();
      await tick(1200);
      await key("z");
      await tick(30_000);
      expect(commits, `planted atDoor=${atDoor}`).toBe(atDoor ? 0 : 1);
    }
  });
});

/* ── `s` in the Screener is one sender ─────────────────────────────────────────
   Up to 0.30.5 one `s` moved every waiting sender to Spam. It opens the menu the shown row's own
   button opens and moves nothing; a letter then files that sender alone. */
describe("s in the Screener opens the shown sender's menu, as the row's own button does", () => {
  it("s moves nothing; x then files only the shown sender", async () => {
    await mountShell("#/screener");
    await tick(2000);
    // Off the top row, so the shown sender is not merely the first.
    await key("j");
    const rows = screenerRows();
    const shown = host!.querySelector(".view-screener .row.sel")?.getAttribute("data-id");
    expect(shown, "j showed no second sender").toBe(rows[1]);
    await key("s");
    const slot = [...host!.querySelectorAll(".view-screener .row-slot")]
      .find((r) => r.querySelector(".row")?.getAttribute("data-id") === shown);
    expect(slot?.querySelector(".scn-act-more")?.getAttribute("aria-expanded"), "s opened no menu on the shown sender").toBe("true");
    expect(host!.querySelectorAll(".scn-act-menu"), "a menu stands on another sender").toHaveLength(1);
    await tick(30_000);
    expect(kinds("screener_decide"), "s moved mail").toEqual([]);
    expect(undoCapsule(), "s raised an Undo").toBeNull();
    expect(screenerRows()).toEqual(rows);
    await key("x");
    await tick(30_000);
    expect(decisions()).toEqual([`${shown} spam`]);
  });
});

/* ── the sheet's own table, in News, Receipts, Trash and Spam ──────────────────
   Every row the `?` sheet prints is read back and pressed, never a hand list: a live row must do
   something, a greyed row's sentence must be true, and a key with a button beside it must send
   what the button sends. Trash needs a transport the demo has not got, so the fixtures adapter
   gains its two routes for this block. */

const TRASHED = ["t1", "t2"].map((id, i) => ({
  id, accountId: "a1", mailboxId: "mb1", threadId: `tt-${id}`, folder: "Trash", subject: `Deleted ${id}`,
  from: { address: `${id}@example.invalid`, name: id.toUpperCase() }, to: [], labels: [], unread: false,
  date: `2026-08-01T0${7 - i}:00:00.000Z`, updatedAt: `2026-08-01T0${7 - i}:00:00.000Z`,
  trashedAt: `2026-08-02T0${7 - i}:00:00.000Z`, restoreTo: "INBOX",
}));
let restored: string[] = [];
const adapterProto = FixturesAdapter.prototype as unknown as Record<string, unknown>;

interface SheetRow { label: string; live: boolean; reason: string | null; chords: string[][] }
/** The sheet as printed: each row's sentence, whether it is greyed, its reason, its keycaps. */
async function sheetTable(): Promise<SheetRow[]> {
  await key("?", { shiftKey: true });
  const rows = [...host!.querySelectorAll(".ks li")].map((li) => ({
    label: (li.querySelector(".ks-lab")?.textContent ?? "").trim(),
    live: !li.classList.contains("off"),
    reason: li.getAttribute("title"),
    chords: [...li.querySelectorAll(".ks-chord")].map((c) => [...c.querySelectorAll("kbd")].map((k) => k.textContent ?? "")),
  }));
  await key("Escape");
  return rows;
}

/** Keycaps back to key events, inverted from `chordKeys` itself; a cap it cannot invert refuses. */
async function strokesOf(caps: string[]): Promise<Array<{ key: string; init: KeyboardEventInit }>> {
  const { chordKeys } = await import("../app/shell/keymap.js");
  const { modGlyph } = await import("../app/shell/mod-glyph.js");
  const mod = modGlyph();
  const named = new Map(["Enter", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]
    .map((n) => [chordKeys(n, mod)[0]!, n] as const));
  const shift = caps.includes("⇧");
  const ctrl = caps.includes(mod);
  const rest = caps.filter((c) => c !== "⇧" && c !== mod);
  const keyOf = (c: string): string => {
    const k = named.get(c) ?? (c.length === 1 ? c : null);
    if (k == null) throw new Error(`a keycap this census cannot press: ${c}`);
    return shift && k.length === 1 ? k.toUpperCase() : k;
  };
  if (!shift && !ctrl && rest.length > 1) return rest.map((c) => ({ key: keyOf(c), init: {} }));
  expect(rest.length, `one key under the modifiers: ${caps.join(" ")}`).toBe(1);
  return [{ key: keyOf(rest[0]!), init: { shiftKey: shift, ctrlKey: ctrl } }];
}

/** Everything a key can change: the route, the wire, the page, the root's stamps, focus. */
const effect = () => ({
  hash: window.location.hash,
  wire: sent.length,
  dom: host!.innerHTML,
  root: [...document.documentElement.attributes].map((a) => `${a.name}=${a.value}`).join(" "),
  focus: document.activeElement,
  body: document.body.childElementCount,
});
const moved = (a: ReturnType<typeof effect>, b: ReturnType<typeof effect>): boolean =>
  (Object.keys(a) as Array<keyof typeof a>).some((k) => a[k] !== b[k]);

interface SheetView { name: string; hash: string; cursor: () => Promise<void>; here: string | null }
const SHEET_VIEWS: readonly SheetView[] = [
  { name: "News", hash: "#/reads", cursor: () => key("j"), here: messages.shortcuts.goReads },
  { name: "Receipts", hash: "#/receipts", cursor: () => key("j"), here: messages.shortcuts.goReceipts },
  /* The reading column shows the bin's first row; the Screener selects its first sender. */
  { name: "Trash", hash: "#/trash", cursor: async () => {}, here: messages.shortcuts.goTrash },
  { name: "Spam", hash: "#/screener/spam", cursor: async () => {}, here: null },
];

/* `faces`, as the product door mounts it: without it `w` switches a layout nothing stamps. */
async function openOn(v: SheetView): Promise<void> {
  await mountShell(v.hash, { faces: true });
  await tick(2000);
  await v.cursor();
  await settle();
}

describe("the sheet's own table in News, Receipts, Trash and Spam", () => {
  beforeEach(() => {
    restored = [];
    adapterProto.listTrash = async () => ({ items: TRASHED, nextCursor: null });
    adapterProto.restoreFromTrash = async (id: string) => { restored.push(id); return { restoreTo: "INBOX", pending: true }; };
  });
  afterEach(() => {
    delete adapterProto.listTrash;
    delete adapterProto.restoreFromTrash;
  });

  for (const v of SHEET_VIEWS) {
    it(`${v.name}: every live row acts — the undo key and "go here" apart — and a key bound to nothing reads dead`, async () => {
      await openOn(v);
      const table = await sheetTable();
      expect(table.filter((r) => r.live).length, `${v.name}: the sheet printed no live row`).toBeGreaterThan(10);
      const dead: string[] = [];
      for (const row of table.filter((r) => r.live && r.label !== messages.shortcuts.undo && r.label !== v.here)) {
        for (const chord of row.chords) {
          await openOn(v);
          const before = effect();
          for (const s of await strokesOf(chord)) await key(s.key, s.init);
          await tick(50);
          if (!moved(before, effect())) dead.push(`${chord.join("")} ${row.label}`);
        }
      }
      expect(dead, `${v.name}: live rows that did nothing`).toEqual([]);
      /* THE PLANTED CONTROL — a letter no row names, through the same probe: it must read dead. */
      const named = new Set(table.flatMap((r) => r.chords.flat()));
      const unbound = [..."qvyz"].find((c) => !named.has(c))!;
      await openOn(v);
      const before = effect();
      await key(unbound);
      await tick(50);
      expect(moved(before, effect()), `${v.name}: \`${unbound}\` is bound to nothing and read as acting`).toBe(false);
    }, 120_000);

    it(`${v.name}: with a row selected, no row tells you to select a message first`, async () => {
      await openOn(v);
      expect(host!.querySelector(".view .row.sel"), `${v.name}: no row selected`).toBeTruthy();
      const table = await sheetTable();
      const promised = table.filter((r) => r.reason === messages.shortcuts.needsCursor).map((r) => r.label);
      expect(promised, `${v.name}: a selection is on screen and these still ask for one`).toEqual([]);
    });
  }

  it("Trash: the delete keys say ohmail never erases mail", async () => {
    await openOn(SHEET_VIEWS[2]!);
    const table = await sheetTable();
    const del = table.find((r) => r.label === messages.shortcuts.deleteKey);
    expect(del?.live).toBe(false);
    expect(del?.reason).toBe(messages.trash.noErase);
  });

  it("the control: in the Ohbox with no cursor, the verbs still ask for one", async () => {
    await mountShell("#/ohbox");
    await tick(2000);
    expect(host!.querySelector(".view .row.sel"), "a row was selected on arrival").toBeNull();
    const table = await sheetTable();
    const move = table.find((r) => r.label === messages.shortcuts.move);
    expect(move?.reason).toBe(messages.shortcuts.needsCursor);
  });
});

/** The strip's first destination, and the move it sends. */
const firstDestination = (): HTMLButtonElement | null => host!.querySelector<HTMLButtonElement>(".abar-panel button");
const moveSent = (): string =>
  JSON.stringify(sent.filter((m) => m.kind === "move").map((m) => (m as { messageIds?: string[]; messageId?: string; to?: string }).messageIds ?? (m as { messageId?: string }).messageId));

describe("the key sends what its button sends", () => {
  /** The card the cursor names, opened the way a click opens it. */
  const openCard = async (id: string): Promise<void> => {
    await click(host!.querySelector(`.scast[data-sid="${id}"] .sc-x`) ?? host!.querySelector(`.scast[data-sid="${id}"]`));
  };
  const cursorId = (): string => host!.querySelector(".view .row.sel")?.getAttribute("data-id") ?? "";
  /* The verb's writes; reading a card writes `\Seen` beside them on its own clock. */
  const READING = new Set(["mark_seen", "feed_mark_seen"]);
  const wire = () => ({ kinds: sent.map((m) => m.kind).filter((k) => !READING.has(k)), moved: moveSent() });

  for (const [view, hash] of [["News", "#/reads"], ["Receipts", "#/receipts"]] as const) {
    it(`${view}: m then the first destination moves what Move then the first destination moves`, async () => {
      await cursorOnStream(hash);
      const id = cursorId();
      expect(id, `${view}: no cursor`).not.toBe("");
      sent = [];
      await key("m");
      await click(firstDestination());
      await tick(30_000);
      const byKey = wire();
      expect(byKey.kinds, `${view}: the key moved nothing`).toContain("move");

      await mountShell(hash);
      await tick(500);
      sent = [];
      await openCard(id);
      await click(host!.querySelector(".abar-move"));
      await click(firstDestination());
      await tick(30_000);
      expect(wire()).toEqual(byKey);
    });

    it(`${view}: d d deletes what More → Delete → Delete deletes`, async () => {
      await cursorOnStream(hash);
      const id = cursorId();
      sent = [];
      await key("d");
      await key("d");
      await tick(30_000);
      const byKey = kinds("message_delete").map((m) => JSON.stringify(m));
      expect(byKey, `${view}: the key deleted nothing`).toEqual([JSON.stringify({ kind: "message_delete", messageId: id })]);

      await mountShell(hash);
      await tick(500);
      sent = [];
      await openCard(id);
      await click(host!.querySelector(".abar-more"));
      await click([...document.querySelectorAll("[role=menuitem]")].find((b) => (b.textContent ?? "").trim() === messages.ohbox.actionDelete));
      await click(host!.querySelector(".abar-delete .abar-danger"));
      await tick(30_000);
      expect(kinds("message_delete").map((m) => JSON.stringify(m))).toEqual(byKey);
    });
  }

  it("Trash: ⇧⌫ restores the row the Restore button restores", async () => {
    restored = [];
    adapterProto.listTrash = async () => ({ items: TRASHED, nextCursor: null });
    adapterProto.restoreFromTrash = async (id: string) => { restored.push(id); return { restoreTo: "INBOX", pending: true }; };
    try {
      await mountShell("#/trash");
      await tick(2000);
      await click(buttonStarting(messages.trash.restore));
      await tick(30_000);
      const byButton = [...restored];
      expect(byButton).toEqual(["t1"]);
      restored = [];
      await mountShell("#/trash");
      await tick(2000);
      await key("Backspace", { shiftKey: true });
      await tick(30_000);
      expect(restored).toEqual(byButton);
    } finally {
      delete adapterProto.listTrash;
      delete adapterProto.restoreFromTrash;
    }
  });
});

/* ── the palette lists Move where the view can move ────────────────────────────────────────── */

/** The palette's rows, by label — its own list, not the page's. */
const paletteRow = (label: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>(".palette li[role=option]")]
    .find((li) => (li.textContent ?? "").trim().startsWith(label));

describe("the palette's Move is the m key", () => {
  for (const [view, hash] of [["the Ohbox", "#/ohbox"], ["News", "#/reads"], ["Receipts", "#/receipts"]] as const) {
    it(`${view}: the palette lists Move, live, and it opens the strip m opens`, async () => {
      await cursorOnStream(hash);
      await key("k", { ctrlKey: true });
      const row = paletteRow(messages.shortcuts.move);
      expect(row, `${view}: the palette has no Move`).toBeTruthy();
      expect(row!.getAttribute("aria-disabled")).toBeNull();
      await click(row);
      await settle();
      expect(stripShown("m"), `${view}: the palette's Move opened nothing: ${JSON.stringify(bars())}`).toBe(true);
    });
  }

  it("Trash: the palette's Move rests where the sheet's m rests", async () => {
    adapterProto.listTrash = async () => ({ items: TRASHED, nextCursor: null });
    adapterProto.restoreFromTrash = async () => ({ restoreTo: "INBOX", pending: true });
    try {
      await openOn(SHEET_VIEWS[2]!);
      const m = (await sheetTable()).find((r) => r.label === messages.shortcuts.move);
      expect(m?.live).toBe(false);
      await key("k", { ctrlKey: true });
      expect(paletteRow(messages.shortcuts.move)?.getAttribute("aria-disabled")).toBe("true");
    } finally {
      delete adapterProto.listTrash;
      delete adapterProto.restoreFromTrash;
    }
  });
});

/* ── four sheet lines that did less than they say ──────────────────────────────────────────── */

describe("the sheet's delete keys, Reply to everyone and Send in the views that list them", () => {
  it("Answer Later: d asks, d again deletes the letter on screen", async () => {
    await mountShell("#/triage");
    await tick(2000);
    sent = [];
    await key("d");
    expect(stripShown("d"), `d asked nothing: ${JSON.stringify(bars())}`).toBe(true);
    await key("d");
    await tick(30_000);
    expect(kinds("message_delete")).toHaveLength(1);
  });

  for (const k of ["Backspace", "Delete"] as const) {
    it(`Answer Later: ${k} moves the letter on screen to Trash`, async () => {
      await mountShell("#/triage");
      await tick(2000);
      sent = [];
      await key(k);
      await tick(30_000);
      expect(kinds("message_delete"), `${k} did nothing in Answer Later`).toHaveLength(1);
    });
  }

  it("⇧R on a letter from one person opens the reply to that person", async () => {
    await mountShell("#/ohbox");
    await key("j");
    expect(barButton("Reply all"), "the control: this letter has nobody else on it").toBeUndefined();
    expect(host!.querySelector(".reply[data-reply-for]")).toBeNull();
    await key("R", { shiftKey: true });
    expect(host!.querySelector(".reply[data-reply-for]"), "⇧R opened nothing").toBeTruthy();
  });

  it("the sheet names Ctrl+Enter for what it does outside the Reply Run", async () => {
    await mountShell("#/ohbox");
    await key("j");
    const table = await sheetTable();
    const labels = table.map((r) => r.label);
    expect(labels).toContain(messages.shortcuts.sendReply);
    expect(labels, "the Reply Run's line is printed where there is no run").not.toContain(messages.shortcuts.frSend);
  });
});
