/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ISO, act, answerSyncWith, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell.js";
import en from "../messages/en.json";

/**
 * TRIAGE VERBS ON AN ANSWERED CONVERSATION ACT AT THE LETTER, through the shipped shell and the
 * real engine. `a1` is Lena's letter, read; `x2` is our own newer reply, so the row wears the reply.
 * Resurface on the row sends one `POST /messages/a1/triage` and nothing for `x2`. Park and Answer
 * later take the whole row, our reply too, so the row leaves the Ohbox; the pile shows it as one row
 * facing the letter.
 */

const ME = "walker@example.invalid";
const LENA = { name: "Lena", address: "lena@example.invalid" };
const OLDER = "2026-08-03T08:00:00.000Z";
const NEWER = "2026-08-03T09:00:00.000Z";
let seq = 0;

const create = (type: string, id: string, entity: Record<string, unknown>) => ({
  type, op: "create", id, seq: ++seq, updatedAt: ISO, entity,
});
const message = (id: string, at: string, over: Record<string, unknown> = {}) => create("message", id, {
  id, accountId: "acct_live_1", mailboxId: "mb_1", threadId: "T", messageIdHeader: null,
  subject: "Q3 plan", from: LENA, to: [{ name: null, address: ME }], cc: [], date: at, arrivedAt: at, sortAt: at,
  folder: "INBOX", snippet: `the words of ${id}`, unread: false, hasAttachments: false, attachmentCount: 0,
  sensitivity: {}, triage: null, labels: [], remoteContent: "none", updatedAt: ISO, ...over,
});
const consent = (address: string) => create("rule", `rule_${address}`, {
  id: `rule_${address}`, kind: "sender", match: address, destination: "INBOX", priority: 0,
  provenance: "seeded-from-sent", enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
});
const thread = (id: string, ids: string[]) => create("thread", id, {
  id, accountId: "acct_live_1", rootMessageIdHeader: null, subject: "Q3 plan", messageIds: ids,
  lastMessageAt: NEWER, participants: [], updatedAt: ISO,
});
const pageOf = (creates: unknown[]) => (): Response => new Response(
  JSON.stringify({ changes: { creates, updates: [], moves: [], deletes: [] }, cursor: `c${seq}`, hasMore: false, serverTime: ISO }),
  { status: 200, headers: { "content-type": "application/json" } },
);
const OURS = { from: { name: null, address: ME }, to: [LENA], folder: "Sent", subject: "Re: Q3 plan" };

/** The answered conversation: Lena's read letter and our newer reply. */
const answered = (letter: Record<string, unknown> = {}) =>
  [consent(LENA.address), message("a1", OLDER, letter), message("x2", NEWER, OURS), thread("T", ["a1", "x2"])];

const settle = async (): Promise<void> => { for (let i = 0; i < 6; i++) await tick(50); };
const click = async (el: Element): Promise<void> => {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await settle();
};
const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
  await settle();
};
const pointer = async (type: string, target: EventTarget, x: number, y: number): Promise<void> => {
  await act(async () => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  });
};
/** Every triage POST the engine sent: [message id, state]. */
const triagePosts = (): Array<[string, string]> => {
  const calls = (globalThis.fetch as unknown as { mock: { calls: Array<[unknown, RequestInit?]> } }).mock.calls;
  return calls.flatMap(([u, init]) => {
    const m = /\/messages\/([^/?]+)\/triage/.exec(String(u));
    if (!m || (init?.method ?? "GET").toUpperCase() !== "POST") return [];
    return [[decodeURIComponent(m[1]!), (JSON.parse(String(init!.body)) as { state: string }).state] as [string, string]];
  });
};
const sortedPosts = (): Array<[string, string]> => [...triagePosts()].sort((x, y) => (x.join() < y.join() ? -1 : 1));
/** Every tag write the engine sent: "<message id> <body>". */
const tagPosts = (): string[] => {
  const calls = (globalThis.fetch as unknown as { mock: { calls: Array<[unknown, RequestInit?]> } }).mock.calls;
  return calls.flatMap(([u, init]) => {
    const m = /\/messages\/([^/?]+)\/tags/.exec(String(u));
    if (!m || (init?.method ?? "GET").toUpperCase() !== "POST") return [];
    return [`${decodeURIComponent(m[1]!)} ${String(init!.body)}`];
  });
};
const TAG = create("tag", "tag_1", { id: "tag_1", name: "Keepme", hue: "blue", createdAt: ISO, updatedAt: ISO });
const chips = (row: HTMLElement): string[] => [...row.querySelectorAll(".tagchip")].map((c) => (c.textContent ?? "").trim());
const selRow = (host: HTMLElement): string | null =>
  host.querySelector<HTMLElement>('[role="listbox"] .row.sel')?.dataset.id ?? null;
const KAI = { name: "Kai", address: "kai@example.invalid" };
/** Two answered conversations in Earlier: T (a1, our x2) above U (b1, our y2). */
const twoAnswered = () => [
  ...answered(),
  consent(KAI.address),
  message("b1", "2026-08-03T06:00:00.000Z", { threadId: "U", from: KAI, subject: "Budget" }),
  message("y2", "2026-08-03T07:00:00.000Z", { ...OURS, to: [KAI], threadId: "U", subject: "Re: Budget" }),
  thread("U", ["b1", "y2"]),
];
const rows = (host: HTMLElement): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[role="listbox"] .row[data-id]')];
const theRow = (host: HTMLElement): HTMLElement => {
  const r = rows(host)[0];
  expect(r, "the conversation's row").toBeTruthy();
  return r!;
};
const mount = async (creates: unknown[]): Promise<HTMLElement> => {
  answerSyncWith(pageOf(creates));
  const host = await mountShell([mailbox({ id: "mb_1", address: ME, lastSyncAt: ISO })]);
  await settle();
  return host;
};
/** A row press as a person makes it at this width: the first click selects, the second opens. */
const openRow = async (host: HTMLElement): Promise<void> => {
  await click(theRow(host));
  await click(theRow(host));
};
const bar = (host: HTMLElement, cls: string): HTMLElement => {
  const b = host.querySelector<HTMLElement>(`.read-col .${cls}`);
  expect(b, `the bar's ${cls}`).toBeTruthy();
  return b!;
};
const focusedPanel = (host: HTMLElement): string | null =>
  host.querySelector<HTMLElement>(".read-col article.pm[aria-current]")?.dataset.convId ?? null;

beforeAll(async () => {
  await import("../app/shell/AppShell.js");
  await import("@ohmail/ui");
}, 120_000);
beforeEach(() => { installShellEnv(); seq = 0; window.location.hash = "#/ohbox"; });
afterEach(async () => {
  delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  await teardownShellEnv();
});

describe("an answered conversation's row in the shipped shell", () => {
  it("wears our reply and stands for the letter", async () => {
    const host = await mount(answered());
    const row = theRow(host);
    expect(row.textContent, "the face is unchanged").toContain("the words of x2");
    expect(row.dataset.id).toBe("a1");
  }, 60_000);

  it("`a` files the letter and our reply, and the Reply Run pile lists the letter", async () => {
    const host = await mount(answered());
    await click(theRow(host));
    await key("a");
    expect(sortedPosts()).toEqual([["a1", "reply_later"], ["x2", "reply_later"]]);
    await act(async () => {
      window.location.hash = "#/triage";
      window.dispatchEvent(new Event("hashchange"));
    });
    await settle();
    const listed = [...host.querySelectorAll<HTMLElement>(".row[data-id]")].map((r) => r.dataset.id);
    expect(listed).toContain("a1");
    expect(listed).not.toContain("x2");
  }, 60_000);

  it("`e` parks the letter and our reply, so the row leaves", async () => {
    const host = await mount(answered());
    await click(theRow(host));
    await key("e");
    expect(sortedPosts()).toEqual([["a1", "set_aside"], ["x2", "set_aside"]]);
    expect(rows(host)).toEqual([]);
  }, 60_000);

  it("opened, the bar's Later takes the row, the letter being the focused panel", async () => {
    const host = await mount(answered());
    await openRow(host);
    expect(focusedPanel(host)).toBe("a1");
    await click(bar(host, "abar-later"));
    expect(sortedPosts()).toEqual([["a1", "reply_later"], ["x2", "reply_later"]]);
  }, 60_000);

  it("opened, the bar's Park parks the letter and our reply", async () => {
    const host = await mount(answered());
    await openRow(host);
    await click(bar(host, "abar-aside"));
    expect(sortedPosts()).toEqual([["a1", "set_aside"], ["x2", "set_aside"]]);
  }, 60_000);

  it("opened, the bar's Resurface Tomorrow acts on the letter", async () => {
    const host = await mount(answered());
    await openRow(host);
    await click(bar(host, "abar-resurface"));
    const tomorrow = [...host.querySelectorAll<HTMLElement>(".read-col .abar-panel button")]
      .find((b) => b.textContent?.trim() === en.ohbox.resurfaceTomorrow);
    expect(tomorrow, "the strip's Tomorrow").toBeTruthy();
    await click(tomorrow!);
    expect(triagePosts()).toEqual([["a1", "bubbled_up"]]);
  }, 60_000);

  it("at phone width, the sheet's Later takes the row", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => {
        const max = /max-width:\s*([\d.]+)px/.exec(query), min = /min-width:\s*([\d.]+)px/.exec(query);
        const matches = (max !== null || min !== null) && (!max || 390 <= parseFloat(max[1]!)) && (!min || 390 >= parseFloat(min[1]!));
        return {
          matches, media: query, onchange: null, dispatchEvent: () => false,
          addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
        };
      },
    });
    const host = await mount(answered());
    await openRow(host);
    const later = document.querySelector<HTMLElement>(".reader .abar-later");
    expect(later, "the sheet's Later").toBeTruthy();
    await click(later!);
    expect(sortedPosts()).toEqual([["a1", "reply_later"], ["x2", "reply_later"]]);
  }, 60_000);

  it("the palette's Resurface selection acts on the letter", async () => {
    const host = await mount(answered());
    await click(theRow(host));
    await key("k", { ctrlKey: true });
    const option = [...document.querySelectorAll<HTMLElement>(".palette li[role=option]")]
      .find((li) => (li.textContent ?? "").includes(en.palette.resurfaceSel));
    expect(option, "the palette's Resurface selection").toBeTruthy();
    await click(option!);
    expect(triagePosts()).toEqual([["a1", "bubbled_up"]]);
  }, 60_000);

  it("a pick of the row (x), then `a`, files the row", async () => {
    const host = await mount(answered());
    await click(theRow(host));
    await key("x");
    await key("a");
    expect(sortedPosts()).toEqual([["a1", "reply_later"], ["x2", "reply_later"]]);
  }, 60_000);

  it("the row dragged to the Reply Run files the row", async () => {
    const host = await mount(answered());
    const row = theRow(host);
    await pointer("pointerdown", row, 10, 10);
    const pile = host.querySelector('[data-rail-id="triage"]');
    expect(pile, "the rail's Reply Run").toBeTruthy();
    (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => pile;
    await pointer("pointermove", window, 60, 60);
    expect(document.body.querySelector(".drag-ghost"), "the row became a drag").toBeTruthy();
    await pointer("pointerup", window, 60, 60);
    await settle();
    expect(sortedPosts()).toEqual([["a1", "reply_later"], ["x2", "reply_later"]]);
  }, 60_000);
});

describe("an answered conversation marked unread still stands for the letter", () => {
  /** Every read-state write the engine sent: "<ids> unread|read". */
  const seenPatches = (): string[] => {
    const calls = (globalThis.fetch as unknown as { mock: { calls: Array<[unknown, RequestInit?]> } }).mock.calls;
    return calls.flatMap(([u, init]) => {
      if ((init?.method ?? "GET").toUpperCase() !== "PATCH" || !/\/messages(\?|$)/.test(String(u))) return [];
      const b = JSON.parse(String(init!.body)) as { ids: string[]; unread: boolean };
      return [`${b.ids.join(",")} ${b.unread ? "unread" : "read"}`];
    });
  };
  /** A server that keeps what `PATCH /messages` wrote: every later sync answers the rows as they now stand. */
  const mountKeeping = async (creates: Array<ReturnType<typeof create>>): Promise<HTMLElement> => {
    const held = new Map(creates.map((c) => [`${c.type}:${c.id}`, c]));
    answerSyncWith(() => new Response(
      JSON.stringify({ changes: { creates: [...held.values()].map((c) => ({ ...c, seq: ++seq })), updates: [], moves: [], deletes: [] }, cursor: `c${seq}`, hasMore: false, serverTime: ISO }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const inner = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET").toUpperCase() === "PATCH" && /\/messages(\?|$)/.test(String(input))) {
        const b = JSON.parse(String(init!.body)) as { ids: string[]; unread: boolean };
        for (const id of b.ids) {
          const c = held.get(`message:${id}`);
          if (c) held.set(`message:${id}`, { ...c, entity: { ...c.entity, unread: b.unread } });
        }
      }
      return (inner as unknown as (i: unknown, n?: RequestInit) => Promise<Response>)(input, init);
    }) as unknown as typeof globalThis.fetch;
    const host = await mountShell([mailbox({ id: "mb_1", address: ME, lastSyncAt: ISO })]);
    await settle();
    return host;
  };

  it("a pick (x), then `u`, marks the letter unread and leaves our reply read; then `a` files the row", async () => {
    const host = await mountKeeping(answered());
    await click(theRow(host));
    await key("x");
    await key("u");
    await settle();
    expect(seenPatches(), "our own reply stays read").toEqual(["a1 unread"]);
    expect(theRow(host).dataset.id).toBe("a1");
    await key("Escape");
    await click(theRow(host));
    await key("a");
    expect(sortedPosts()).toEqual([["a1", "reply_later"], ["x2", "reply_later"]]);
  }, 60_000);

  it("the letter and our reply both unread (a phone's row swipe synced over): `a` files the row", async () => {
    const host = await mount([consent(LENA.address), message("a1", OLDER, { unread: true }), message("x2", NEWER, { ...OURS, unread: true }), thread("T", ["a1", "x2"])]);
    expect(theRow(host).dataset.id).toBe("a1");
    await click(theRow(host));
    await key("a");
    expect(sortedPosts()).toEqual([["a1", "reply_later"], ["x2", "reply_later"]]);
  }, 60_000);

  it("our reply alone unread (an earlier `u` on the row left it): `a` files the row", async () => {
    const host = await mount([consent(LENA.address), message("a1", OLDER), message("x2", NEWER, { ...OURS, unread: true }), thread("T", ["a1", "x2"])]);
    expect(theRow(host).dataset.id).toBe("a1");
    await click(theRow(host));
    await key("a");
    expect(sortedPosts()).toEqual([["a1", "reply_later"], ["x2", "reply_later"]]);
  }, 60_000);
});

describe("an answered conversation's row draws the tags of what its verbs act on", () => {
  const paletteTag = async (): Promise<void> => {
    await key("k", { ctrlKey: true });
    const option = [...document.querySelectorAll<HTMLElement>(".palette li[role=option]")]
      .find((li) => (li.textContent ?? "").includes("Keepme"));
    expect(option, "the palette's Tag: Keepme").toBeTruthy();
    await click(option!);
  };

  it("the palette's Tag puts the chip on the row, and a second press takes it off", async () => {
    const host = await mount([TAG, ...answered()]);
    await click(theRow(host));
    await paletteTag();
    expect(tagPosts()).toEqual(['a1 {"tagId":"tag_1","assigned":true}']);
    expect(chips(theRow(host))).toEqual(["Keepme"]);
    await paletteTag();
    expect(tagPosts()[1]).toBe('a1 {"tagId":"tag_1","assigned":false}');
    expect(chips(theRow(host))).toEqual([]);
  }, 60_000);

  it("the letter's tag is drawn and our reply's is not, as on the phone's row", async () => {
    const onLetter = await mount([TAG, ...answered({ labels: ["tag_1"] })]);
    expect(chips(theRow(onLetter))).toEqual(["Keepme"]);
    await teardownShellEnv();
    installShellEnv(); seq = 0; window.location.hash = "#/ohbox";
    const onReply = await mount([TAG, consent(LENA.address), message("a1", OLDER), message("x2", NEWER, { ...OURS, labels: ["tag_1"] }), thread("T", ["a1", "x2"])]);
    expect(chips(theRow(onReply))).toEqual([]);
  }, 60_000);
});

describe("the cursor lands on a row's target, never on a member it does not stand for", () => {
  it("⌫ on the first answered conversation, then `a`, files the next one's row", async () => {
    const host = await mount(twoAnswered());
    expect(rows(host).map((r) => r.dataset.id)).toEqual(["a1", "b1"]);
    await click(rows(host)[0]!);
    await key("Backspace");
    expect(selRow(host), "the advance lands on the next row").toBe("b1");
    expect(focusedPanel(host)).toBe("b1");
    await key("a");
    expect(sortedPosts()).toEqual([["b1", "reply_later"], ["y2", "reply_later"]]);
  }, 60_000);

  it("the first press with no cursor places it on the answered conversation's row", async () => {
    const host = await mount(twoAnswered());
    await key("a");
    expect(triagePosts(), "the press that places performs nothing").toEqual([]);
    expect(selRow(host)).toBe("a1");
    await key("a");
    expect(sortedPosts()).toEqual([["a1", "reply_later"], ["x2", "reply_later"]]);
  }, 60_000);
});

describe("Park on a conversation's row parks the row", () => {
  /** T: Lena's a1 and Kai's newer b2 in the Ohbox, c0 parked before; z9 a lone letter below. */
  const AT_PARK = { setAt: ISO, updatedAt: ISO, bubbleUpAt: null };
  const conversation = () => [
    consent(LENA.address), consent(KAI.address),
    message("c0", "2026-08-03T07:00:00.000Z", { triage: { messageId: "c0", state: "set_aside", ...AT_PARK } }),
    message("a1", OLDER), message("b2", NEWER, { from: KAI, subject: "Re: Q3 plan" }),
    thread("T", ["c0", "a1", "b2"]),
    message("z9", "2026-08-02T08:00:00.000Z", { threadId: "Z", subject: "Garden" }),
  ];
  const sorted = sortedPosts;

  it("`e` parks both Ohbox members, the row leaves and the selection moves on; `z` brings both back", async () => {
    const host = await mount(conversation());
    expect(rows(host).map((r) => r.dataset.id)).toEqual(["b2", "z9"]);
    await click(rows(host)[0]!);
    await key("e");
    expect(sorted()).toEqual([["a1", "set_aside"], ["b2", "set_aside"]]);
    expect(rows(host).map((r) => r.dataset.id), "the row left the Ohbox").toEqual(["z9"]);
    expect(selRow(host)).toBe("z9");
    await key("z");
    expect(sorted().filter(([, s]) => s === "none")).toEqual([["a1", "none"], ["b2", "none"]]);
    expect(rows(host).map((r) => r.dataset.id), "the row is back").toEqual(["b2", "z9"]);
  }, 60_000);

  it("opened, the bar's Park parks both Ohbox members", async () => {
    const host = await mount(conversation());
    await openRow(host);
    await click(bar(host, "abar-aside"));
    expect(sorted()).toEqual([["a1", "set_aside"], ["b2", "set_aside"]]);
  }, 60_000);

  it("answered between two letters: `e` parks all three, the row leaves; `z` brings all three back", async () => {
    const host = await mount([
      consent(LENA.address), consent(KAI.address),
      message("a1", OLDER), message("x2", NEWER, OURS),
      message("b3", "2026-08-03T10:00:00.000Z", { from: KAI, subject: "Re: Q3 plan" }),
      thread("T", ["a1", "x2", "b3"]),
      message("z9", "2026-08-02T08:00:00.000Z", { threadId: "Z", subject: "Garden" }),
    ]);
    expect(rows(host).map((r) => r.dataset.id)).toEqual(["b3", "z9"]);
    await click(rows(host)[0]!);
    await key("e");
    expect(sorted()).toEqual([["a1", "set_aside"], ["b3", "set_aside"], ["x2", "set_aside"]]);
    expect(rows(host).map((r) => r.dataset.id), "the row left the Ohbox").toEqual(["z9"]);
    expect(selRow(host)).toBe("z9");
    await key("z");
    expect(sorted().filter(([, s]) => s === "none")).toEqual([["a1", "none"], ["b3", "none"], ["x2", "none"]]);
    expect(rows(host).map((r) => r.dataset.id), "the row is back").toEqual(["b3", "z9"]);
  }, 60_000);

  it("a Resurfaced row: `e` parks the resurfaced letter, never a member filed elsewhere", async () => {
    const host = await mount([
      consent(LENA.address), consent(KAI.address),
      message("o1", "2026-08-03T06:00:00.000Z", { folder: "Archive" }),
      message("l2", OLDER, { triage: { messageId: "l2", state: "reply_later", ...AT_PARK } }),
      message("p3", NEWER, { from: KAI, subject: "Re: Q3 plan", triage: { messageId: "p3", state: "resurfaced", ...AT_PARK } }),
      thread("T", ["o1", "l2", "p3"]),
    ]);
    await click(rows(host)[0]!);
    await key("e");
    expect(triagePosts()).toEqual([["p3", "set_aside"]]);
  }, 60_000);

  it("in Parked, `e` on a parked member of a Resurfaced conversation unparks it alone", async () => {
    window.location.hash = "#/triage/aside";
    const host = await mount([
      consent(LENA.address), consent(KAI.address),
      message("c0", OLDER, { triage: { messageId: "c0", state: "set_aside", ...AT_PARK } }),
      message("p3", NEWER, { from: KAI, subject: "Re: Q3 plan", triage: { messageId: "p3", state: "resurfaced", ...AT_PARK } }),
      thread("T", ["c0", "p3"]),
    ]);
    const c0 = rows(host).find((r) => r.dataset.id === "c0");
    expect(c0, "c0 listed in Parked").toBeTruthy();
    await click(c0!);
    await key("e");
    expect(triagePosts()).toEqual([["c0", "none"]]);
  }, 60_000);

  it("CONTROL: a lone message's `e` parks it alone, and `z` brings it back", async () => {
    const host = await mount(conversation());
    await click(rows(host)[1]!);
    await key("e");
    expect(triagePosts()).toEqual([["z9", "set_aside"]]);
    await key("z");
    expect(triagePosts()).toEqual([["z9", "set_aside"], ["z9", "none"]]);
  }, 60_000);
});

describe("CONTROLS", () => {
  it("an unanswered letter: `a` files the letter", async () => {
    const host = await mount([consent(LENA.address), message("a1", OLDER), thread("T", ["a1"])]);
    expect(theRow(host).dataset.id).toBe("a1");
    await click(theRow(host));
    await key("a");
    expect(triagePosts()).toEqual([["a1", "reply_later"]]);
  }, 60_000);

  it("a threadless message: `a` files it", async () => {
    const host = await mount([consent(LENA.address), message("s1", OLDER, { threadId: null })]);
    await click(theRow(host));
    await key("a");
    expect(triagePosts()).toEqual([["s1", "reply_later"]]);
  }, 60_000);

  it("the letter unread: the row stands for the letter", async () => {
    const host = await mount(answered({ unread: true }));
    expect(theRow(host).dataset.id).toBe("a1");
  }, 60_000);

  it("our own note alone: its row files it", async () => {
    const host = await mount([consent(LENA.address), message("n1", NEWER, { ...OURS, threadId: "N", subject: "Note" })]);
    expect(theRow(host).dataset.id).toBe("n1");
    await click(theRow(host));
    await key("a");
    expect(triagePosts()).toEqual([["n1", "reply_later"]]);
  }, 60_000);

  it("a pick of two letters and our own note alone files all three", async () => {
    const host = await mount([
      consent(LENA.address),
      message("b1", OLDER, { threadId: "B" }), message("c1", OLDER, { threadId: "C" }),
      message("n1", NEWER, { ...OURS, threadId: "N", subject: "Note" }),
    ]);
    for (const r of rows(host)) { await click(r); await key("x"); }
    await key("a");
    expect(triagePosts().map(([id]) => id).sort()).toEqual(["b1", "c1", "n1"]);
  }, 60_000);
});

describe("Answer later and Parked hold a conversation as one row", () => {
  /** T: six letters from Lena and Kai, then our reply x7; z9 a lone letter below. */
  const FILED = { setAt: ISO, updatedAt: ISO, bubbleUpAt: null };
  const IDS = ["m1", "m2", "m3", "m4", "m5", "m6", "x7"];
  const seven = (stateOf: (id: string) => string | null = () => null) => {
    const filed = (id: string) => (stateOf(id) ? { triage: { messageId: id, state: stateOf(id), ...FILED } } : {});
    return [
      consent(LENA.address), consent(KAI.address),
      ...IDS.slice(0, 6).map((id, i) => message(id, `2026-08-03T0${i + 1}:00:00.000Z`, { ...(i % 2 ? { from: KAI } : {}), ...filed(id) })),
      message("x7", "2026-08-03T07:00:00.000Z", { ...OURS, ...filed("x7") }),
      thread("T", IDS),
      message("z9", "2026-08-02T08:00:00.000Z", { threadId: "Z", subject: "Garden" }),
    ];
  };
  const all = (state: string): Array<[string, string]> => IDS.map((id) => [id, state]);
  const posted = (state: string) => sortedPosts().filter(([, s]) => s === state);
  const goTo = async (hash: string): Promise<void> => {
    await act(async () => { window.location.hash = hash; window.dispatchEvent(new Event("hashchange")); });
    await settle();
  };
  const railCount = (host: HTMLElement, id: string): string =>
    (host.querySelector<HTMLElement>(`[data-rail-id="${id}"]`)?.textContent ?? "").replace(/\D+/g, " ").trim();
  const ids = (host: HTMLElement) => rows(host).map((r) => r.dataset.id);
  /** What the server holds; a test may add to it, and the next sync serves it. */
  let held = new Map<string, ReturnType<typeof create>>();
  /** A server that keeps what `POST /messages/:id/triage` wrote: every later sync serves the rows as they now stand. */
  const mount = async (creates: Array<ReturnType<typeof create>>): Promise<HTMLElement> => {
    held = new Map(creates.map((c) => [`${c.type}:${c.id}`, c]));
    answerSyncWith(() => new Response(
      JSON.stringify({ changes: { creates: [...held.values()].map((c) => ({ ...c, seq: ++seq })), updates: [], moves: [], deletes: [] }, cursor: `c${seq}`, hasMore: false, serverTime: ISO }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const inner = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const hit = /\/messages\/([^/?]+)\/triage/.exec(String(input));
      if (hit && (init?.method ?? "GET").toUpperCase() === "POST") {
        const id = decodeURIComponent(hit[1]!);
        const b = JSON.parse(String(init!.body)) as { state: string; bubbleUpAt?: string };
        const c = held.get(`message:${id}`);
        const at = new Date().toISOString();
        if (c) held.set(`message:${id}`, { ...c, entity: { ...c.entity, triage: { messageId: id, state: b.state, bubbleUpAt: b.bubbleUpAt ?? null, setAt: at, updatedAt: at } } });
      }
      return (inner as unknown as (i: unknown, n?: RequestInit) => Promise<Response>)(input, init);
    }) as unknown as typeof globalThis.fetch;
    const host = await mountShell([mailbox({ id: "mb_1", address: ME, lastSyncAt: ISO })]);
    await settle();
    return host;
  };

  it("Park on the row files all seven; Parked lists one row, and the rail and the segment say 1", async () => {
    const host = await mount(seven());
    expect(ids(host)).toEqual(["m6", "z9"]);
    await click(rows(host)[0]!);
    await key("e");
    expect(sortedPosts()).toEqual(all("set_aside"));
    await goTo("#/triage/aside");
    expect(ids(host), "one row, facing the newest letter").toEqual(["m6"]);
    expect(railCount(host, "triage-aside")).toBe("1");
    expect(host.querySelector(".triage-seg")?.textContent).toContain(`${en.triage.setAside} 1`);
  }, 60_000);

  it("in Parked, `e` takes all seven out in one press and the Ohbox has the row back; `z` parks all seven again", async () => {
    window.location.hash = "#/triage/aside";
    const host = await mount(seven(() => "set_aside"));
    expect(ids(host)).toEqual(["m6"]);
    await click(rows(host)[0]!);
    await key("e");
    expect(sortedPosts()).toEqual(all("none"));
    expect(ids(host)).toEqual([]);
    await goTo("#/ohbox");
    expect(ids(host), "the conversation is one Ohbox row again").toEqual(["m6", "z9"]);
    await goTo("#/triage/aside");
    await key("z");
    expect(posted("set_aside")).toEqual(all("set_aside"));
    expect(ids(host)).toEqual(["m6"]);
  }, 60_000);

  it("in Parked, `a` moves all seven to Answer later, and `z` puts them back", async () => {
    window.location.hash = "#/triage/aside";
    const host = await mount(seven(() => "set_aside"));
    await click(rows(host)[0]!);
    await key("a");
    expect(sortedPosts()).toEqual(all("reply_later"));
    expect(ids(host)).toEqual([]);
    await key("z");
    expect(posted("set_aside")).toEqual(all("set_aside"));
    expect(ids(host)).toEqual(["m6"]);
  }, 60_000);

  it("in Parked, `b` books all seven, and `z` parks them again", async () => {
    window.location.hash = "#/triage/aside";
    const host = await mount(seven(() => "set_aside"));
    await click(rows(host)[0]!);
    await key("b");
    expect(sortedPosts()).toEqual(all("bubbled_up"));
    await key("z");
    expect(posted("set_aside")).toEqual(all("set_aside"));
  }, 60_000);

  it("`a` on an answered row queues the letter and our reply, the row leaves; Answer later faces the letter; `z` restores both", async () => {
    const host = await mount(answered());
    await click(theRow(host));
    await key("a");
    expect(sortedPosts()).toEqual([["a1", "reply_later"], ["x2", "reply_later"]]);
    expect(rows(host)).toEqual([]);
    await key("z");
    expect(posted("none")).toEqual([["a1", "none"], ["x2", "none"]]);
    expect(ids(host)).toEqual(["a1"]);
    await key("a");
    await goTo("#/triage");
    expect(ids(host)).toEqual(["a1"]);
  }, 60_000);

  it("a pick (x) then `e` or `a` files the same set as the key", async () => {
    for (const [k, state] of [["e", "set_aside"], ["a", "reply_later"]] as const) {
      const host = await mount(seven());
      await click(rows(host)[0]!);
      await key("x");
      await key(k);
      expect(sortedPosts()).toEqual(all(state));
      await teardownShellEnv();
      installShellEnv(); seq = 0; window.location.hash = "#/ohbox";
    }
  }, 120_000);

  it("Answer later and Parked each list one row after a reload over a conversation split between them; Reply Run is one step", async () => {
    window.location.hash = "#/triage";
    const host = await mount(seven((id) => (id === "m1" || id === "m2" ? "reply_later" : "set_aside")));
    expect(ids(host)).toEqual(["m2"]);
    expect(railCount(host, "triage")).toBe("1");
    expect(railCount(host, "triage-aside")).toBe("1");
    await key("f");
    expect(document.body.textContent).toContain(en.triage.runProgress.replace("{step}", "1").replace("{total}", "1"));
  }, 60_000);

  /** All of T parked, and a lone parked letter z9 NEWER than T, so z9 is Parked's first row. */
  const parkedAboveT = (extra: Array<ReturnType<typeof create>> = []) => [
    ...seven(() => "set_aside").filter((c) => c.id !== "z9"),
    message("z9", "2026-08-03T10:00:00.000Z", { threadId: "Z", subject: "Garden", triage: { messageId: "z9", state: "set_aside", ...FILED } }),
    ...extra,
  ];
  const eight = (state: string) => [...all(state), ["m8", state] as [string, string]].sort((x, y) => (x.join() < y.join() ? -1 : 1));
  const newPosts = (from: number) => triagePosts().slice(from).sort((x, y) => (x.join() < y.join() ? -1 : 1));

  it("a link to a member that is not the row's target opens that row in the column; `e` takes that conversation out", async () => {
    window.location.hash = "#/triage/aside/m/m3";
    const host = await mount(parkedAboveT());
    expect(ids(host)).toEqual(["z9", "m6"]);
    expect(selRow(host), "the cursor is on T's row").toBe("m6");
    expect(document.querySelector(".reader"), "no sheet over the column").toBeNull();
    await key("e");
    expect(sortedPosts()).toEqual(all("none"));
  }, 60_000);

  it("Back to the row's old target after a newer letter joined it: `e` takes the whole conversation out", async () => {
    window.location.hash = "#/triage/aside";
    const host = await mount(parkedAboveT([message("m8", "2026-08-03T08:00:00.000Z", { from: KAI }), thread("T", [...IDS, "m8"])]));
    await click(rows(host).find((r) => r.dataset.id === "m6")!);
    await goTo("#/ohbox");
    await click(rows(host).find((r) => r.dataset.id === "m8")!);
    await key("e");
    expect(sortedPosts()).toEqual([["m8", "set_aside"]]);
    await goTo("#/triage/aside/m/m6");
    expect(selRow(host), "the cursor is on T's row, now facing m8").toBe("m8");
    expect(document.querySelector(".reader")).toBeNull();
    const before = triagePosts().length;
    await key("e");
    expect(newPosts(before)).toEqual(eight("none"));
  }, 60_000);

  it("a newer letter joining the open row from another device keeps the cursor on that row", async () => {
    window.location.hash = "#/triage/aside";
    const host = await mount(parkedAboveT());
    await click(rows(host).find((r) => r.dataset.id === "m6")!);
    expect(selRow(host)).toBe("m6");
    held.set("message:m8", message("m8", "2026-08-03T08:00:00.000Z", { from: KAI, triage: { messageId: "m8", state: "set_aside", ...FILED } }));
    held.set("thread:T", thread("T", [...IDS, "m8"]));
    for (let i = 0; i < 8; i++) await tick(15_000);
    await settle();
    expect(ids(host)).toEqual(["z9", "m8"]);
    expect(selRow(host), "the cursor follows the row to its new target").toBe("m8");
    await key("e");
    expect(sortedPosts()).toEqual(eight("none"));
  }, 120_000);

  it("CONTROL: a lone letter in Parked comes out alone", async () => {
    window.location.hash = "#/triage/aside";
    const host = await mount([consent(LENA.address), message("s1", OLDER, { threadId: null, triage: { messageId: "s1", state: "set_aside", ...FILED } })]);
    await click(rows(host)[0]!);
    await key("e");
    expect(triagePosts()).toEqual([["s1", "none"]]);
  }, 60_000);
});
