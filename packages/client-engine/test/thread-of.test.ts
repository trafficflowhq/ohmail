import type { EngineMessage, Folder } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { managedDomain } from "../../../test/support/fixture-credentials.js";
import { threadOf, type EntityReader } from "@ohmail/client-engine";

/**
 * `threadOf` — the conversation selector behind that change.
 *
 * The thread backfill populated `messages.thread_id` on live accounts and nothing read it.
 * The fixture world cannot exercise this: `fixtures-adapter.ts` writes `threadId: null` on
 * every demo row, so a mirror is built here by hand. The three things a reader depends on
 * and that a refactor could quietly break are ORDER, the empty-array contract, and the
 * absence of a folder filter.
 */

const msg = (
  id: string,
  over: Partial<EngineMessage> = {},
): EngineMessage => ({
  id,
  accountId: "acc",
  mailboxId: "mb",
  threadId: null,
  messageIdHeader: `<${id}@x.invalid>`,
  subject: id,
  from: { name: null, address: `${id}@x.invalid` },
  to: [],
  cc: [],
  date: "2026-08-01T09:00:00.000Z",
  folder: "INBOX" as Folder,
  snippet: id,
  unread: false,
  hasAttachments: false,
  attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null,
  labels: [],
  remoteContent: "none",
  updatedAt: "2026-08-01T09:00:00.000Z",
  ...over,
});

/** A minimal mirror over a message list — the only entity type this selector reads. */
function readerOf(messages: EngineMessage[]): EntityReader {
  return {
    get: <T,>(type: string, id: string) =>
      (type === "message" ? messages.find((m) => m.id === id) : undefined) as T | undefined,
    list: <T,>(type: string) => (type === "message" ? [...messages] : []) as T[],
    // `seq` is the record's last-applied one; this stub has never been through a drain, so 0 is
    // the honest answer and nothing this selector reads looks at it.
    entries: <T,>(type: string) => (type === "message"
      ? messages.map((m) => ({ id: m.id, entity: m, seq: 0 }))
      : []) as Array<{ id: string; entity: T; seq: number }>,
    version: () => 1,
    // A stub whose mail never changes: one constant for the mirror and one per type, which is
    // the same answer. `stampExcept` is the deny-list read the window keys its derivations on.
    stampOf: () => 1,
    stampExcept: () => 1,
  };
}

describe("threadOf", () => {
  it("returns the whole conversation OLDEST FIRST, whichever member is asked about", () => {
    // THE GUARD for reading order. Swap `byDateAsc` back to `byDateDesc` in `selectors.ts`
    // and both assertions go red — a conversation that reads newest-first is a different
    // document from the one the reader asked to scroll through.
    const r = readerOf([
      msg("c", { threadId: "t1", date: "2026-08-01T12:00:00.000Z" }),
      msg("a", { threadId: "t1", date: "2026-08-01T09:00:00.000Z" }),
      msg("b", { threadId: "t1", date: "2026-08-01T10:30:00.000Z" }),
      msg("other", { threadId: "t2", date: "2026-08-01T11:00:00.000Z" }),
    ]);
    expect(threadOf(r, "a").map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(threadOf(r, "c").map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("breaks a date tie on id, so a seeded chain still has ONE order", () => {
    const at = "2026-08-01T09:00:00.000Z";
    const r = readerOf([
      msg("z", { threadId: "t1", date: at }),
      msg("m", { threadId: "t1", date: at }),
    ]);
    expect(threadOf(r, "z").map((m) => m.id)).toEqual(["m", "z"]);
  });

  it("a message with no threadId has no conversation", () => {
    const r = readerOf([msg("solo"), msg("other")]);
    expect(threadOf(r, "solo")).toEqual([]);
  });

  it("the SOLE member of a thread has no conversation either — the reader must not show '1 message'", () => {
    // THE GUARD for the empty-array contract. Return `members` unconditionally and this
    // goes red; the UI would then render conversation chrome, a count of 1 and the
    // "your own replies are not here" note around a message with no conversation at all.
    const r = readerOf([msg("only", { threadId: "t9" }), msg("elsewhere", { threadId: "t8" })]);
    expect(threadOf(r, "only")).toEqual([]);
  });

  it("a held member is absent from the conversation a placed member opens, present when opened", () => {
    // A message stands in a conversation by its PLACE, never by a header another sender wrote:
    // a stranger's reply held at the gate, or quarantined, is no part of the panel a placed member
    // opens. MUTATION WATCHED: drop the held filter in `threadOf` and the first assertion reads
    // all five. Opened at a held message (the Screener's reader) it is the whole thread, its held
    // siblings included; key that on the opened id alone and the stranger's follow-up vanishes.
    const r = readerOf([
      msg("held", { threadId: "t1", folder: "ohmail/Screener" as Folder, date: "2026-08-01T08:00:00.000Z" }),
      msg("junk", { threadId: "t1", folder: "ohmail/Quarantine" as Folder, date: "2026-08-01T08:30:00.000Z" }),
      msg("accepted", { threadId: "t1", date: "2026-08-01T09:00:00.000Z" }),
      msg("later", { threadId: "t1", date: "2026-08-01T10:00:00.000Z" }),
      msg("held2", { threadId: "t1", folder: "ohmail/Screener" as Folder, date: "2026-08-01T11:00:00.000Z" }),
    ]);
    expect(threadOf(r, "accepted").map((m) => m.id)).toEqual(["accepted", "later"]);
    expect(threadOf(r, "held").map((m) => m.id)).toEqual(["held", "junk", "accepted", "later", "held2"]);
  });

  it("a conversation still spans folders — a pinned gate row is part of it", () => {
    // The person's own act places a held row: History pins a stranger's mail where it sits, and the
    // raw reader reads its physical folder. MUTATION WATCHED: drop the pin exception and the pinned
    // row vanishes from its siblings' panel.
    const pinned = {
      state: "resurfaced", bubbleUpAt: null, setAt: "2026-08-02T08:00:00.000Z", updatedAt: "2026-08-02T08:00:00.000Z",
    } as unknown as EngineMessage["triage"];
    const r = readerOf([
      msg("held", { threadId: "t1", folder: "ohmail/Screener" as Folder, date: "2026-08-01T08:00:00.000Z", triage: pinned }),
      msg("accepted", { threadId: "t1", date: "2026-08-01T09:00:00.000Z" }),
    ]);
    expect(threadOf(r, "accepted").map((m) => m.id)).toEqual(["held", "accepted"]);
  });

  it("the reader's own reply from a provider-named Sent folder is part of its conversation", () => {
    // The Sent-folder watch puts the user's own replies in the mirror under the SERVER'S folder
    // name — `Sent Items` on Exchange. A folder filter here (or a filter over any list of known
    // Sent spellings) would remove the user's own words from the conversation they wrote them in.
    const r = readerOf([
      msg("theirs", { threadId: "t2", date: "2026-08-11T08:00:00.000Z" }),
      msg("mine", { threadId: "t2", folder: "Sent Items" as Folder, date: "2026-08-11T08:14:00.000Z" }),
    ]);
    expect(threadOf(r, "theirs").map((m) => m.id)).toEqual(["theirs", "mine"]);
    expect(threadOf(r, "mine").map((m) => m.id)).toEqual(["theirs", "mine"]);
  });

  it("an unknown message id is not a crash", () => {
    expect(threadOf(readerOf([]), "nope")).toEqual([]);
  });

  /**
   * ═══ ONE LOGICAL MESSAGE IS ONE PANEL — the self-send twins ═══════════════════════════════
   *
   * A self-send puts the SAME message in the mirror twice: the optimistic Sent copy stands
   * beside the ingested row until the reconcile retires it (and for up to a drain after the
   * row lands), and a provider that re-renders its Sent filing can defeat the server-side
   * collapse outright — two REAL rows, one Message-ID. Both rendered as twin identical panels
   * in the reading pane, attachment tile on only one. The conversation is grouped here, so the
   * collapse lives here: members sharing a `messageIdKey` are one message, and exactly one
   * survives. The two spellings of one id — `<id@dom>` minted, `id@dom` ingested — MUST meet
   * through the normaliser; compare the raw strings and every assertion below goes red.
   *
   * BOTH twins are OUR OWN OUTBOUND, and every fixture below says so with the folder the row
   * really carries: the ingested copy comes from the Sent-folder watch, so its folder is the
   * mailbox's Sent path, and the optimistic one is `local`. A Message-ID may key identity only
   * on those rows (`@trafficflow/core/sender-headers`) — the refusals are the last two cases.
   */
  it("a self-send's optimistic copy is not a second panel beside the ingested row", () => {
    const r = readerOf([
      msg("parent", { threadId: "t1", date: "2026-08-11T08:00:00.000Z" }),
      // The ingested self-send copy — the Sent-folder watch delivers it, header bracket-stripped.
      msg("ingested", {
        threadId: "t1",
        messageIdHeader: `self-send-1@${managedDomain()}`,
        folder: "Sent Items" as Folder,
        date: "2026-08-11T08:10:00.000Z",
      }),
      // The optimistic twin — minted under the bracketed spelling, provisional by definition.
      msg("optimistic", {
        threadId: "t1",
        messageIdHeader: `<self-send-1@${managedDomain()}>`,
        local: true,
        folder: "Sent" as Folder,
        date: "2026-08-11T08:10:00.000Z",
      }),
    ]);
    expect(threadOf(r, "parent").map((m) => m.id)).toEqual(["parent", "ingested"]);
    expect(threadOf(r, "ingested").map((m) => m.id)).toEqual(["parent", "ingested"]);
  });

  it("when the twins ARE the whole thread, the collapse says 'no conversation' — one panel", () => {
    const r = readerOf([
      msg("ingested", {
        threadId: "t1",
        messageIdHeader: `ss2@${managedDomain()}`,
        folder: "Sent Items" as Folder,
        date: "2026-08-11T09:00:00.000Z",
      }),
      msg("optimistic", {
        threadId: "t1",
        messageIdHeader: `<ss2@${managedDomain()}>`,
        local: true,
        folder: "Sent" as Folder,
        date: "2026-08-11T09:00:00.000Z",
      }),
    ]);
    // The empty-array contract: a thread reduced to one logical message has no conversation,
    // so the pane renders the single open message and no twin.
    expect(threadOf(r, "ingested")).toEqual([]);
  });

  it("two INGESTED copies of one self-send (a re-rendering provider) collapse to one panel", () => {
    // Exchange files its own copy of the submission beside the one ohmail appended, so BOTH
    // copies sit under a Sent path — that is the shape this collapse exists for.
    const r = readerOf([
      msg("parent", { threadId: "t1", date: "2026-08-11T08:00:00.000Z" }),
      msg("appended", {
        threadId: "t1",
        messageIdHeader: `ss3@${managedDomain()}`,
        folder: "Sent" as Folder,
        date: "2026-08-11T08:10:00.000Z",
      }),
      msg("refiled", {
        threadId: "t1",
        messageIdHeader: `<ss3@${managedDomain()}>`,
        folder: "Sent Items" as Folder,
        date: "2026-08-11T08:10:00.000Z",
      }),
    ]);
    // Neither is provisional; the OPENED copy must never be hidden from its own pane, and a
    // reader that opened neither gets the deterministic first (date, then id).
    expect(threadOf(r, "parent").map((m) => m.id)).toEqual(["parent", "appended"]);
    expect(threadOf(r, "refiled").map((m) => m.id)).toEqual(["parent", "refiled"]);
  });

  /**
   * A Message-ID is chosen by whoever sent the mail. Reusing one the mailbox already holds used
   * to take the survivor's place in this pane: the real message was still stored, still
   * searchable, and not RENDERED — which for the reader is the message disappearing from the
   * conversation. An inbound row's header keys nothing.
   */
  it("a stranger reusing a held Message-ID does not displace the message — both panels stand", () => {
    const r = readerOf([
      msg("parent", { threadId: "t1", date: "2026-08-11T08:00:00.000Z" }),
      msg("real", {
        threadId: "t1",
        messageIdHeader: "shared@partner.example",
        from: { name: null, address: "counterpart@partner.example" },
        date: "2026-08-11T08:10:00.000Z",
      }),
      msg("forged", {
        threadId: "t1",
        messageIdHeader: "<shared@partner.example>",
        from: { name: null, address: "stranger@elsewhere.example" },
        date: "2026-08-11T08:05:00.000Z",
      }),
    ]);
    expect(threadOf(r, "parent").map((m) => m.id)).toEqual(["parent", "forged", "real"]);
  });

  it("…and an inbound copy never collapses against our own outbound one", () => {
    const r = readerOf([
      msg("parent", { threadId: "t1", date: "2026-08-11T08:00:00.000Z" }),
      msg("delivered", {
        threadId: "t1",
        messageIdHeader: `mine@${managedDomain()}`,
        date: "2026-08-11T08:10:00.000Z",
      }),
      msg("ours", {
        threadId: "t1",
        messageIdHeader: `<mine@${managedDomain()}>`,
        folder: "Sent" as Folder,
        date: "2026-08-11T08:11:00.000Z",
      }),
    ]);
    expect(threadOf(r, "parent").map((m) => m.id)).toEqual(["parent", "delivered", "ours"]);
  });

  it("rows with NO Message-ID never collapse — absence is not an identity", () => {
    const at = "2026-08-11T10:00:00.000Z";
    const r = readerOf([
      msg("a", { threadId: "t1", messageIdHeader: null, date: at }),
      msg("b", { threadId: "t1", messageIdHeader: null, date: at }),
    ]);
    expect(threadOf(r, "a").map((m) => m.id)).toEqual(["a", "b"]);
  });
});
