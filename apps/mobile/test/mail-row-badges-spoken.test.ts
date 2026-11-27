/**
 * WHAT A MAIL ROW SAYS OUT LOUD ON THE PHONE — and that it says everything it draws.
 *
 * The row spoke sender, subject, stamp and read state; the conversation's count, the protected
 * capsule, the history place, the blocked tracker, the amount and the new-since chip were drawn
 * in silence. There is no React Native renderer in this workspace (`react-test-renderer` and
 * `@testing-library/react-native` are not dependencies), so the rendered label is reached the way
 * this suite reaches every other component fact: the sentence is measured by calling the
 * assembler, and the ROW is measured by parsing it — the label attribute must BE that call, and
 * every badge the strip renders must be guarded by a field the assembler reads.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { Mail } from "../src/state/model";
import { PHONE_ROW_BADGE_ORDER, mailRowSpoken, rowBadgeFacts, threadOfRow } from "../src/ui/row-spoken";
import { ROW_SPOKEN_ORDER } from "../../../packages/ui/src/composites/row-spoken";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => fs.readFileSync(path.join(HERE, "..", rel), "utf8");
const parse = (rel: string): ts.SourceFile =>
  ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true,
    rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

const ROW = "src/ui/MailRow.tsx";
const SPOKEN = "src/ui/row-spoken.ts";

/* ── the fixtures ────────────────────────────────────────────────────────────────────────── */

const BARE: Mail = {
  id: "m1",
  place: "ohbox",
  from: { name: "Ada Lovelace", address: "ada@example.test" },
  subject: "The engine",
  time: "09:12",
  body: "Hello",
  unread: true,
  earlier: [],
};

const earlier = (n: number): Mail["earlier"] =>
  Array.from({ length: n }, (_, i) => ({
    id: `e${i}`, subject: "Re: The engine", time: `08:0${i}`, body: "x", seen: true,
  }));

/** Every badge at once — a row that wears all of them is the only one that can order them. */
const ALL: Mail = {
  ...BARE,
  earlier: earlier(3),
  protected: { kind: "code", label: "Verification code", redactedNote: "hidden", policy: "kept" },
  newSince: 2,
  trackerNote: "1 spy pixel blocked (open-tracker)",
  historyPlace: "Archive",
  amount: "EUR 12.40",
  tags: [{ id: "t1", name: "Invoices", hue: "denim" }, { id: "t2", name: "Kiln", hue: "moss" }],
};

/** A read row wearing nothing, and the one that wears only the new-since chip. */
const NONE: Mail = { ...BARE, unread: false };
const NEW_SINCE_ONLY: Mail = { ...BARE, newSince: 2 };

/**
 * A LIST ROW STANDING FOR A CONVERSATION OF THREE — `earlier` is empty, because only the reading
 * view fills it, and the count rides on the projection instead (`state/live.ts#toMail`).
 */
const LIST_THREAD: Mail = { ...BARE, threadCount: 3 };

const SAID_ALL =
  "Ada Lovelace. The engine. 09:12. Unread. 4 messages in this conversation. Protected."
  + " 2 messages since this came back. 1 spy pixel blocked. Archive. EUR 12.40. Invoices. Kiln.";
const SAID_NONE = "Ada Lovelace. The engine. 09:12.";
const SAID_NEW_SINCE = "Ada Lovelace. The engine. 09:12. Unread. 2 messages since this came back.";
const SAID_LIST_THREAD = "Ada Lovelace. The engine. 09:12. Unread. 3 messages in this conversation.";

/* ── the parser ──────────────────────────────────────────────────────────────────────────── */

/** The fields a condition reads off the row — `m.x`, and the count the row derives once. */
function factSources(node: ts.Node): string[] {
  const out = new Set<string>();
  const walk = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "m") {
      out.add(`m.${n.name.text}`);
    } else if (ts.isIdentifier(n) && n.text === "thread") out.add("thread");
    ts.forEachChild(n, walk);
  };
  walk(node);
  return [...out].sort();
}

/** Does this subtree RENDER a Badge or a TagChip — the call, never the identifier standing somewhere. */
function rendersBadge(node: ts.Node): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    const tag = ts.isJsxElement(n)
      ? n.openingElement.tagName.getText()
      : ts.isJsxSelfClosingElement(n) ? n.tagName.getText() : null;
    if (tag === "Badge" || tag === "TagChip") found = true;
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

/** Every `<cond> ? <Badge …> : null` in the row, with the fields its condition reads. */
function badgeGuards(): { text: string; fields: string[] }[] {
  const sf = parse(ROW);
  const out: { text: string; fields: string[] }[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isConditionalExpression(n) && rendersBadge(n.whenTrue)) {
      out.push({ text: n.condition.getText(sf), fields: factSources(n.condition) });
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

/** The strip's own visibility condition — `const badges = …`. */
function stripGuard(): { text: string; fields: string[] } {
  const sf = parse(ROW);
  let found: ts.Expression | undefined;
  const walk = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "badges"
      && n.initializer) found = n.initializer;
    ts.forEachChild(n, walk);
  };
  walk(sf);
  if (!found) throw new Error("MailRow.tsx no longer declares `badges` — this census reads it");
  return { text: found.getText(sf), fields: factSources(found) };
}

/** The fields `rowBadgeFacts` decides on, read from its own `if` conditions. */
function assemblerFields(): string[] {
  const sf = parse(SPOKEN);
  const out = new Set<string>();
  let seen = 0;
  const walk = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === "rowBadgeFacts" && n.body) {
      const inner = (x: ts.Node): void => {
        if (ts.isIfStatement(x)) {
          seen += 1;
          for (const f of factSources(x.expression)) out.add(f);
        }
        ts.forEachChild(x, inner);
      };
      ts.forEachChild(n.body, inner);
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  if (seen === 0) throw new Error("rowBadgeFacts has no conditions — this census read nothing");
  return [...out].sort();
}

/* ── what the row says ───────────────────────────────────────────────────────────────────── */

describe("the phone's row speaks every badge it wears", () => {
  it("says all of them, in the web row's order", () => {
    expect(mailRowSpoken(ALL)).toBe(SAID_ALL);
  });

  it("says its name and stamp alone where the row wears nothing", () => {
    expect(mailRowSpoken(NONE)).toBe(SAID_NONE);
    expect(rowBadgeFacts(NONE)).toEqual([]);
  });

  it("says the new-since SENTENCE, never the chip's two words", () => {
    expect(mailRowSpoken(NEW_SINCE_ONLY)).toBe(SAID_NEW_SINCE);
    expect(mailRowSpoken(NEW_SINCE_ONLY)).not.toContain("2 new.");
  });

  /**
   * THE LIST ROW'S COUNT. `toMail` sets `earlier: []` on every row of every list, so this used to
   * be 0 everywhere and a conversation of three read and drew as a single message
   * (PHONE-ROW-HAS-NO-CONVERSATION-COUNT-IN-ANY-LIST). The projection carries it now.
   */
  it("says how long a conversation is on a LIST row, which holds no `earlier`", () => {
    expect(threadOfRow(LIST_THREAD)).toBe(3);
    expect(mailRowSpoken(LIST_THREAD)).toBe(SAID_LIST_THREAD);
    expect(rowBadgeFacts(LIST_THREAD).map((f) => f.kind)).toEqual(["thread"]);
    /* A row standing for one message says nothing about a conversation, and draws no chip. */
    expect(threadOfRow(BARE)).toBe(0);
    expect(rowBadgeFacts(BARE)).toEqual([]);
  });

  it("orders the facts by the shared list whatever order they were collected in", () => {
    const said = mailRowSpoken(ALL);
    const places = rowBadgeFacts(ALL).map((f) => said.indexOf(f.text));
    expect(places.every((p) => p >= 0)).toBe(true);
    expect([...places].sort((a, b) => a - b)).toEqual(places);
    expect(rowBadgeFacts(ALL).map((f) => f.kind))
      .toEqual(["thread", "protected", "newSince", "tracker", "place", "amount", "tag", "tag"]);
  });
});

/* ── what the row draws ──────────────────────────────────────────────────────────────────── */

describe("the census over the badges the row renders", () => {
  it("finds the strip it exists to read", () => {
    /* A census that matched nothing would pass every assertion below it. */
    expect(badgeGuards().length).toBeGreaterThanOrEqual(5);
    expect(assemblerFields().length).toBeGreaterThanOrEqual(5);
  });

  it("gives every badge the row renders a fact the assembler reads", () => {
    const known = new Set(assemblerFields());
    const silent = badgeGuards()
      .filter((g) => g.fields.length > 0 && !g.fields.every((f) => known.has(f)))
      .map((g) => `${g.text} (drawn, never spoken)`);
    expect(silent).toEqual([]);
  });

  it("names every one of them in the strip's own visibility condition", () => {
    /* DISCOVERY OF THIS LANE: `newSince` was missing here, so a Resurfaced row wearing only that
       chip drew no strip at all and the Resurfaced consolidation's badge reached nobody. */
    const strip = new Set(stripGuard().fields);
    const hidden = badgeGuards()
      .filter((g) => g.fields.length > 0 && !g.fields.some((f) => strip.has(f)))
      .map((g) => `${g.text} (inside a strip that never draws for it)`);
    expect(hidden).toEqual([]);
  });

  it("draws the strip for a row carrying nothing but the new-since chip", () => {
    const guard = stripGuard();
    const free = [...new Set(guard.fields.map((f) => (f === "thread" ? "thread" : "m")))];
    /* Fail closed: the condition is EVALUATED, so a condition reading anything but the row and
       its derived count is refused rather than guessed at. */
    expect(free.every((f) => f === "m" || f === "thread"), guard.text).toBe(true);
    const draws = new Function("m", "thread", `return !!(${guard.text});`) as
      (m: Mail, thread: number) => boolean;
    expect(draws(NEW_SINCE_ONLY, 0), "a new-since row draws no strip").toBe(true);
    expect(draws(ALL, 4)).toBe(true);
    expect(draws(NONE, 0)).toBe(false);
    /* A LIST row whose only badge is the conversation's count — the case that was unreachable
       while every list row's count was 0. */
    expect(draws(LIST_THREAD, threadOfRow(LIST_THREAD)), "a list row draws its count").toBe(true);
  });

  it("speaks through the assembler and nothing else", () => {
    const sf = parse(ROW);
    let call: ts.CallExpression | undefined;
    const walk = (n: ts.Node): void => {
      if (ts.isJsxAttribute(n) && n.name.getText() === "accessibilityLabel"
        && n.initializer && ts.isJsxExpression(n.initializer) && n.initializer.expression
        && ts.isCallExpression(n.initializer.expression)) call = n.initializer.expression;
      ts.forEachChild(n, walk);
    };
    walk(sf);
    expect(call, "the row's accessibilityLabel is not a call").toBeDefined();
    expect(call?.expression.getText(sf)).toBe("mailRowSpoken");
    // The Paper Ohbox row passes its full group byline. All badge facts still come from the row.
    expect(call?.arguments.map((a) => a.getText(sf))).toEqual(["m", "byline?.spokenName"]);
  });
});

/* ── the two surfaces ────────────────────────────────────────────────────────────────────── */

/**
 * KINDS THE WEB ROW SPEAKS AND THIS ONE DOES NOT — each because the phone's row does not DRAW it.
 * The difference is computed below, so a badge added to one surface and not the other lands here
 * as a red test rather than as a silent divergence.
 */
const WEB_ONLY: Record<string, string> = {
  attachment: "the phone's row draws no clip",
  held: "a held count is the Screener's own row here, not a mail row's badge",
  stateNote: "the phone's row draws no triage state chip",
  aiReason: "the suggestion and the fact behind it live on the Screener's card here",
  mailbox: "the phone's row draws no delivered-to badge",
  destination: "the phone has no restore gloss on a row",
  detection: "the phone's row draws no spam detection badge",
};

describe("the phone speaks what the web speaks, in the same order", () => {
  const PHONE = ["arrived", "readState", ...PHONE_ROW_BADGE_ORDER];

  it("keeps the phone's order a subsequence of the web's", () => {
    let at = -1;
    const wrong: string[] = [];
    for (const kind of PHONE) {
      const next = ROW_SPOKEN_ORDER.indexOf(kind as never);
      if (next <= at) wrong.push(kind);
      at = next;
    }
    expect(wrong).toEqual([]);
  });

  it("records every kind one surface has and the other does not", () => {
    const missing = ROW_SPOKEN_ORDER.filter((k) => !PHONE.includes(k));
    expect(missing.slice().sort()).toEqual(Object.keys(WEB_ONLY).sort());
    for (const [kind, why] of Object.entries(WEB_ONLY)) {
      expect(why.length, `${kind} is excused without a reason`).toBeGreaterThan(20);
    }
    /* The other direction: this row wears no badge the web has no place for. */
    expect(PHONE.filter((k) => !ROW_SPOKEN_ORDER.includes(k as never))).toEqual([]);
  });
});
