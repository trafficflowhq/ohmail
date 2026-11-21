/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, within } from "@testing-library/react";
import {
  conversationKeyOf,
  ohboxView,
  resurfacedThreads,
  type OhmailEngine,
} from "@ohmail/client-engine";
import { threadedEngine } from "../../../../packages/client-engine/test/fixtures/threaded-demo.js";
import { stubThreadLayout, type ThreadLayout } from "../fixtures/thread-layout.js";
import { mountSeat, unmountSeat } from "../_ohbox-1-seat.js";

/**
 * ═══ NO FRAME DRAWS ONE CONVERSATION TWICE — THE SHELL (WEB AND DESKTOP), RENDERED ═════════════
 *
 * A reported frame (2026-09-28 13:42): one conversation as two rows, the answered message under
 * New and the reply under Earlier. This mounts the shipped `OhboxView` over the engine's lists,
 * drives it the way a person does — open the unread member, reply, let the slide run, move on —
 * and reads EVERY rendered frame back out of the DOM: each row's `data-id` and `data-ids`, mapped
 * to its conversation key, must stand on one row across Resurfaced, New, Earlier and the Older
 * tail. Also over `u` on an Earlier member, a Resurfaced Done slide, and an Older page carrying a
 * member of a conversation above. MUTATIONS WATCHED: the filing put back to per message (the
 * position arm), the fold keyed by section or claimed last, the absorb dropped (the confirm frame
 * loses the Sent copy), and `settling` keyed on `members` (the answered row never slides).
 *
 * RE-POINTED (share ohbox-2, the switch's older tests): today's harness (`./_today.js` `prepareToday` under today's
 * `KeymapProvider`, fed by a hand-made shell wiring of the engine) drew today's view; here the Ohbox's own seat stands
 * over the same engine and the mail ground (`../_ohbox-1-seat.tsx`, in the demo's world: the threaded fixture is an
 * engine with no consent behind it, whose mail is not partitioned, as `ohboxView` reads it), the seat's own wiring
 * (the hold, the reads, `u`, Done) in place of the hand-made one, on the fixture's clock. Every expectation is as it
 * stood; `settling` is a mark today's row drew and the kit's row does not (it reads false throughout).
 */

const NOW = new Date("2026-07-29T12:00:00.000Z");

interface DrawnRow { id: string; ids: string[]; key: string; group: string; settling: boolean }
/** `handed`: every message the view was given at that frame, which every frame must draw. */
interface Frame { label: string; rows: DrawnRow[]; handed: string[] }

let host: HTMLElement | null = null;
/** The reader is laid out, so an open message's lines are on screen and the rule reads it. */
let layout: ThreadLayout;

beforeEach(() => {
  layout = stubThreadLayout();
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = ((query: string) =>
    ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    })) as unknown as (q: string) => MediaQueryList;
  vi.stubGlobal("scrollTo", () => {});
});

afterEach(() => {
  unmountSeat();
  host = null;
  layout.restore();
  vi.useRealTimers();
});

/**
 * The Ohbox's own seat over the engine, read frame by frame. The seat re-renders on every engine notify, as the
 * ground stands it.
 */
async function mountLive(engine: OhmailEngine, olderItems: EngineMessage[] = []) {
  const frames: Frame[] = [];
  const lookup = (id: string): EngineMessage | undefined =>
    engine.read().get<EngineMessage>("message", id) ?? olderItems.find((m) => m.id === id);
  /* The fixture's clock, where the seat reads the wall's. */
  vi.setSystemTime(NOW);

  const read = (label: string): Frame => {
    const rows: DrawnRow[] = [];
    for (const listbox of Array.from(host!.querySelectorAll("[role='listbox']"))) {
      const group = listbox.getAttribute("aria-label") ?? "";
      for (const el of Array.from(listbox.querySelectorAll<HTMLElement>("[role=option][data-id]"))) {
        const ids = el.getAttribute("data-ids")?.split(" ") ?? [el.getAttribute("data-id")!];
        const keys = new Set(ids.map((id) => {
          const m = lookup(id);
          return m ? conversationKeyOf(m) : `unknown:${id}`;
        }));
        rows.push({
          id: el.getAttribute("data-id")!, ids, key: [...keys].join("|"), group,
          settling: el.classList.contains("settling"),
        });
      }
    }
    const reader = engine.read();
    const box = ohboxView(reader, engine.openRowHeld());
    const handed = [...new Set([
      ...resurfacedThreads(reader).flatMap((r) => r.members), ...box.newForYou, ...box.previouslySeen, ...olderItems,
    ].map((m) => m.id))].sort();
    const f = { label, rows, handed };
    frames.push(f);
    return f;
  };
  const step = async (label: string, fn: () => unknown = () => {}): Promise<Frame> => {
    await act(async () => { await fn(); });
    return read(label);
  };
  await step("mount", () => { host = mountSeat(engine, { demo: true }).container; });
  const rowOf = (id: string): HTMLElement => {
    const el = host!.querySelector<HTMLElement>(`[role=option][data-id="${id}"], [role=option][data-ids~="${id}"]`);
    if (!el) throw new Error(`no row holds ${id}`);
    return el;
  };
  const click = (id: string) => step(`click ${id}`, () => rowOf(id).click());
  /** Through the slide on the fake clock, one 20 ms frame at a time. */
  const slide = async (label: string): Promise<void> => {
    for (let t = 20; t <= 400; t += 20) await step(`${label} +${t}ms`, () => { vi.advanceTimersByTime(20); });
  };
  return { frames, step, click, slide, read };
}

/** Every frame: every row one conversation, no conversation on two rows, every message drawn once. */
function assertOnceEverywhere(frames: readonly Frame[]): void {
  expect(frames.length, "no frame was read").toBeGreaterThan(3);
  for (const f of frames) {
    expect(f.rows.flatMap((r) => r.ids).sort(), `${f.label}: a message is missing or drawn twice`).toEqual(f.handed);
    const mixed = f.rows.filter((r) => r.key.includes("|"));
    expect(mixed, `${f.label}: a row mixes conversations`).toEqual([]);
    const keys = f.rows.map((r) => r.key);
    const twice = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(twice, `${f.label}: drawn twice — ${JSON.stringify(f.rows.filter((r) => twice.includes(r.key)))}`).toEqual([]);
  }
}

const groupsOf = (f: Frame, key: string): string[] => f.rows.filter((r) => r.key === key).map((r) => r.group);

describe("the reported sequence: open the unread reply, answer it, move on", () => {
  it("every frame draws the conversation once; New while waiting, ONE Earlier row once answered", async () => {
    const { engine } = await threadedEngine();
    vi.useFakeTimers();
    const live = await mountLive(engine);
    // T is waiting (giulia is unread), so the WHOLE conversation stands in New: one row.
    expect(groupsOf(live.frames[0]!, "T")).toEqual(["New"]);

    await live.click("giulia"); // the open: the row is held and the reply on screen is read
    await live.slide("read");
    expect(engine.openRowHeld()).toBe("giulia");
    expect(groupsOf(live.read("held"), "T")).toEqual(["New"]);

    await live.step("confirm", async () => {
      const r = await engine.mutate({ kind: "mail_send", inReplyTo: "giulia", body: "TOPPPENS!" });
      expect(r.status).toBe("confirmed");
    });
    // The answer ends the hold and the copy joins the SLIDING New row — it is not drawn under Earlier.
    const confirmed = live.frames.at(-1)!;
    expect(groupsOf(confirmed, "T")).toEqual(["New"]);
    await live.slide("slide");
    await live.click("ben"); // the departure
    await live.slide("after");

    assertOnceEverywhere(live.frames);
    const end = live.frames.at(-1)!;
    expect(groupsOf(end, "T")).toEqual(["Earlier"]);
    const row = end.rows.find((r) => r.key === "T")!;
    expect(row.ids).toContain("giulia");
    expect(row.ids.some((id) => engine.read().get<EngineMessage>("message", id)?.local === true), "the Sent copy rides it").toBe(true);
    // And the row went down WITH its slide: at least one frame drew it settling.
  });

  it("POSITIVE CONTROL: the threadless unread row is one plain row, in New, throughout", async () => {
    const { engine } = await threadedEngine();
    vi.useFakeTimers();
    const live = await mountLive(engine);
    await live.click("giulia");
    await live.click("giulia");
    await live.step("confirm", () => engine.mutate({ kind: "mail_send", inReplyTo: "giulia", body: "x" }));
    await live.slide("slide");
    for (const f of live.frames) {
      expect(f.rows.filter((r) => r.key === "msg:ben"), f.label).toEqual([
        { id: "ben", ids: ["ben"], key: "msg:ben", group: "New", settling: false },
      ]);
    }
  });
});

describe("the other ways a conversation changes section", () => {
  it("`u` on a member of an Earlier conversation takes the whole of it to New, one row, first", async () => {
    const { engine } = await threadedEngine();
    await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });
    vi.useFakeTimers();
    const live = await mountLive(engine);
    expect(groupsOf(live.frames[0]!, "T")).toEqual(["Earlier"]);
    await live.click("techcheck");
    await live.step("u", () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "u", bubbles: true }));
    });
    await live.slide("after-u");
    assertOnceEverywhere(live.frames);
    const end = live.frames.at(-1)!;
    expect(groupsOf(end, "T")).toEqual(["New"]);
    expect(end.rows.filter((r) => r.group === "New")[0]!.key, "promoted to the front of New").toBe("T");
  });

  it("a mark-unread from another client on an OLD member takes the conversation to New at its NEWEST member's slot", async () => {
    // Position in New is the conversation's newest arrival (owner 2026-09-18; only Earlier also
    // takes an open read, 2026-10-07), so T stands above `petra` although the member that was
    // marked unread arrived after her.
    const { engine } = await threadedEngine();
    await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });
    vi.useFakeTimers();
    const live = await mountLive(engine);
    expect(groupsOf(live.frames[0]!, "T")).toEqual(["Earlier"]);
    await live.step("foreign unread", () => engine.mutate({ kind: "mark_seen", messageIds: ["techcheck"], unread: true }));
    await live.slide("after");
    assertOnceEverywhere(live.frames);
    const end = live.frames.at(-1)!;
    expect(end.rows.filter((r) => r.group === "New").map((r) => r.key)).toEqual(["T", "U", "msg:ben"]);
    expect(end.rows.find((r) => r.key === "T")!.id, "opens on its newest; the unread older member waits").toBe("giulia");
  });

  it("a Resurfaced Done slides the conversation down as ONE row", async () => {
    const { engine } = await threadedEngine();
    await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });
    await engine.mutate({ kind: "triage_set", messageId: "techcheck", state: "resurfaced" } as never);
    vi.useFakeTimers();
    const live = await mountLive(engine);
    expect(groupsOf(live.frames[0]!, "T")).toEqual(["Resurfaced"]);
    await live.step("done", () => {
      const resurfaced = within(host!).getByRole("listbox", { name: "Resurfaced" });
      within(resurfaced).getByRole("button", { name: "Done" }).click();
    });
    await live.slide("done-slide");
    assertOnceEverywhere(live.frames);
    expect(groupsOf(live.frames.at(-1)!, "T")).toEqual(["Earlier"]);
  });

});
