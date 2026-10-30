/**
 * HOW MANY MESSAGES A MAIL ROW STANDS FOR — where the number comes from, and which rows show one.
 *
 * Seven list rows drew `⤷ N` off `m.threadCount`, a DEMO-world field no real mail carries, so the
 * capsule existed in the showcase and in no mailbox. The engine's `threadSizeIndex` answers it now
 * — the server's own thread length where the thread row has synced — and `rowThreadOf` is the one
 * place the two sources meet. The census below reads every `<MessageRow` in the app against it.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  FOLDER_OF_VIEW, conversationSize, threadOf, threadSizeIndex,
  type EngineMessage, type EntityReader, type MessageStateDTO,
} from "@ohmail/client-engine";
import { rowThread, rowThreadOf } from "../app/shell/row-thread";

/** The fixture's ids, built from their numbers. */
const tid = (n: number): string => `T${n}`;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = path.join(HERE, "..", "app", "views");

/** The host's words, as `useRowBadgeCopy` hands them over (the catalogue's ICU plural, rendered). */
const say = (n: number): string => `${n} message${n === 1 ? "" : "s"} in this conversation`;

const catalogue = (loc: string): Record<string, Record<string, string>> =>
  JSON.parse(fs.readFileSync(path.join(HERE, "..", "messages", `${loc}.json`), "utf8"));

function mkMsg(p: Partial<EngineMessage> & { id: string }): EngineMessage {
  return {
    accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `s-${p.id}`, from: { name: "N", address: "n@example.invalid" },
    to: [], cc: [], date: "2026-08-01T09:00:00.000Z", arrivedAt: "2026-08-01T09:00:00.000Z",
    folder: "INBOX", snippet: "", unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-01T09:00:00.000Z",
    ...p,
  } as EngineMessage;
}

function readerOf(byType: Record<string, unknown[]>): EntityReader {
  return {
    list: <T,>(type: string) => (byType[type] ?? []) as T[],
    get: <T,>(type: string, id: string) =>
      (byType[type] ?? []).find((e) => (e as { id?: string }).id === id) as T | undefined,
    entries: <T,>(type: string) => (byType[type] ?? []).map((entity, i) => ({
      id: (entity as { id?: string }).id ?? String(i), entity: entity as T, seq: i,
    })),
    version: () => 1,
  } as unknown as EntityReader;
}

/** What `AppShell` hands the views, built the way it builds it. */
const countOf = (reader: EntityReader) => (threadId: string, held = false): number => {
  const size = threadSizeIndex(reader).get(threadId);
  return (held ? size?.whole : size?.count) ?? 0;
};

describe("the number a row shows", () => {
  /**
   * THE WORD ITSELF LIVES IN THE CATALOGUES, both of them, with a plural — `packages/ui` holds no
   * catalogue, so a row handed no sentence draws the capsule and says nothing, and this is where
   * the sentence has to be for the host to hand one.
   */
  it("has the count's sentence in both catalogues, pluralised", () => {
    for (const loc of ["en", "de"]) {
      const said = catalogue(loc).message?.rowThread;
      expect(said, `${loc}.json has no message.rowThread`).toBeDefined();
      expect(said).toContain("{count, plural,");
      expect(said).toContain("one {#");
      expect(said).toContain("other {#");
    }
  });

  /**
   * MUTATION WATCHED: drop the thread lookup in `threadSizeIndex` and this reads 3 — the size of
   * the window, on a row standing for nine.
   */
  it("says the thread's full count where the mirror holds only part of it and the thread row has synced", () => {
    const msgs = [
      mkMsg({ id: "m1", threadId: tid(1) }), mkMsg({ id: "m2", threadId: tid(1) }), mkMsg({ id: "m3", threadId: tid(1) }),
    ];
    const reader = readerOf({
      message: msgs,
      thread: [{ id: tid(1), messageIds: ["a", "b", "c", "m1", "m2", "m3", "d", "e", "f"] }],
    });
    expect(rowThreadOf(msgs[0]!, countOf(reader), say))
      .toEqual({ threadCount: 9, threadLabel: "9 messages in this conversation" });
  });

  /**
   * A HELD MEMBER: the Ohbox row opens the placed one alone and says nothing; the gate's row opens
   * the whole thread and says two. MUTATION WATCHED: drop the held flag in `rowThreadOf` and the
   * gate's row says nothing.
   */
  it("counts a held member on the gate's row and not on the Ohbox's", () => {
    const placed = mkMsg({ id: "p1", threadId: tid(1) });
    const held = mkMsg({ id: "h1", threadId: tid(1), folder: "ohmail/Screener" as EngineMessage["folder"] });
    const reader = readerOf({ message: [placed, held], thread: [{ id: tid(1), messageIds: ["p1", "h1"] }] });
    expect(rowThreadOf(placed, countOf(reader), say)).toEqual({});
    expect(rowThreadOf(held, countOf(reader), say))
      .toEqual({ threadCount: 2, threadLabel: "2 messages in this conversation" });
  });

  /**
   * A PINNED HELD ROW counts as placed, as the phone and the opened conversation do: q1 pinned in
   * Quarantine opens alone beside a held q2. MUTATION WATCHED: `isHeldFolder(m.folder)` alone in
   * `rowThreadOf` and the web row says 2 while the phone and the conversation say one.
   */
  it("counts a pinned held row the way the phone and the opened conversation do", () => {
    const Q = FOLDER_OF_VIEW.spam;
    const pin = (state: string): MessageStateDTO => ({
      messageId: "q1", state: state as MessageStateDTO["state"],
      bubbleUpAt: null, setAt: "2026-09-21T08:00:00.000Z", updatedAt: "2026-09-21T08:00:00.000Z",
    });
    for (const state of ["resurfaced", "bubbled_up"]) {
      const claim = pin(state);
      const q1 = mkMsg({ id: "q1", threadId: tid(1), folder: Q, triage: claim });
      const q2 = mkMsg({ id: "q2", threadId: tid(1), folder: Q, date: "2026-08-02T09:00:00.000Z" });
      const reader = readerOf({ message: [q1, q2], message_state: [claim], thread: [{ id: tid(1), messageIds: ["q1", "q2"] }] });
      const opened = threadOf(reader, "q1");
      const web = rowThreadOf(q1, countOf(reader), say).threadCount ?? 0;
      expect(opened, "the control: the conversation opens q1 alone").toEqual([]);
      expect(web, `the web row, ${state}`).toBe(conversationSize(reader, q1));
      expect(web).toBe(0);
    }
  });

  /** MUTATION WATCHED: `count > 1` → `count > 0` in `rowThread` and a lone message wears a "1". */
  it("gives a conversation of one no badge and no sentence", () => {
    const solo = mkMsg({ id: "m1", threadId: tid(1) });
    const reader = readerOf({ message: [solo] });
    expect(rowThreadOf(solo, countOf(reader), say)).toEqual({});
    expect(rowThread(1, say)).toEqual({});
    /* The demo world's own field is under the same rule. */
    expect(rowThreadOf({ threadId: null, threadCount: 1 }, undefined, say)).toEqual({});
  });

  /**
   * THE PRECEDENCE, STATED. `m.threadCount` is fixture-only; where the mirror knows the thread its
   * answer is the row's. MUTATION WATCHED: swap the two arms and the row reads the demo's 4.
   */
  it("prefers the mirror's count to the demo world's field, and keeps the field where there is no thread", () => {
    const m = { ...mkMsg({ id: "m1", threadId: tid(1) }), threadCount: 4 };
    const reader = readerOf({ message: [m, mkMsg({ id: "m2", threadId: tid(1) })] });
    expect(rowThreadOf(m, countOf(reader), say).threadCount).toBe(2);
    expect(rowThreadOf({ threadId: null, threadCount: 4 }, countOf(reader), say).threadCount).toBe(4);
  });
});

/* ── the census over every mail row in the app ───────────────────────────────────────────── */

/** Every `<MessageRow` in the views, with its `id` expression and whether it is handed a count. */
function rows(): { file: string; id: string; counted: boolean }[] {
  const out: { file: string; id: string; counted: boolean }[] = [];
  for (const name of fs.readdirSync(VIEWS).filter((f) => f.endsWith(".tsx")).sort()) {
    const text = fs.readFileSync(path.join(VIEWS, name), "utf8");
    const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const walk = (n: ts.Node): void => {
      const open = ts.isJsxElement(n) ? n.openingElement
        : ts.isJsxSelfClosingElement(n) ? n : null;
      if (open && open.tagName.getText(sf) === "MessageRow") {
        let id = "?";
        let counted = false;
        for (const a of open.attributes.properties) {
          if (ts.isJsxAttribute(a) && a.name.getText(sf) === "id" && a.initializer) {
            id = a.initializer.getText(sf).replace(/^\{|\}$/g, "");
          }
          if (ts.isJsxSpreadAttribute(a) && /^rowThread(Of)?\(/.test(a.expression.getText(sf))) counted = true;
        }
        out.push({ file: name, id, counted });
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }
  return out;
}

/**
 * ROWS THAT SHOW NO CONVERSATION COUNT, each with the reason. A list added later without the
 * count lands here as a red test rather than as a row that quietly says a conversation of nine
 * is one message.
 */
const UNCOUNTED: Record<string, { rows: number; why: string }> = {
  "ReadsView.tsx id=m.id": { rows: 1, why: "the read stream draws the conversation's faces and never its length — unchanged by this lane, and its gap row carries it" },
  "ReceiptsView.tsx id=m.id": { rows: 1, why: "a receipt stands for itself; this stream has never drawn the capsule" },
  "ScreenerView.tsx id=w.id": { rows: 2, why: "the Screener's rows are waiting SENDERS, not conversations" },
  "ScreenerView.tsx id=r.sender.id": { rows: 1, why: "a decided sender's card, one row per sender" },
  "ScreenerView.tsx id=sender.id": { rows: 2, why: "a decided sender's card, one row per sender; and the hidden primer's first sender of a segment, a sender too" },
  "ScreenerView.tsx id=junkKeyOf(i)": { rows: 1, why: "the junk window's rows are the server's own and carry no thread id" },
  "TrashView.tsx id=trashLiveKeyOf(i)": { rows: 1, why: "the server's own trash listing, whose rows carry no thread id" },
};

describe("every mail row in the app is asked where its count comes from", () => {
  it("finds the rows it exists to read", () => {
    /* A census that matched nothing would pass every assertion under it. */
    expect(rows().length).toBeGreaterThanOrEqual(14);
  });

  it("hands a count to every row that stands for a conversation, and names the rest", () => {
    const silent = rows().filter((r) => !r.counted).map((r) => `${r.file} id=${r.id}`).sort();
    /* Declared per ROW, not per key: two of the Screener's rows share an `id` expression, and a
       set would have swallowed one of them. */
    const excused = Object.entries(UNCOUNTED)
      .flatMap(([row, e]) => Array.from({ length: e.rows }, () => row)).sort();
    expect(silent).toEqual(excused);
    for (const [row, e] of Object.entries(UNCOUNTED)) {
      expect(e.why.length, `${row} is excused without a reason`).toBeGreaterThan(20);
    }
  });

  /**
   * THE OTHER HALF OF THE WIRE. A view that asks for the count and is never handed it draws
   * nothing and typechecks — the prop is optional, as every one of these is. MUTATION WATCHED:
   * drop `threadCountOf={threadCountOf}` from one view in `AppShell` and this names that view.
   */
  it("hands the index to every view that asks for it", () => {
    const asks = new Set(
      fs.readdirSync(VIEWS).filter((f) => f.endsWith(".tsx"))
        .filter((f) => fs.readFileSync(path.join(VIEWS, f), "utf8").includes("threadCountOf?:"))
        .map((f) => f.replace(/\.tsx$/, "")),
    );
    expect(asks.size).toBe(6);
    const shell = fs.readFileSync(path.join(HERE, "..", "app", "shell", "AppShell.tsx"), "utf8");
    const sf = ts.createSourceFile("AppShell.tsx", shell, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const given = new Set<string>();
    const walk = (n: ts.Node): void => {
      const open = ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : null;
      const tag = open?.tagName.getText(sf) ?? "";
      if (open && asks.has(tag)) {
        for (const a of open.attributes.properties) {
          if (ts.isJsxAttribute(a) && a.name.getText(sf) === "threadCountOf") given.add(tag);
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
    expect([...asks].filter((v) => !given.has(v))).toEqual([]);
  });

  it("takes every count from the one helper", () => {
    const counted = rows().filter((r) => r.counted);
    expect(counted.length).toBe(8);
    expect([...new Set(counted.map((r) => r.file))].sort())
      .toEqual(["FolderView.tsx", "HistoryView.tsx", "OhboxView.tsx", "TagView.tsx", "TrashView.tsx", "TriageView.tsx"]);
  });
});
