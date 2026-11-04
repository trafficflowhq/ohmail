import { beforeEach, describe, expect, it } from "vitest";
import {
  REVEAL_MARGIN_DP, REVEAL_QUIET_MS, REVEAL_SETTLE_CAP_MS, REVEAL_WINDOW_MS,
  createSentReveal, noteReplySend, onReplySend, revealY, type SentReveal,
} from "../src/ui/sent-reveal";

/**
 * THE REPLY YOU SENT, BROUGHT INTO VIEW ON THE PHONE (`sent-reveal.ts`): the composer's sheet closes
 * over the reader, the sent copy joins below the opened message, and once it is drawn and the layout
 * still, the reader scrolls once to show it. The reader here is a model: an 800dp view with 60dp of
 * bar over its foot, members by id with a top and a height, a hand-run clock.
 */

let clock = 0;
let timers: { at: number; run: () => void }[] = [];
let members: { id: string; mine: boolean; ready: boolean }[] = [];
let boxes: Record<string, { top: number; height: number }> = {};
let view = { y: 0, height: 800, chrome: 60, content: 3000 };
let covered = false;
let moves: number[] = [];
let r: SentReveal;

const pass = (ms: number): void => {
  const end = clock + ms;
  for (;;) {
    const next = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
    if (!next) break;
    timers = timers.filter((t) => t !== next);
    clock = next.at;
    next.run();
  }
  clock = end;
};
const join = (id: string, top: number, height: number, ready = true): void => {
  members.push({ id, mine: true, ready });
  boxes[id] = { top, height };
};

beforeEach(() => {
  clock = 0;
  timers = [];
  members = [{ id: "a", mine: false, ready: true }, { id: "b", mine: false, ready: true }];
  boxes = { a: { top: 0, height: 900 }, b: { top: 920, height: 600 } };
  view = { y: 700, height: 800, chrome: 60, content: 3000 };
  covered = false;
  moves = [];
  r = createSentReveal({
    members: () => members,
    measure: (id) => boxes[id] ?? null,
    view: () => view,
    inSight: () => !covered,
    scrollTo: (y) => { moves.push(y); },
    now: () => clock,
    after: (ms, run) => {
      const t = { at: clock + ms, run };
      timers.push(t);
      return () => { timers = timers.filter((x) => x !== t); };
    },
  });
});

describe("where the view goes", () => {
  it("a copy below the fold: its bottom a margin above the bar", () => {
    expect(revealY({ top: 1540, height: 300 }, view)).toBe(1540 + 300 - 740 + REVEAL_MARGIN_DP);
  });
  it("a copy taller than the view: its top a margin below the view's top", () => {
    expect(revealY({ top: 1540, height: 900 }, view)).toBe(1540 - REVEAL_MARGIN_DP);
  });
  it("a copy wholly on screen: nowhere", () => {
    expect(revealY({ top: 900, height: 300 }, view)).toBeNull();
  });
  it("never past the content's end", () => {
    expect(revealY({ top: 2600, height: 380 }, view)).toBe(3000 - 800);
  });
});

describe("the reader scrolls once to the reply it sent", () => {
  it("once the copy is drawn and the layout has stood still", () => {
    r.pressed();
    r.sent();
    join("s", 1540, 300);
    r.layout();
    pass(REVEAL_QUIET_MS - 10);
    r.layout(); // the sheet's last frame, the copy's height
    pass(REVEAL_QUIET_MS - 10);
    expect(moves, "not while the layout moves").toEqual([]);
    pass(20);
    expect(moves).toEqual([1540 + 300 - 740 + REVEAL_MARGIN_DP]);
    r.layout();
    pass(1000);
    expect(moves, "once").toHaveLength(1);
  });

  it("not while the composer still stands over the reader; then when it is gone", () => {
    r.pressed();
    covered = true;
    r.sent();
    join("s", 1540, 300);
    r.layout();
    pass(500);
    expect(moves).toEqual([]);
    covered = false;
    r.poke();
    pass(REVEAL_QUIET_MS);
    expect(moves).toHaveLength(1);
  });

  it("waits for the copy's body, up to the cap", () => {
    r.pressed();
    r.sent();
    join("s", 1540, 300, false);
    r.layout();
    pass(REVEAL_SETTLE_CAP_MS - 200);
    expect(moves).toEqual([]);
    pass(400);
    expect(moves).toHaveLength(1);
  });

  it("the person dragged after pressing Send: nothing moves", () => {
    r.pressed();
    r.hand();
    r.sent();
    join("s", 1540, 300);
    r.layout();
    pass(1000);
    expect(moves).toEqual([]);
  });

  it("the person drags while the layout settles: nothing moves", () => {
    r.pressed();
    r.sent();
    join("s", 1540, 300);
    r.layout();
    pass(REVEAL_QUIET_MS / 2);
    r.hand();
    pass(1000);
    expect(moves).toEqual([]);
  });

  it("already wholly on screen: nothing moves", () => {
    r.pressed();
    r.sent();
    join("s", 1000, 200);
    r.layout();
    pass(1000);
    expect(moves).toEqual([]);
  });

  it("an arrival that is not the person's own, or a member drawn before the press, moves nothing", () => {
    members.push({ id: "own-before", mine: true, ready: true });
    boxes["own-before"] = { top: 1540, height: 300 };
    r.pressed();
    r.sent();
    members.push({ id: "theirs", mine: false, ready: true });
    boxes.theirs = { top: 1860, height: 300 };
    r.layout();
    pass(1000);
    expect(moves).toEqual([]);
  });

  it("a send confirmed long after its press moves nothing", () => {
    r.pressed();
    pass(REVEAL_WINDOW_MS + 1);
    r.sent();
    join("s", 1540, 300);
    r.layout();
    pass(1000);
    expect(moves).toEqual([]);
  });

  it("no send pressed: a copy of the person's own that arrives moves nothing", () => {
    join("s", 1540, 300);
    r.layout();
    r.sent();
    pass(1000);
    expect(moves).toEqual([]);
  });
});

describe("the composer's word reaches the reader under it", () => {
  it("names the message answered and the phase", () => {
    const heard: string[] = [];
    const off = onReplySend((n) => heard.push(`${n.parentId}:${n.phase}`));
    noteReplySend("m1", "pressed");
    noteReplySend("m1", "sent");
    off();
    noteReplySend("m1", "sent");
    expect(heard).toEqual(["m1:pressed", "m1:sent"]);
  });
});
