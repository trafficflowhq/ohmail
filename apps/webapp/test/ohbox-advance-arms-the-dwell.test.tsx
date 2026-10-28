/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OhmailEngine } from "@ohmail/client-engine";
import { act, installShellEnv, teardownShellEnv, tick } from "./fixtures/live-walk-shell.js";
import { arriveLater, click, key, keyAsBrowser, mountThread, msg, patches, settle, toastText } from "./fixtures/thread-read-shell.js";
import { AFTER_VERB_STORAGE_KEY } from "../app/shell/after-verb.js";
import { stubThreadLayout, type ThreadLayout } from "./fixtures/thread-layout.js";

/**
 * A LANDING RESTED ON IS ENTERED. j, k, a verb's advance and an Undo put the cursor on a message as a
 * preview: moved on within the rest (1.3 s), it reads nothing. Rested on, with the window in front and
 * no command since, it is entered like ↵, a click or a wheel in the column: what is on screen reads
 * as an open read, held in New while shown and at the top of Earlier once left (owner 2026-10-21:
 * "should be at the top when it was my last action"). The reader is laid out (`fixtures/thread-layout.ts`).
 */

const openReads = () => patches.filter((p) => (p as { openRead?: boolean }).openRead === true);
const ids = (label: string): string[] =>
  [...document.querySelectorAll(`[role="listbox"][aria-label="${label}"] .row[data-id]`)]
    .map((e) => (e as HTMLElement).dataset.id!);
const rowOf = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`.row[data-id="${id}"]`);
const selected = (): string | null => document.querySelector(".view .row.sel")?.getAttribute("data-id") ?? null;
const naming = (id: string) => patches.filter((p) => p.ids.includes(id));
/** "first" (08:20) and "old" (08:00) unread over "newer" read (08:30): New ["first", "old"], Earlier ["newer"]. */
const three = () => [
  msg("first", 20, { threadId: "t-first" }), msg("old", 0, { threadId: "t-old" }),
  msg("newer", 30, { threadId: "t-newer", unread: false }),
];
/** Three seconds of nothing but Shift (a key the app does not take): past the rest and the dwell. */
const idle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await key("Shift"); };
/** Less than the rest: the cursor moves on before it. */
const brief = (): Promise<void> => tick(900);
const four = () => [msg("p1", 0), msg("p2", 10), msg("p3", 20), msg("p4", 30)];
const col = (): HTMLElement => document.querySelector<HTMLElement>(".read-col")!;
const press = async (el: Element | null | undefined): Promise<void> => {
  expect(el).toBeTruthy();
  await act(async () => { el!.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
};
const GLANCE = { ids: ["old"], unread: false, via: "glance", openRead: true };
const undo = () => click(document.querySelector(".toast .toast-act"), "Undo");

beforeAll(async () => {
  await import("../app/shell/AppShell.js");
  await import("@ohmail/ui");
}, 120_000);
let layout: ThreadLayout;
beforeEach(() => {
  installShellEnv();
  layout = stubThreadLayout();
  window.location.hash = "#/ohbox";
});
afterEach(async () => {
  layout.restore();
  await teardownShellEnv();
});

/** j onto "first", then Delete: the advance lands on "old". */
async function deleteFirst(): Promise<void> {
  await mountThread(three());
  await key("j");
  expect(selected()).toBe("first");
  await key("Backspace");
  expect(selected(), "the verb advanced to the next row").toBe("old");
}

describe("the advance's landing is a preview until rested on; entering it reads", () => {
  it("a verb, then within the rest nothing is read; ↵ reads it as an open read, top of Earlier once left", async () => {
    await deleteFirst();
    await brief();
    expect(patches).toEqual([]);
    await key("Enter");
    await layout.passDwell(); // its top on screen for the dwell
    await settle();
    expect(patches).toEqual([GLANCE]);
    expect(ids("New"), "it keeps its place while on screen").toEqual(["old"]);
    await click(rowOf("newer"), "move on");
    expect(ids("Earlier"), "left, it takes the top of Earlier").toEqual(["old", "newer"]);
  }, 30_000);

  it("a verb, then rest on the next message: it reads as an open read, top of Earlier once left", async () => {
    await deleteFirst();
    await idle();
    expect(patches).toEqual([GLANCE]);
    expect(ids("New"), "it keeps its place while on screen").toEqual(["old"]);
    await click(rowOf("newer"), "move on");
    expect(ids("Earlier")).toEqual(["old", "newer"]);
  }, 30_000);

  it("the advance starts no further advance; resting reads the landing alone", async () => {
    await deleteFirst();
    await brief();
    expect(patches).toEqual([]);
    await idle();
    await idle();
    expect(patches).toEqual([GLANCE]);
    expect(selected()).toBe("old");
  }, 30_000);
});

describe("CONTROLS: what the advance must not read", () => {
  it("a second verb inside the dwell reads nothing", async () => {
    await deleteFirst();
    await key("Backspace");
    await idle();
    expect(naming("old")).toEqual([]);
  }, 30_000);

  for (const choice of ["stay", "close"] as const) {
    it(`the after-verb choice "${choice}" arms nothing`, async () => {
      window.localStorage.setItem(AFTER_VERB_STORAGE_KEY, choice);
      try {
        await mountThread(three());
        await key("j");
        await key("Backspace");
        expect(selected()).not.toBe("old");
        await idle();
        expect(patches).toEqual([]);
      } finally {
        window.localStorage.removeItem(AFTER_VERB_STORAGE_KEY);
      }
    }, 30_000);
  }

  it("open, verb, Undo at once: the row is back as it stood and the advance's landing is not read", async () => {
    await mountThread(three());
    await click(rowOf("first"), "open first");
    await layout.passDwell();
    await settle();
    expect(patches).toEqual([{ ids: ["first"], unread: false, via: "glance", openRead: true }]);
    await key("Backspace");
    expect(selected()).toBe("old");
    await undo();
    expect(selected()).toBe("first");
    await idle();
    expect(naming("old"), "old was read while the cursor was on first").toEqual([]);
    expect(ids("New"), "first keeps its place in New").toEqual(["first", "old"]);
    // j onto old is a preview until the rest; ↵ enters it and reads it.
    await key("j");
    expect(selected()).toBe("old");
    await brief();
    expect(naming("old")).toEqual([]);
    await key("Enter");
    await layout.passDwell();
    await settle();
    expect(naming("old")).toEqual([GLANCE]);
  }, 30_000);

  it("Undo after entering the landing: the moved-on Undo, the landing's read stands", async () => {
    await deleteFirst();
    await idle();
    await key("Enter");
    await layout.passDwell();
    await settle();
    expect(patches).toEqual([GLANCE]);
    await undo();
    expect(toastText()).toContain("Not deleted.");
    expect(selected()).toBe("old");
    expect(patches).toEqual([GLANCE]);
  }, 30_000);

  it("a URL landing after a preview: neither row is read", async () => {
    await mountThread([
      msg("a", 20, { threadId: "t-a" }), msg("c", 0, { threadId: "t-c" }),
      msg("newer", 30, { threadId: "t-newer", unread: false }),
    ]);
    await key("j");
    expect(selected()).toBe("a");
    window.location.hash = "#/ohbox/m/c";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await settle();
    expect(selected()).toBe("c");
    await idle();
    expect(naming("a"), "a was read while the cursor was on c").toEqual([]);
    expect(naming("c"), "a URL landing is a preview").toEqual([]);
    expect(openReads().flatMap((p) => p.ids)).not.toContain("a");
  }, 30_000);

  it("j/k passing reads nothing; the one rested on reads", async () => {
    await mountThread(three());
    await key("j");
    await key("j");
    await key("k");
    await brief();
    await key("j");
    await brief();
    expect(patches).toEqual([]);
    await tick(2000);
    expect(patches).toEqual([GLANCE]);
  }, 30_000);
});

describe("a landing by j, k, the advance or Undo is entered once rested on", () => {
  it("j and rest: the newest on screen reads as an open read, held in New, top of Earlier once left", async () => {
    await mountThread(three());
    await key("j");
    await idle();
    expect(patches).toEqual([{ ids: ["first"], unread: false, via: "glance", openRead: true }]);
    expect(ids("New")).toEqual(["first", "old"]);
    await click(rowOf("newer"), "move on");
    expect(ids("Earlier")).toEqual(["first", "newer"]);
  }, 30_000);

  it("a conversation of four: only its newest, the one on screen, reads", async () => {
    await mountThread(four());
    await key("j");
    await idle();
    expect(patches).toEqual([{ ids: ["p4"], unread: false, via: "glance", openRead: true }]);
  }, 30_000);

  it("eighteen unread members: only the newest reads (the others' tops never came on screen)", async () => {
    await mountThread(Array.from({ length: 18 }, (_, i) => msg(`m${i + 1}`, i)));
    await key("j");
    await idle();
    expect(patches.flatMap((p) => p.ids)).toEqual(["m18"]);
  }, 30_000);

  it("Undo puts the row back under the cursor; resting there reads it, not the advance's landing", async () => {
    await mountThread(three());
    await key("j");
    await key("Backspace");
    expect(selected()).toBe("old");
    await undo();
    expect(selected()).toBe("first");
    await idle();
    expect(naming("first")).toEqual([{ ids: ["first"], unread: false, via: "glance", openRead: true }]);
    expect(naming("old")).toEqual([]);
  }, 30_000);

  it("the window away for the rest reads nothing; back, the rest starts over", async () => {
    await mountThread(four());
    await key("j");
    layout.focused = false;
    await act(async () => { window.dispatchEvent(new Event("blur")); });
    await tick(5000);
    expect(patches).toEqual([]);
    layout.focused = true;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await tick(1000);
    expect(patches, "the rest started over at the focus").toEqual([]);
    await idle();
    expect(naming("p4")).toHaveLength(1);
  }, 30_000);
});

describe("CONTROLS: a command or a press ends the rest", () => {
  it("m opens Move on the landing: its strip open past the rest, nothing is read", async () => {
    await mountThread(four());
    await key("j");
    await key("m");
    await tick(5000);
    expect(patches).toEqual([]);
  }, 30_000);

  it("a held press on the bar's Later reads nothing", async () => {
    await mountThread(four());
    await key("j");
    await press(col().querySelector(".abar .abar-later"));
    await tick(5000);
    expect(patches).toEqual([]);
  }, 30_000);

  it("a press on the list reads nothing", async () => {
    await mountThread(four());
    await key("j");
    await press(document.querySelector('[role="listbox"]'));
    await tick(5000);
    expect(patches).toEqual([]);
  }, 30_000);

  it("⇧J builds a pick: resting reads nothing", async () => {
    await mountThread(three());
    await key("J", { shiftKey: true });
    await tick(5000);
    expect(patches).toEqual([]);
  }, 30_000);

  it("a URL landing rests and reads nothing", async () => {
    await mountThread(three());
    window.location.hash = "#/ohbox/m/old";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await settle();
    expect(selected()).toBe("old");
    await tick(5000);
    expect(patches).toEqual([]);
  }, 30_000);
});

describe("keys pressed as a browser dispatches them: the key that lands does not end its own rest", () => {
  const FIRST = { ids: ["first"], unread: false, via: "glance", openRead: true };
  for (const k of ["j", "ArrowDown"]) {
    it(`${k} and rest: the landing reads`, async () => {
      await mountThread(three());
      await keyAsBrowser(k);
      expect(selected()).toBe("first");
      await idle();
      expect(patches).toEqual([FIRST]);
    }, 30_000);
  }

  it("Delete's advance and rest: the landing reads", async () => {
    await mountThread(three());
    await keyAsBrowser("j");
    await keyAsBrowser("Backspace");
    expect(selected()).toBe("old");
    await idle();
    expect(naming("old")).toEqual([GLANCE]);
  }, 30_000);

  it("Undo by z and rest: the row put back reads, the advance's landing does not", async () => {
    await mountThread(three());
    await keyAsBrowser("j");
    await keyAsBrowser("Backspace");
    await keyAsBrowser("z");
    expect(selected()).toBe("first");
    await idle();
    expect(naming("first")).toEqual([FIRST]);
    expect(naming("old")).toEqual([]);
  }, 30_000);

  it("j j k pressed fast reads only the one rested on", async () => {
    await mountThread(three());
    await keyAsBrowser("j");
    await keyAsBrowser("j");
    await keyAsBrowser("k");
    await idle();
    expect(patches).toEqual([FIRST]);
  }, 30_000);

  it("j then m: its strip open past the rest, nothing reads", async () => {
    await mountThread(four());
    await keyAsBrowser("j");
    await keyAsBrowser("m");
    await tick(5000);
    expect(patches).toEqual([]);
  }, 30_000);
});

/** ↓/↑ scrolling the column is reading on, as → is: the landing it shows is entered. */
describe("an arrow scroll of the reading column enters the landing", () => {
  /** Five conversations, one unread letter each: New ["a", "b", "c", "d", "e"]. */
  const five = () => ["a", "b", "c", "d", "e"].map((id, i) => msg(id, 40 - 10 * i, { threadId: `t-${id}` }));

  it("j, →, j, then ↓ scrolling the column inside the rest: the conversation reads as an open read", async () => {
    layout.restore();
    layout = stubThreadLayout({ heights: { old: 2000 } });
    await mountThread(three());
    await keyAsBrowser("j");
    await keyAsBrowser("ArrowRight");
    await keyAsBrowser("j");
    expect(selected()).toBe("old");
    await keyAsBrowser("ArrowDown");
    expect(col().scrollTop, "↓ scrolled the column").toBeGreaterThan(0);
    expect(selected(), "and moved no cursor").toBe("old");
    await idle();
    expect(patches).toEqual([GLANCE]);
  }, 30_000);

  it("→ into the column, then j j j passing fast: only the one rested on reads", async () => {
    await mountThread(five());
    await keyAsBrowser("j");
    await keyAsBrowser("ArrowRight");
    await keyAsBrowser("j");
    await keyAsBrowser("j");
    await keyAsBrowser("j");
    expect(selected()).toBe("d");
    expect(patches, "nothing passed reads").toEqual([]);
    await idle();
    expect(patches).toEqual([{ ids: ["d"], unread: false, via: "glance", openRead: true }]);
  }, 30_000);

  it("↓ ↓ ↓ in the list passing fast: only the one rested on reads", async () => {
    await mountThread(five());
    await keyAsBrowser("ArrowDown");
    await keyAsBrowser("ArrowDown");
    await keyAsBrowser("ArrowDown");
    expect(selected()).toBe("c");
    expect(patches, "nothing passed reads").toEqual([]);
    await idle();
    expect(patches).toEqual([{ ids: ["c"], unread: false, via: "glance", openRead: true }]);
  }, 30_000);
});

/**
 * A MARK UNREAD HOLDS FOR THE VISIT (found on 0.30.12: u, j, k back, hands off, read again at +5.3 s).
 * News keeps its Mark unread for the visit (#415). A conversation marked unread while the
 * Ohbox stays open is not entered again by a landing's rest or an arrow scroll of the column; ↵, a
 * click, a press or a wheel in it still read it.
 */
describe("a Mark unread holds for the visit: no landing reads it back", () => {
  const FIRST = { ids: ["first"], unread: false, via: "glance", openRead: true };
  const UNREAD = { ids: ["first"], unread: true };
  /** first opened and read, then u: unread again, the cursor on it. */
  async function readThenMarkUnread(): Promise<void> {
    await mountThread(three());
    await click(rowOf("first"), "open first");
    await layout.passDwell();
    await settle();
    expect(naming("first")).toEqual([FIRST]);
    await keyAsBrowser("u");
    expect(naming("first")).toEqual([FIRST, UNREAD]);
  }

  it("u, j away, k back and six seconds' rest: it stays unread; ↵ then reads it", async () => {
    await readThenMarkUnread();
    await keyAsBrowser("j");
    expect(selected()).toBe("old");
    await keyAsBrowser("k");
    expect(selected()).toBe("first");
    await idle();
    await idle();
    expect(naming("first"), "the landing's rest read it back").toEqual([FIRST, UNREAD]);
    await key("Enter");
    await layout.passDwell();
    await settle();
    expect(naming("first")).toEqual([FIRST, UNREAD, FIRST]);
  }, 30_000);

  it("u, then →, j, k and ↓ scrolling the column: it stays unread; a wheel in it then reads it", async () => {
    layout.restore();
    layout = stubThreadLayout({ heights: { first: 2000 } });
    await readThenMarkUnread();
    await keyAsBrowser("ArrowRight");
    await keyAsBrowser("j");
    await keyAsBrowser("k");
    expect(selected()).toBe("first");
    await keyAsBrowser("ArrowDown");
    expect(col().scrollTop, "↓ scrolled the column").toBeGreaterThan(0);
    await idle();
    await idle();
    expect(naming("first"), "the arrow scroll read it back").toEqual([FIRST, UNREAD]);
    await layout.handScroll(0);
    await layout.passDwell();
    await settle();
    expect(naming("first")).toEqual([FIRST, UNREAD, FIRST]);
  }, 30_000);

  it("a pick marked unread with u, one of them not on screen then: k onto it and a long rest leave it unread", async () => {
    await mountThread(three());
    await click(rowOf("newer"), "open newer");
    await keyAsBrowser("x");
    await keyAsBrowser("k");
    expect(selected()).toBe("old");
    await keyAsBrowser("x");
    await keyAsBrowser("u");
    expect(patches.filter((p) => p.unread).flatMap((p) => p.ids), "the pick marked unread").toContain("newer");
    expect(ids("New"), "newer is back in New, above the cursor").toEqual(["newer", "first", "old"]);
    await keyAsBrowser("k");
    await keyAsBrowser("k");
    expect(selected()).toBe("newer");
    await idle();
    await idle();
    expect(naming("newer").filter((p) => !p.unread), "the landing's rest read it back").toEqual([]);
  }, 30_000);

  it("marked unread on another device while shown: j away, k back and a long rest leave it unread; ↵ then reads it", async () => {
    await mountThread(three());
    await click(rowOf("first"), "open first");
    await layout.passDwell();
    await settle();
    expect(naming("first"), "a read on the wire: the drains now serve what arrives").toEqual([FIRST]);
    await click(rowOf("newer"), "open newer, read from the start");
    // Above every seq a mount serves: an update the mirror must not take for a stale one.
    arriveLater([{ ...msg("newer", 30, { threadId: "t-newer", unread: true }), seq: 100_000 }], ["newer"], "t-newer");
    await tick(20_000);
    await settle();
    expect(col().querySelector('[data-conv-id="newer"]')?.hasAttribute("data-unseen"), "the other device's unread, shown").toBe(true);
    expect(selected()).toBe("newer");
    await keyAsBrowser("j");
    expect(selected()).not.toBe("newer");
    await keyAsBrowser("k");
    expect(selected()).toBe("newer");
    await idle();
    await idle();
    expect(naming("newer"), "the landing's rest read it back").toEqual([]);
    await key("Enter");
    await layout.passDwell();
    await settle();
    expect(naming("newer").filter((p) => !p.unread)).toHaveLength(1);
  }, 30_000);
});

describe("a landing's embedded pictures: asked for once the cursor stays the rest, not while passing", () => {
  const HTML = '<table width="600"><tr><td><p>hello</p><img src="cid:logo@x" width="40" height="40" alt="logo"></td></tr></table>';
  const bodies = { first: { text: "hello", html: HTML }, old: { text: "hello", html: HTML } };
  let asks: string[] = [];
  beforeEach(() => {
    asks = [];
    vi.spyOn(OhmailEngine.prototype, "loadInlineImages").mockImplementation(async (id: string) => { asks.push(id); });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  for (const verb of [["x"], ["I", { shiftKey: true }]] as const) {
    it(`j, then ${verb[0]} at once: the picture is asked for once the rest's length has passed`, async () => {
      await mountThread(three(), { bodies });
      await keyAsBrowser("j");
      await keyAsBrowser(verb[0], verb[1]);
      expect(selected()).toBe("first");
      expect(asks, "not before the rest's length").toEqual([]);
      await tick(5000);
      expect(asks).toContain("first");
    }, 30_000);
  }

  it("j j passing: the passed landing asks for nothing", async () => {
    await mountThread(three(), { bodies });
    await keyAsBrowser("j");
    await brief();
    await keyAsBrowser("j");
    await tick(5000);
    expect(asks).not.toContain("first");
    expect(asks).toContain("old");
  }, 30_000);
});
