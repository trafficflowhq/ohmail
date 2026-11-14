/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, useEffect } from "react";
import { MAX_RAW_MESSAGE_BYTES } from "@trafficflow/core/mail";
import type { ListMeeting } from "@ohmail/app-logic/reading";
import { letterBody } from "../../../packages/app/src/reader/body/index.js";
import type { LetterProps, ReaderFile, ReaderFiles, ReaderReply } from "../../../packages/app/src/reader/index.js";
import { screenerPlace } from "../../../packages/app/src/screener/place.js";
import messages from "../messages/en.json";
import {
  READER_EN,
  READER_PLACE,
  freshRecord,
  letter,
  letterOf,
  lettersShown,
  mountLetters,
  type MountLetters,
} from "./_reader-1-letters.js";

/**
 * THE CONVERSATION IN THE READER: ONE LETTER PER MESSAGE, EACH WITH ITS BODY ON SCREEN.
 *
 * Every message on the thread is a letter of the reading column with its body on screen, oldest first, and NOTHING
 * stands in for a message: no peek row, no "N messages" count, no "show earlier" control.
 *
 * RE-POINTED ONTO THE NEW READER (share reader-1, the older tests sorted once): these cases mounted today's
 * `MessagePane` under a `MessageChromeProvider`; they now mount the reading column the new shell mounts
 * (`_reader-1-letters.tsx`: the frame, the reader, a fake engine), each expectation as it stood. What today's chrome
 * handed the pane is handed where the new shell hands it: the conversation is the mirror's letters of one thread, a
 * body is a `message_body` row of the mirror, the files, the look at a file and the reply are the reader's parts, the
 * account's own addresses and its mailboxes' status are the host's mailbox facts. Where a case read today's class
 * names it reads roles and names; where it pinned today's sentence for a claim the new reader says in its own
 * catalogue words, it reads that key (`reader.en.json`). The cases of a letter answered in its reading stream moved to
 * `conversation-in-a-stream.test.ts` (their place is not mounted yet). Every address is invented.
 */

/* The reader stamps in Intl's zone: the case pins it, so the assertions are not about the machine running the suite. */
process.env.TZ = "UTC";

const NOW = new Date("2026-08-02T12:00:00.000Z");
const conversation = { threadId: "t1" };
/** The server's own Sent path: outside the frozen `Folder` union on purpose, as a client must tolerate it (contract §8). */
const SENT = "Sent" as EngineMessage["folder"];
const BODY = READER_EN.body;

/** A letter of the conversation: read, to the account alone, its body the mirror's row unless it carries one. */
function msg(
  id: string,
  over: Partial<EngineMessage> & { sensitive?: boolean } = {},
): EngineMessage {
  const { sensitive, ...rest } = over;
  return letter(id, {
    subject: "Quote for the north elevation",
    from: { name: `Sender ${id}`, address: `${id}@example.invalid` },
    to: [],
    unread: false,
    snippet: `snippet-${id}`,
    ...(sensitive
      ? {
          sensitivity: {
            sensitive: true,
            category: "otp",
            no_ai: true,
            no_forward: true,
            no_kb: true,
            priority: true,
          },
        }
      : {}),
    ...rest,
  });
}

const A = msg("a", { ...conversation, date: "2026-07-30T09:00:00.000Z" });
const B = msg("b", { ...conversation, subject: "Re: Quote for the north elevation", date: "2026-07-31T09:00:00.000Z" });
const C = msg("c", { ...conversation, subject: "Re: Quote for the north elevation", date: "2026-08-01T09:00:00.000Z" });
/** A message the account wrote, read back out of Sent. */
const MINE = msg("mine", {
  ...conversation,
  subject: "Re: Quote for the north elevation",
  date: "2026-07-31T10:00:00.000Z",
  folder: SENT,
});
const SOLO = msg("solo", { subject: "Just this", date: "2026-08-01T09:00:00.000Z" });
/** The account's own mailbox, as the host's mailbox facts name it. */
const OWN = "owner@example.invalid";
const ME = [{ id: "mb-1", address: OWN, addressIsOwn: true, status: "connected" }];

/** The letter without its text: the mirror's body row says where it stands. */
const bare = (m: EngineMessage): EngineMessage => ({ ...m, body: undefined }) as EngineMessage;
/** The same body row for each letter. */
const rows = (ids: readonly string[], row: unknown): Record<string, unknown> =>
  Object.fromEntries(ids.map((id) => [id, row]));

/** What the reply the shell hands recorded: each open, `id`, `id+all` or `fwd:id`. */
function replyPart(): { reply: ReaderReply; opened: string[] } {
  const opened: string[] = [];
  const reply: ReaderReply = {
    Sheet: () => createElement("div", { role: "textbox", "aria-label": "Your reply" }),
    useOpen: () => (id, how) => {
      opened.push(how === "reply_all" ? `${id}+all` : how === "forward" ? `fwd:${id}` : id);
    },
    useVerbs: () => null,
  };
  return { reply, opened };
}

/** A file door over fixed lists per letter, recording every hold, every ask and every save. */
function fileDoor(byId: Record<string, readonly ReaderFile[]>) {
  const held: string[] = [];
  const asked: Array<{ id: string; inline: boolean }> = [];
  const cids: Array<[string, string[]]> = [];
  const door: ReaderFiles = {
    hold: (id) => {
      held.push(id);
      return () => undefined;
    },
    itemsOf: (id, opts) => {
      asked.push({ id, inline: opts?.includeInlineParts === true });
      return { state: "ready", items: byId[id] ?? [] };
    },
    open: () => undefined,
    ensure: () => undefined,
    downloadAll: () => undefined,
    downloadingAll: () => false,
    cidImagesOf: () => new Map(),
    needCidImages: (id, wanted) => {
      cids.push([id, wanted]);
    },
  };
  return { door, held, asked, cids };
}
const file = (id: string, filename: string, mimeType = "image/png", sizeBytes = 9): ReaderFile => ({
  id,
  filename,
  mimeType,
  sizeBytes,
  state: "idle",
  inline: false,
});

/** The Ohbox's visit of the opened letter, as its list hands it: Mark unread recorded by letter. */
function ohboxMeeting(openId: string, previewing = false): ListMeeting {
  return {
    blank: null,
    visit: {
      openId,
      unread: false,
      readSet: [],
      act: () => undefined,
      wiring: {
        look: "tint",
        record: freshRecord(),
        onRead: vi.fn(),
        onEnter: vi.fn(),
        onMarkUnread: vi.fn(),
        previewing,
      },
      step: {
        up: { disabled: false, run: vi.fn(), label: "Previous" },
        down: { disabled: false, run: vi.fn(), label: "Next" },
      },
    },
  } as unknown as ListMeeting;
}

const mount = (o: MountLetters) => mountLetters(o);
const articles = (): HTMLElement[] => screen.getAllByRole("article");
const text = (): string => document.body.textContent ?? "";
/** The letter's menu, by the letter it stands on. */
const menuOf = (id: string): HTMLButtonElement =>
  within(letterOf(id)!).getByRole("button", { name: "Message" }) as HTMLButtonElement;
/** The items of a letter's menu, in order, read with it open and closed again. */
function itemsOf(id: string): string[] {
  fireEvent.click(menuOf(id));
  const items = screen.getAllByRole("menuitem").map((i) => (i.textContent ?? "").trim());
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  return items;
}
function pressItem(id: string, name: string): void {
  fireEvent.click(menuOf(id));
  fireEvent.click(screen.getByRole("menuitem", { name }));
}
/** What a letter's read body says of its text: its notice's words, or "" where it says nothing. */
const said = (id: string): string =>
  [...within(letterOf(id)!).queryAllByRole("status"), ...within(letterOf(id)!).queryAllByRole("alert")]
    .map((n) => n.textContent ?? "")
    .join(" ");
/** The sender's line of a letter: the head's one way to the sender's card. */
const senderOf = (id: string): HTMLElement =>
  within(letterOf(id)!)
    .getAllByRole("button")
    .find((b) => b.getAttribute("aria-haspopup") === "dialog")!;

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("an open message shows the rest of its conversation", () => {
  it("renders all THREE messages of a three-deep thread as distinct panels, oldest first", () => {
    mount({ letters: [A, B, C], open: "b" });
    expect(articles()).toHaveLength(3);
    expect(lettersShown()).toEqual(["a", "b", "c"]);
  });

  it("renders exactly conversation-length FULL-BODY panels — no peek row, no count standing in", () => {
    mount({ letters: [A, B, C], open: "c" });
    const ids = lettersShown();
    expect(ids).toEqual(["a", "b", "c"]);
    expect(new Set(ids).size).toBe(3);
    // Every letter carries its body ON SCREEN — nothing is one press away, nothing is withheld.
    for (const id of ids) expect(letterOf(id)!.textContent, `letter ${id} has no body on screen`).toContain(`The text of ${id}.`);
    // The placeholder vocabulary is gone in every form: no fold, no aggregate, no count.
    expect(screen.queryByRole("button", { name: /earlier|more messages|show all/i }), "a fold stands in for a message").toBeNull();
    expect(text()).not.toContain("on this conversation");
    expect(letterOf("c")!.getAttribute("aria-current")).toBe("true");
  });

  it("puts the OPENED message in its chronological place, not at the top", () => {
    mount({ letters: [A, B, C], open: "a" });
    expect(lettersShown()).toEqual(["a", "b", "c"]);
  });

  it("marks the opened message as the current one, and only it", () => {
    mount({ letters: [A, B, C], open: "b" });
    const current = [...document.querySelectorAll<HTMLElement>('[data-conv-id][aria-current="true"]')];
    expect(current).toHaveLength(1);
    expect(current[0]!.dataset.convId).toBe("b");
    // …and it keeps the full message anatomy: a letter like its siblings, its text on screen.
    expect(within(current[0]!).getByRole("article")).toBeTruthy();
    expect(current[0]!.textContent).toContain("The text of b.");
  });

  it("renders the user's OWN reply, and no longer claims it cannot", () => {
    mount({ letters: [A, { ...MINE, body: "snippet-mine" } as EngineMessage, C], open: "c" });
    expect(lettersShown()).toEqual(["a", "mine", "c"]);
    expect(letterOf("mine")!.textContent).toContain("snippet-mine");
    expect(text()).not.toContain("does not watch your Sent folder");
    expect(text()).not.toContain("shows the other side only");
  });

  it("prints each panel's RAW subject — AW:/Re: included, renamed branches included", () => {
    const AW = msg("aw", { ...conversation, subject: "AW: Quote for the north elevation", date: "2026-08-01T10:00:00.000Z" });
    const renamed = msg("d", { ...conversation, subject: "Re: Revised scope — south elevation too", date: "2026-08-02T09:00:00.000Z" });
    const initial = mount({ letters: [A, B, AW, renamed], open: "b" });
    expect(screen.getByRole("heading", { level: 2, name: B.subject }).closest("article")).toBeNull();
    expect(within(letterOf("b")!).queryByText(B.subject)).toBeNull();
    initial.view.unmount();
    localStorage.setItem("ohmail.ui.reader.subject:acct-1", "each");
    mount({ letters: [A, B, AW, renamed], open: "b" });
    expect(screen.getByRole("heading", { level: 2, name: B.subject }).closest("article"))
      .toBe(within(letterOf("b")!).getByRole("article"));
    const lines = ["a", "b", "aw", "d"].map((id) =>
      [A, B, AW, renamed].find((m) => m.id === id)!.subject,
    );
    for (const [i, id] of ["a", "b", "aw", "d"].entries())
      expect(within(letterOf(id)!).queryByText(lines[i]!), `letter ${id} prints its own subject`).not.toBeNull();
    expect(lines).toEqual([
      "Quote for the north elevation",
      "Re: Quote for the north elevation",
      "AW: Quote for the north elevation",
      "Re: Revised scope — south elevation too",
    ]);
  });

  it("a sensitive sibling is not withheld — its body is on screen like any other", () => {
    const otp = msg("otp", { ...conversation, subject: "Your code", date: "2026-07-29T09:00:00.000Z", body: "code is 449 201", sensitive: true });
    mount({ letters: [otp, B], open: "b" });
    expect(letterOf("otp")!.textContent).toContain("449 201");
    expect(text()).not.toContain("(redacted)");
  });
});

/**
 * ══ ONE ACTION PANEL, AT THE FOOT OF THE CONVERSATION, BOUND TO THE OPENED MESSAGE ══════════
 *
 * The panel is mounted ONCE, outside every letter, and its verbs act on the letter that was OPENED: the focus is never
 * remapped to the newest. (Today's case pressed Screening; the sender's screening is the Screener's now, held by
 * `action-bar.test.ts`'s "the sender's screening stands in the row beside the letter's verbs".)
 */
describe("the thread's one action bar", () => {
  it("dispatches with the OPENED id even when a newer sibling is on the thread", () => {
    const { mail } = mount({ letters: [A, B, C], open: "b" }); // c is newer; the panel must still act on b
    const panels = screen.getAllByRole("toolbar", { name: "Actions" });
    expect(panels).toHaveLength(1);
    expect(panels[0]!.closest("[data-conv-id]"), "the panel was mounted inside a letter").toBeNull();
    fireEvent.click(within(panels[0]!).getByRole("button", { name: "Mark unread" }));
    expect(mail.mutations.length).toBeGreaterThan(0);
    for (const m of mail.mutations) expect(JSON.stringify(m)).toContain('"b"');
    expect(JSON.stringify(mail.mutations)).not.toContain('"c"');
  });
});

/**
 * ── THE LETTER'S OWN MENU — Reply / Reply all / Forward / Mark unread, in every letter's head ──
 *
 * Reply answers THIS letter, Reply all only where its audience is more people than Reply's, Forward hands THIS
 * letter; the answer opens the reply the shell hands (recorded here by `replyPart`).
 */
describe("the per-message actions menu", () => {
  it("MARK UNREAD, where the Ohbox wires it: appended after Reply and Forward, naming THAT panel", () => {
    const { mail } = mount({ letters: [A, B, C], open: "b", meeting: ohboxMeeting("b") });
    expect(itemsOf("a"), "the production items first, then Mark unread").toEqual(["Reply", "Forward", "Mark unread"]);
    expect(itemsOf("b"), "the opened letter's own menu too").toEqual(["Reply", "Forward", "Mark unread"]);
    pressItem("a", "Mark unread");
    expect(mail.mutations.length, "the press names the letter it was on").toBeGreaterThan(0);
    for (const m of mail.mutations) expect(JSON.stringify(m)).toContain('"a"');
  });

  it("MARK UNREAD is not offered on an unread message, nor on the account's own", () => {
    mount({ letters: [A, MINE, { ...C, unread: true }], open: "a", meeting: ohboxMeeting("a") });
    expect(itemsOf("c"), "unread already").not.toContain("Mark unread");
    expect(itemsOf("mine"), "your own").not.toContain("Mark unread");
    expect(itemsOf("a")).toContain("Mark unread");
  });

  it("⋯ on an OLDER panel dispatches THAT panel's id — never the focused one's", () => {
    const { reply, opened } = replyPart();
    mount({ letters: [A, B, C], open: "b", parts: { reply } }); // b opened; a is an older letter
    pressItem("a", "Reply");
    expect(opened).toEqual(["a"]);
    pressItem("a", "Forward");
    expect(opened).toEqual(["a", "fwd:a"]);
  });

  it("is a real disclosure: aria-haspopup='menu' with LIVE aria-expanded", () => {
    mount({ letters: [A, B, C], open: "b" });
    const t = menuOf("c");
    expect(t.getAttribute("aria-haspopup")).toBe("menu");
    expect(t.getAttribute("aria-expanded"), "closed must say closed").toBe("false");
    fireEvent.click(t);
    expect(t.getAttribute("aria-expanded"), "open must say open — a literal false is the defect the pill already fixed").toBe("true");
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("offers NO Reply-all on a 1:1 panel, and dispatches (id, all) where the audience earns it", () => {
    const { reply, opened } = replyPart();
    // A letter to the account alone — a 1:1 — offers no Reply all.
    mount({ letters: [{ ...A, to: [{ name: null, address: OWN }] }, B, C], open: "b", parts: { reply } });
    const items = itemsOf("a");
    expect(items).toContain("Reply");
    expect(items, "Reply all on a 1:1 is noise, not an option").not.toContain("Reply all");
    cleanup();

    // Two listed recipients prove somebody besides the reader is on the thread.
    const wide = msg("wide", {
      ...conversation,
      date: "2026-07-30T18:00:00.000Z",
      to: [
        { name: "Anna Roth", address: "anna@x.invalid" },
        { name: "Bo", address: "bo@x.invalid" },
      ],
    });
    mount({ letters: [wide, B], open: "b", parts: { reply } });
    expect(itemsOf("wide"), "a widened audience must offer Reply all").toContain("Reply all");
    pressItem("wide", "Reply all");
    expect(opened, "Reply all must carry the flag AND the letter's own id").toEqual(["wide+all"]);
  });

  it("offers Forward on a `no_forward` panel — the SAME predicate the pill reads (`forwardOffered`)", () => {
    const { reply, opened } = replyPart();
    const otp = msg("otp", { ...conversation, subject: "Your code", date: "2026-07-30T19:00:00.000Z", sensitive: true });
    mount({ letters: [otp, B], open: "b", parts: { reply } });
    const items = itemsOf("otp");
    expect(items, "the letter's other verbs are unaffected").toContain("Reply");
    expect(items, "a no_forward letter lost its Forward").toContain("Forward");
    pressItem("otp", "Forward");
    expect(opened).toEqual(["fwd:otp"]);
  });
});

describe("the subject line as a subject-rule entry", () => {
  it("a press on a panel's subject dispatches openSubjectRule for THAT message", () => {
    const older = { ...A, subject: "Blue roof appointment" };
    const focused = { ...B, subject: "Window budget revision", from: { ...older.from, name: "Newer sender name" } };
    mount({ letters: [older, focused], open: focused.id,
      host: { places: { ohbox: READER_PLACE, screener: { ...screenerPlace, rail: null } } } });
    fireEvent.click(within(letterOf(older.id)!).getByRole("button", { name: /^Sender a/ }));
    const contact = within(screen.getByRole("dialog", { name: /^Options for Sender a/ }));
    fireEvent.click(contact.getByRole("menuitem", { name: messages.screening.subjectRuleOpen }));
    const dialog = within(screen.getByRole("dialog", {
      name: messages.screening.subjectAria.replace("{who}", "Sender a"),
    }));
    expect(dialog.getByRole<HTMLInputElement>("textbox", { name: messages.screening.subjectTermAria }).value)
      .toBe(older.subject);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE MESSAGE HEADER — WHO IT IS FROM, AND WHO ELSE IT WENT TO
   ══════════════════════════════════════════════════════════════════════════════════════════ */
describe("the header", () => {
  it("renders exactly one from-line per message — never a doubled header", () => {
    mount({ letters: [SOLO], open: "solo" });
    expect(within(letterOf("solo")!).getAllByRole("button", { name: /Sender solo/ })).toHaveLength(1);
    cleanup();
    mount({ letters: [A, B, C], open: "b" });
    for (const id of ["a", "b", "c"])
      expect(within(letterOf(id)!).getAllByRole("button", { name: new RegExp(`Sender ${id}`) })).toHaveLength(1);
  });

  it("renders NO recipients block when there is no To and no Cc", () => {
    mount({ letters: [SOLO], open: "solo" });
    const head = letterOf("solo")!.querySelector("header")!;
    expect([...head.querySelectorAll("p")].some((p) => /^to\b/.test(p.textContent ?? ""))).toBe(false);
  });

  it("a recipient who IS the reader reads `you` — and never a stranger's chip", async () => {
    const withMe = msg("r", {
      subject: "Hi",
      to: [
        { name: null, address: OWN },
        { name: "Anna Roth", address: "anna@x.invalid" },
      ],
    });
    // Known own address → `you`.
    mount({ letters: [withMe], open: "r", host: { mailboxes: async () => ME } });
    await screen.findByRole("button", { name: "you" });
    const faces = () =>
      within(letterOf("r")!)
        .getByRole("button", { name: "Anna Roth" })
        .closest("p")!
        .querySelectorAll("button:not([data-details])");
    expect([...faces()].map((c) => c.textContent)).toEqual(["you", "Anna Roth"]);
    cleanup();
    // NOT known → the bare address, never the account's name. The explicit degradation branch.
    mount({ letters: [withMe], open: "r" });
    expect([...faces()].map((c) => c.textContent)).toEqual([OWN, "Anna Roth"]);
  });

  it("puts the relative stamp on screen with the absolute date on hover", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const dated = msg("solo", { subject: "Just this", date: "2026-08-05T14:32:00.000Z" });
    mount({ letters: [dated], open: "solo" });
    const stamp = within(letterOf("solo")!).getByRole("button", { pressed: false, name: /14:32/ });
    expect(stamp.getAttribute("title")).toBe("Wed 5 Aug 2026, 14:32");
    expect(stamp.querySelector("time")!.getAttribute("datetime")).toBe("2026-08-05T14:32:00.000Z");
  });

  it("names-first: the bold name with the small address beside it — once each", () => {
    const named = msg("n", { subject: "Hi", from: { name: "Anna Roth", address: "anna@x.invalid" } });
    mount({ letters: [named], open: "n" });
    const sender = senderOf("n");
    expect(within(sender).getByText("Anna Roth").tagName).toBe("B");
    /* The address is drawn whole by the kit's address part, its local part and its domain each a box of their own:
       the element that says it whole, and none of whose children does. */
    const saysWhole = (_: string, el: Element | null): boolean =>
      el?.textContent === "anna@x.invalid" && ![...el.children].some((c) => c.textContent === "anna@x.invalid");
    expect(within(sender).getAllByText(saysWhole)).toHaveLength(1);
    expect((sender.textContent ?? "").indexOf("Anna Roth")).toBeLessThan((sender.textContent ?? "").indexOf("anna@x.invalid"));
  });

  it("a no-name sender prints the bare address ONCE, never twice", () => {
    const bareName = msg("n", { subject: "Hi", from: { name: null, address: "verify@atlas-identity.invalid" } });
    mount({ letters: [bareName], open: "n" });
    expect(occurrences(senderOf("n").textContent ?? "", "verify@atlas-identity.invalid")).toBe(1);
  });
});

/**
 * THE FORWARD ROW. The account's own forward threads with the message it forwarded, so it stands inside that
 * conversation as its own letter, BELOW the original, and it says where it went: "Forwarded to <recipient>", in the
 * reader's language. The account's own REPLY in the same thread does not; nor does a "Fwd:" somebody else sent.
 */
describe("the forward row inside the original's conversation", () => {
  const FWD = msg("fwd", {
    ...conversation,
    subject: "Fwd: Quote for the north elevation",
    date: "2026-08-01T10:00:00.000Z",
    folder: SENT,
    to: [
      { name: "Sam Example", address: "sam@colleague.example" },
      { name: null, address: "kim@colleague.example" },
    ],
  });

  it("faces the account's own forward 'Forwarded to <recipients>', the original above it", () => {
    mount({ letters: [A, FWD], open: "a" });
    expect(lettersShown()).toEqual(["a", "fwd"]);
    const row = letterOf("fwd")!;
    expect(row.textContent).toContain("Forwarded to Sam Example, kim@colleague.example");
    // The letter still says its true subject.
    expect(row.textContent).toContain("Fwd: Quote for the north elevation");
    // The original says no such thing.
    expect(letterOf("a")!.textContent).not.toContain("Forwarded to");
  });

  it("the account's own REPLY keeps its sender face — only a forward wears the sentence", () => {
    const mineTo = msg("mine", {
      ...conversation,
      subject: "Re: Quote for the north elevation",
      date: "2026-07-31T09:00:00.000Z",
      folder: SENT,
      to: [{ name: "Sam Example", address: "sam@colleague.example" }],
    });
    mount({ letters: [A, mineTo, C], open: "c" });
    expect(senderOf("mine").textContent).not.toContain("Forwarded to");
    expect(text()).not.toContain("Forwarded to");
  });

  it("a RECEIVED 'Fwd:' is somebody else's forward and keeps its sender's name", () => {
    const theirs = msg("theirs", {
      ...conversation,
      subject: "Fwd: Quote for the north elevation",
      date: "2026-08-01T11:00:00.000Z",
      to: [{ name: "Sam Example", address: "sam@colleague.example" }],
    });
    mount({ letters: [A, theirs], open: "a" });
    expect(senderOf("theirs").textContent).toContain("Sender theirs");
    expect(letterOf("theirs")!.textContent).not.toContain("Forwarded to");
  });

  it("the German catalogue carries the same face", () => {
    const de = JSON.parse(readFileSync(resolve(__dirname, "../messages/de.json"), "utf8")) as { message: Record<string, string> };
    expect(de.message.forwardedTo).toBe("Weitergeleitet an {name}");
    expect((messages as { message: Record<string, string> }).message.forwardedTo).toBe("Forwarded to {name}");
  });
});

describe("a message with no conversation gets no conversation chrome", () => {
  it("renders no count, no note and no second pane", () => {
    mount({ letters: [{ ...SOLO, body: "snippet-solo" } as EngineMessage], open: "solo" });
    expect(articles()).toHaveLength(1);
    expect(screen.queryByRole("group", { name: /messages/ }), "a single letter draws no squares").toBeNull();
    expect(text()).not.toContain("on this conversation");
    expect(text()).not.toContain("Sent folder");
    // The body is still the body.
    expect(within(letterOf("solo")!).getByText("snippet-solo")).toBeTruthy();
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   SLICE · THE CONVERSATION IS ON SCREEN EXACTLY ONCE
   ══════════════════════════════════════════════════════════════════════════════════════════ */
describe("the conversation is on screen exactly once", () => {
  it("stays in the PANE while the editor is open — one copy, and the editor below it", () => {
    const { reply } = replyPart();
    mount({ letters: [A, { ...B, body: "snippet-b" } as EngineMessage, C], open: "b", parts: { reply } });
    const editor = screen.getByRole("textbox", { name: "Your reply" });
    expect(lettersShown()).toEqual(["a", "b", "c"]);
    expect(new Set(lettersShown()).size).toBe(3);
    // ONE copy of the body the reader came for, not a second one and not a quote of it.
    expect(occurrences(text(), "snippet-b")).toBe(1);
    expect(letterOf("c")!.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("…and it is the same one copy when the editor is closed", () => {
    mount({ letters: [A, { ...B, body: "snippet-b" } as EngineMessage, C], open: "b" });
    expect(lettersShown()).toEqual(["a", "b", "c"]);
    expect(occurrences(text(), "snippet-b")).toBe(1);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("a message with NO conversation is not repeated by the editor either", () => {
    const { reply } = replyPart();
    mount({ letters: [{ ...SOLO, body: "snippet-solo" } as EngineMessage], open: "solo", parts: { reply } });
    expect(screen.getByRole("textbox", { name: "Your reply" })).toBeTruthy();
    expect(articles()).toHaveLength(1);
    expect(occurrences(text(), "snippet-solo")).toBe(1);
    expect(text()).not.toContain("the only message ohmail has on this conversation");
  });

  it("a SENSITIVE message being answered renders its body in full (no withholding)", () => {
    const { reply } = replyPart();
    const FULL = "Your verification code is 449 201";
    mount({
      letters: [msg("otp", { subject: "Your code", sensitive: true, body: FULL })],
      open: "otp",
      parts: { reply },
    });
    expect(screen.getByRole("textbox", { name: "Your reply" })).toBeTruthy();
    expect(letterOf("otp")!.textContent).toContain("449 201");
  });
});

/** How many times `needle` occurs in `hay` — non-overlapping, plain string search. */
function occurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   SLICE · THE READING PANE SAYS WHAT ITS TEXT IS
   ══════════════════════════════════════════════════════════════════════════════════════════ */
describe("the pane distinguishes 'this is the whole message' from the three things that are not", () => {
  const SOLE = bare(SOLO);
  /** Today's bound: twice the engine's own deadline for a body, and three seconds. */
  const BODY_STALL_MS = 12_000 * 2 + 3_000;

  it("a FULL body says nothing at all — the Blanc pane, unchanged", () => {
    mount({ letters: [SOLE], open: "solo", bodies: { solo: { state: "ready", text: "snippet-solo" } } });
    expect(within(letterOf("solo")!).getByText("snippet-solo")).toBeTruthy();
    expect(said("solo")).toBe("");
  });

  it("a SNIPPET says the message is still coming — it is NOT a sub-frame state", () => {
    mount({ letters: [SOLE], open: "solo" });
    expect(said("solo")).toContain(BODY.loading);
    expect(within(letterOf("solo")!).getByText("snippet-solo")).toBeTruthy();
  });

  it("LOADING says so, beside the body and not inside it", () => {
    mount({ letters: [SOLE], open: "solo", bodies: { solo: { state: "loading" } } });
    expect(within(letterOf("solo")!).getByText("snippet-solo")).toBeTruthy();
    expect(said("solo")).toContain(BODY.loading);
    expect(within(letterOf("solo")!).queryByRole("alert"), "loading is no warning").toBeNull();
  });

  it("FAILED says so DIFFERENTLY, and carries a way out (Risk 2)", () => {
    const { mail } = mount({ letters: [SOLE], open: "solo", bodies: { solo: { state: "failed" } } });
    const note = within(letterOf("solo")!).getByRole("alert");
    expect(note.textContent).toContain(BODY.kept.failed);
    expect(note.textContent).not.toContain(BODY.loading);
    const retry = within(letterOf("solo")!).queryByRole("button", { name: BODY.kept.tryAgain });
    expect(retry, "a failed body with no control is a dead end").toBeTruthy();
    const before = mail.bodyAsks.length;
    fireEvent.click(retry!);
    expect(mail.bodyAsks.slice(before)).toEqual(["solo retry"]);
  });

  it("a sensitive message renders its body in full — no withholding at the surface", () => {
    const FULL = "Your verification code is 449 201";
    mount({ letters: [msg("otp", { subject: "Your code", sensitive: true, body: FULL })], open: "otp" });
    expect(text()).not.toContain("······");
    expect(letterOf("otp")!.textContent).toContain("449 201");
  });

  it("a LIVE sensitive message renders its body — the engine fetches it like any other", () => {
    const words = "Ich finde deine Idee mit dem Rollen-Guard gut";
    mount({ letters: [msg("otp", { subject: "Your code", sensitive: true, snippet: words, body: words })], open: "otp" });
    expect(letterOf("otp")!.textContent).toContain("Rollen-Guard");
  });

  it("a body that never arrives becomes a failure with Retry, not a permanent spinner", () => {
    vi.useFakeTimers();
    const { mail } = mount({ letters: [bare(A)], open: "a", bodies: { a: { state: "loading" } } });
    expect(said("a")).toContain(BODY.loading);
    act(() => {
      vi.advanceTimersByTime(BODY_STALL_MS + 1);
    });
    const retry = within(letterOf("a")!).queryByRole("button", { name: BODY.kept.tryAgain });
    expect(retry, "the spinner outlived the engine's own deadline").not.toBeNull();
    expect(said("a")).not.toContain(BODY.loading);
    const before = mail.bodyAsks.length;
    fireEvent.click(retry!);
    expect(mail.bodyAsks.slice(before)).toContain("a retry");
  });

  it("the spinner stands for as long as a request could still be in the air", () => {
    vi.useFakeTimers();
    mount({ letters: [bare(A)], open: "a", bodies: { a: { state: "loading" } } });
    act(() => {
      vi.advanceTimersByTime(BODY_STALL_MS - 100);
    });
    expect(said("a"), "the failure was declared before the deadline").toContain(BODY.loading);
    expect(within(letterOf("a")!).queryByRole("button", { name: BODY.kept.tryAgain })).toBeNull();
    expect(within(letterOf("a")!).queryByRole("alert")).toBeNull();
  });

  it("…and a sensitive message is treated like any other — a failed fetch shows the note", () => {
    mount({
      letters: [bare(msg("otp2", { subject: "Your code", sensitive: true }))],
      open: "otp2",
      bodies: { otp2: { state: "failed" } },
    });
    expect(said("otp2")).toContain(BODY.kept.failed);
  });

  it("the state line survives the CONVERSATION path, which composes the middle section itself", () => {
    mount({ letters: [A, bare(B), C], open: "b", bodies: { b: { state: "loading" } } });
    expect(articles()).toHaveLength(3);
    expect(said("b")).toContain(BODY.loading);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE SIBLINGS ARE THE MAIL, NOT ONE LINE OF IT
   ══════════════════════════════════════════════════════════════════════════════════════════

   Every letter renders through the SAME viewer the opened one uses, and a sibling whose text is not here says why,
   exactly as the opened letter does. */
describe("a conversation's siblings are loaded on open and rendered like mail", () => {
  const THREE = [bare(A), bare(B), bare(C)];
  const SIBLINGS = ["a", "c"];
  /** The letter's renderer, as every browser host hands it. */
  const REAL = { body: letterBody };

  it("a sibling panel renders through the SAME viewer the focused message uses", () => {
    const html =
      '<table width="600"><tr><td>' +
      "<p>Auch kann man Euch nicht erreichen, wenn die Durchwahl besetzt ist.</p>" +
      "</td></tr></table>";
    mount({ letters: THREE, open: "b", parts: REAL, bodies: rows(["a", "b", "c"], { state: "ready", text: "", html }) });
    for (const id of SIBLINGS) {
      const frames = letterOf(id)!.querySelectorAll("iframe");
      expect(frames, `sibling ${id} draws its letter in one frame`).toHaveLength(1);
      const f = frames[0]!;
      expect(f.getAttribute("srcdoc")).toContain("wenn die Durchwahl besetzt ist");
      expect(f.getAttribute("sandbox")).toContain("allow-same-origin");
      expect(f.getAttribute("sandbox")).not.toContain("allow-scripts");
      expect(f.getAttribute("srcdoc")).toContain("default-src 'none'");
    }
  });

  it("a sibling still WAITING says so, and its snippet is not offered as the message", () => {
    mount({ letters: THREE, open: "b", bodies: rows(["a", "b", "c"], { state: "loading" }) });
    for (const id of SIBLINGS) {
      expect(said(id)).toContain(BODY.loading);
      expect(within(letterOf(id)!).queryByRole("alert")).toBeNull();
    }
  });

  it("a sibling that FAILED says so differently and carries the way out", () => {
    const { mail } = mount({ letters: THREE, open: "b", bodies: rows(["a", "b", "c"], { state: "failed" }) });
    const note = within(letterOf("a")!).getByRole("alert");
    expect(note.textContent).toContain(BODY.kept.failed);
    expect(note.textContent).not.toContain(BODY.loading);
    const retry = within(letterOf("a")!).queryByRole("button", { name: BODY.kept.tryAgain });
    expect(retry, "a failed sibling with no control is a dead end").toBeTruthy();
    const before = mail.bodyAsks.length;
    fireEvent.click(retry!);
    expect(mail.bodyAsks.slice(before)).toContain("a retry");
  });

  /**
   * A WITHHELD SIBLING MUST SAY SO — the defect this holds shut was a SILENT one: a sibling whose body the server
   * never stored drew its snippet with no note at all, the preview presented as the message. Try again is asserted
   * ABSENT: withheld is an ANSWER, and a control that cannot change it is a dead end.
   */
  it("a WITHHELD sibling says its text was emptied to stay within the plan, and offers no Retry", () => {
    mount({ letters: THREE, open: "b", bodies: rows(["a", "b", "c"], { state: "ready", withheld: "storage_cap", text: "" }) });
    for (const id of SIBLINGS) {
      expect(said(id), `sibling ${id} at the cap must carry the note`).toContain(BODY.kept.emptiedLine);
      expect(said(id)).not.toContain(BODY.loading);
      expect(said(id)).not.toContain(BODY.kept.failed);
      expect(
        within(letterOf(id)!).queryByRole("button", { name: BODY.kept.tryAgain }),
        "withheld is answered, not failed — a Retry here cannot succeed",
      ).toBeNull();
    }
  });

  /* EACH WITHHELD MARKER GETS ITS OWN SENTENCE: one sentence for three different facts was the residual defect. */
  it("a JUNK-FILED body IN THE SPAM PILE names the verdict and the provider's Junk folder — not the storage cap", () => {
    const inSpam = (m: EngineMessage) => ({ ...m, folder: "ohmail/Quarantine" }) as EngineMessage;
    mount({
      letters: THREE.map(inSpam),
      open: "b",
      bodies: rows(["a", "b", "c"], { state: "ready", withheld: "junk_filed", text: "" }),
    });
    for (const id of SIBLINGS) {
      expect(said(id)).toContain(BODY.kept.junkLine);
      expect(said(id)).not.toContain(BODY.kept.emptiedLine);
    }
  });

  /**
   * MOVED OUT OF JUNK, THE VERDICT'S SENTENCE IS FALSE (owner defect, 2026-09-23): a `junk_filed` husk outside the
   * spam pile is text on its way back — loading — and past the bound the reader says it could not be read.
   */
  it("a JUNK-FILED husk moved OUT of the spam pile reads loading, then the bounded failure — never the verdict", () => {
    vi.useFakeTimers();
    mount({ letters: THREE, open: "b", bodies: rows(["a", "b", "c"], { state: "ready", withheld: "junk_filed", text: "" }) });
    expect(text()).toContain(BODY.withheldJunkLoading);
    expect(text()).not.toContain(BODY.kept.junkLine);
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(text()).not.toContain(BODY.withheldJunkLoading);
    expect(text()).toContain(BODY.kept.failed);
    expect(text()).not.toContain(BODY.kept.junkLine);
  });

  it("the husk shed by the refill's own change is asked for again, where it is being read", () => {
    const shed = new Set<string>();
    const { mail } = mount({
      letters: THREE,
      open: "b",
      bodies: rows(["a", "b", "c"], { state: "ready", withheld: "junk_filed", text: "" }),
    });
    const raw = mail.engine.read();
    const get = raw.get.bind(raw);
    (raw as { get: typeof raw.get }).get = <T,>(type: string, id: string) =>
      type === "message_body" && shed.has(id) ? undefined : get<T>(type, id);
    const before = mail.bodyAsks.length;
    // The mirror sheds a restorable husk on the message's next change: the body is waiting again.
    shed.add("b");
    act(() => mail.patch("b", {}));
    expect(mail.bodyAsks.slice(before).some((ask) => ask.startsWith("b"))).toBe(true);
  });

  it("an EXPUNGED body says the copies are gone — it does NOT promise the mail is safe in the mailbox", () => {
    mount({ letters: THREE, open: "b", bodies: rows(["a", "b", "c"], { state: "ready", withheld: "expunged", text: "" }) });
    for (const id of SIBLINGS) {
      expect(said(id)).toContain(BODY.kept.expungedLine);
      // The storage sentence's reassurance is FALSE here — that is why the marker exists.
      expect(said(id)).not.toContain("safe in your mailbox");
      expect(said(id)).not.toContain(BODY.kept.emptiedLine);
    }
  });

  /* A message over the download ceiling: its reader names the ceiling and where to read it. */
  it("a TOO-LARGE body names the download ceiling and the mail provider — no storage sentence, no Retry", () => {
    mount({ letters: THREE, open: "b", bodies: rows(["a", "b", "c"], { state: "ready", withheld: "too_large", text: "" }) });
    for (const id of SIBLINGS) {
      expect(said(id)).toContain(`than ${MAX_RAW_MESSAGE_BYTES / (1024 * 1024)} MB`);
      expect(said(id)).toContain(BODY.kept.tooLargeLine);
      expect(said(id)).not.toContain(BODY.kept.emptiedLine);
    }
    expect(screen.queryByRole("button", { name: BODY.kept.tryAgain })).toBeNull();
  });

  it("the storage-cap marker keeps the storage sentence: not kept on Cloud, complete on the mail server", () => {
    mount({
      letters: THREE,
      open: "b",
      bodies: rows(["a", "b", "c"], { state: "ready", withheld: "storage_cap", text: "" }),
      host: { wires: { liveBody: () => new Promise<never>(() => undefined) } as never },
    });
    for (const id of SIBLINGS) {
      expect(said(id)).toContain(BODY.kept.emptiedLine);
      expect(said(id)).toContain(BODY.kept.emptiedTitle);
    }
  });

  /* The refill runs only for mailboxes the worker still visits: one ohmail no longer reads is not. */
  it("a storage-cap letter of a mailbox ohmail no longer reads says its text does not come back", async () => {
    mount({
      letters: THREE,
      open: "b",
      bodies: rows(["a", "b", "c"], { state: "ready", withheld: "storage_cap", text: "" }),
      host: {
        wires: { liveBody: () => new Promise<never>(() => undefined) } as never,
        mailboxes: async () => [{ id: "mb-1", address: OWN, addressIsOwn: true, status: "disabled" }],
      },
    });
    await screen.findAllByText(BODY.kept.removedLine);
    for (const id of SIBLINGS) {
      expect(said(id)).toContain(BODY.kept.removedLine);
      expect(within(letterOf(id)!).queryByRole("button", { name: BODY.liveLoad })).toBeNull();
    }
  });

  it("a LIVE sensitive sibling renders its body like any other sibling", () => {
    const words = "Ich finde deine Idee mit dem Rollen-Guard gut";
    const otp = msg("otp", { ...conversation, subject: "Your code", date: "2026-07-29T09:00:00.000Z", snippet: words, body: words, sensitive: true });
    mount({ letters: [otp, B, C], open: "b" });
    expect(letterOf("otp")!.textContent).toContain("Rollen-Guard");
    expect(letterOf("otp")!.textContent).not.toContain("(redacted)");
  });

  it("a sensitive sibling renders its content, frame and all — like every other sibling", () => {
    const otp = bare(msg("otp", { ...conversation, subject: "Your code", date: "2026-07-29T09:00:00.000Z", snippet: "code is 449 201", sensitive: true }));
    const html = '<table width="600"><tr><td><p>Your verification code is 449 201</p></td></tr></table>';
    mount({ letters: [otp, B, C], open: "b", parts: REAL, bodies: { otp: { state: "ready", text: "", html } } });
    const article = letterOf("otp")!;
    expect(article.textContent).not.toContain("(redacted)");
    const frame = article.querySelector("iframe");
    expect(frame).toBeTruthy();
    expect(frame!.getAttribute("srcdoc") ?? "").toContain("449 201");
  });
});

describe("a sibling panel shows its message's files", () => {
  /**
   * ══ THE SENT-REPLY-IN-A-THREAD DEFECT, PINNED IN ITS EXACT SHAPE ═══════════════════════════
   *
   * Found on a live account: the reader's own sent reply, its two files extracted server-side, rendered inside the
   * open thread as a conversation SIBLING, and its letter drew header and body and nothing else. The guard: a SENT
   * sibling whose door holds a ready two-file list draws its files inside ITS OWN letter, through the same list read
   * the opened letter uses, and held by that letter.
   */
  const SENT_FILES = [file("att-1", "banner-v02x2.png", "image/png", 1_153_017), file("att-2", "banner-v02.png", "image/png", 317_030)];
  const MINE_WITH_FILES = { ...MINE, hasAttachments: true, attachmentCount: 2 } as EngineMessage;

  it("renders the attachment strip on a SENT sibling that carries files, not only on the focused panel", () => {
    const { door, held, asked } = fileDoor({ mine: SENT_FILES });
    mount({ letters: [A, MINE_WITH_FILES, C], open: "c", parts: { files: door } });
    const own = within(letterOf("mine")!);
    // Both files, by name, inside the sibling's own letter — never counted into some other letter.
    expect(own.getAllByRole("button", { name: /banner-v02x2\.png/ }).length).toBeGreaterThan(0);
    expect(own.getAllByRole("button", { name: /banner-v02\.png/ }).length).toBeGreaterThan(0);
    // The ask went through the SHARED door's read, addressed by this letter's id.
    expect(asked.some((a) => a.id === "mine")).toBe(true);
    // …and the sibling's letter HELD its own list: a strip over a list nobody asked for is silent.
    expect(held, "a letter drew its files without asking for its list").toContain("mine");
    expect(held, "the opened letter drew its files without asking for its list").toContain("c");
  });

  it("carries the focused pane's list discipline: every part, on every ask", () => {
    const { door, asked } = fileDoor({ mine: SENT_FILES });
    mount({ letters: [A, MINE_WITH_FILES, C], open: "c", parts: { files: door } });
    const asks = asked.filter((a) => a.id === "mine");
    expect(asks.length).toBeGreaterThan(0);
    expect(asks.every((a) => a.inline), "one narrow ask would hide an embedded photo's tile").toBe(true);
  });

  it("renders NO strip where the shell wires no attachments chrome — absent, not broken", () => {
    mount({ letters: [A, MINE_WITH_FILES, C], open: "c", parts: { files: "none" } });
    expect(within(letterOf("mine")!).queryAllByRole("button", { name: /banner/ })).toEqual([]);
  });

  it("a sibling with NOTHING to show renders no strip — ready-empty is silence, not a notice", () => {
    const { door } = fileDoor({ mine: SENT_FILES });
    mount({ letters: [A, MINE_WITH_FILES, C], open: "c", parts: { files: door } });
    // "a"'s list answered ready-with-nothing; its letter must not grow file controls for it.
    expect(within(letterOf("a")!).queryAllByRole("button", { name: /Download|Preview/ })).toEqual([]);
    expect(within(letterOf("a")!).queryByRole("status")).toBeNull();
  });
});

describe("a sibling tile's eye dispatches the preview for the SIBLING's message", () => {
  it("pressing the eye on a sibling's previewable file records the sibling id, not the focused one", () => {
    const { door } = fileDoor({ mine: [file("att-9", "look.png")] });
    const previewed: string[] = [];
    mount({
      letters: [A, MINE, C],
      open: "c",
      parts: { files: door, look: (m, a) => previewed.push(`${m}:${a}`) },
    });
    const eye = within(letterOf("mine")!).queryByRole("button", { name: /Preview look\.png/ });
    expect(eye, "the sibling's previewable tile did not render").toBeTruthy();
    fireEvent.click(eye!);
    expect(previewed).toContain("mine:att-9");
  });
});

describe("a landing not entered yet asks for no embedded picture", () => {
  it("previewing: no ask; entered: the focused panel and its siblings ask", async () => {
    /* The letter's renderer asks for the embedded pictures its text names, where it is handed the way to ask. */
    function AsksForItsPictures(props: LetterProps) {
      const ask = props.onCidImages;
      useEffect(() => {
        ask?.(["logo@x"]);
      }, [ask]);
      return createElement("p", null, props.text);
    }
    const { door, cids } = fileDoor({});
    const { meet } = mount({
      letters: [A, B, C],
      open: "c",
      parts: { files: door, body: AsksForItsPictures },
      meeting: ohboxMeeting("c", true),
    });
    expect(cids, "a preview asks for no picture").toEqual([]);
    await meet(ohboxMeeting("c", false));
    expect([...new Set(cids.map(([id]) => id))].sort()).toEqual(["a", "b", "c"]);
  });
});
