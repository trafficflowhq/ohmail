/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ISO, act, answerSyncWith, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell.js";
import en from "../messages/en.json";

/**
 * LATER AND PARK ON AN ANSWERED CONVERSATION FILE THE LETTER, through the shipped
 * shell and the real engine. `a1` is Lena's letter, read; `x2` is our own newer reply, so the row
 * wears the reply. Every triage verb on the row (the keys, the bar, the sheet, the palette, a pick,
 * a drag) sends one `POST /messages/a1/triage` and nothing for `x2`. Standing for its face, the row
 * filed our reply and left the letter in the Ohbox.
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

  it("`a` files the letter alone, and the Reply Run pile lists the letter", async () => {
    const host = await mount(answered());
    await click(theRow(host));
    await key("a");
    expect(triagePosts()).toEqual([["a1", "reply_later"]]);
    await act(async () => {
      window.location.hash = "#/triage";
      window.dispatchEvent(new Event("hashchange"));
    });
    await settle();
    const listed = [...host.querySelectorAll<HTMLElement>(".row[data-id]")].map((r) => r.dataset.id);
    expect(listed).toContain("a1");
    expect(listed).not.toContain("x2");
  }, 60_000);

  it("`e` parks the letter", async () => {
    const host = await mount(answered());
    await click(theRow(host));
    await key("e");
    expect(triagePosts()).toEqual([["a1", "set_aside"]]);
  }, 60_000);

  it("opened, the bar's Later acts on the letter, which is the focused panel", async () => {
    const host = await mount(answered());
    await openRow(host);
    expect(focusedPanel(host)).toBe("a1");
    await click(bar(host, "abar-later"));
    expect(triagePosts()).toEqual([["a1", "reply_later"]]);
  }, 60_000);

  it("opened, the bar's Park acts on the letter", async () => {
    const host = await mount(answered());
    await openRow(host);
    await click(bar(host, "abar-aside"));
    expect(triagePosts()).toEqual([["a1", "set_aside"]]);
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

  it("at phone width, the sheet's Later acts on the letter", async () => {
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
    expect(triagePosts()).toEqual([["a1", "reply_later"]]);
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

  it("a pick of the row (x), then `a`, files the letter alone", async () => {
    const host = await mount(answered());
    await click(theRow(host));
    await key("x");
    await key("a");
    expect(triagePosts()).toEqual([["a1", "reply_later"]]);
  }, 60_000);

  it("the row dragged to the Reply Run files the letter alone", async () => {
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
    expect(triagePosts()).toEqual([["a1", "reply_later"]]);
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

  it("a pick (x), then `u`, marks the letter unread and leaves our reply read; then `a` files the letter", async () => {
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
    expect(triagePosts()).toEqual([["a1", "reply_later"]]);
  }, 60_000);

  it("the letter and our reply both unread (a phone's row swipe synced over): `a` files the letter", async () => {
    const host = await mount([consent(LENA.address), message("a1", OLDER, { unread: true }), message("x2", NEWER, { ...OURS, unread: true }), thread("T", ["a1", "x2"])]);
    expect(theRow(host).dataset.id).toBe("a1");
    await click(theRow(host));
    await key("a");
    expect(triagePosts()).toEqual([["a1", "reply_later"]]);
  }, 60_000);

  it("our reply alone unread (an earlier `u` on the row left it): `a` files the letter", async () => {
    const host = await mount([consent(LENA.address), message("a1", OLDER), message("x2", NEWER, { ...OURS, unread: true }), thread("T", ["a1", "x2"])]);
    expect(theRow(host).dataset.id).toBe("a1");
    await click(theRow(host));
    await key("a");
    expect(triagePosts()).toEqual([["a1", "reply_later"]]);
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
  it("⌫ on the first answered conversation, then `a`, files the next one's letter", async () => {
    const host = await mount(twoAnswered());
    expect(rows(host).map((r) => r.dataset.id)).toEqual(["a1", "b1"]);
    await click(rows(host)[0]!);
    await key("Backspace");
    expect(selRow(host), "the advance lands on the next row").toBe("b1");
    expect(focusedPanel(host)).toBe("b1");
    await key("a");
    expect(triagePosts()).toEqual([["b1", "reply_later"]]);
  }, 60_000);

  it("the first press with no cursor places it on the answered conversation's row", async () => {
    const host = await mount(twoAnswered());
    await key("a");
    expect(triagePosts(), "the press that places performs nothing").toEqual([]);
    expect(selRow(host)).toBe("a1");
    await key("a");
    expect(triagePosts()).toEqual([["a1", "reply_later"]]);
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
