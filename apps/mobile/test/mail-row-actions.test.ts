import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bracketSpan, withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";
import { rowActionVerb, rowActions } from "../src/ui/row-actions";
import { moveTargetLabel } from "../src/state/live";
import { DECKS } from "../src/copy";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A MAIL ROW PUBLISHES ITS VERBS — Done · Later · Junk — AND EACH ONE PRESSES THE WORLD'S
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A swipe is invisible to VoiceOver and TalkBack, so the row's verbs have to be published as
 * actions on the row itself. The row carried two and no Junk, which has no gesture on either
 * side and was therefore reachable only by opening the message.
 *
 * The LIST is a pure module (`src/ui/row-actions.ts`) and is imported and driven here. The
 * DISPATCH is extracted from `MailRow.tsx` and RUN with the world injected — there is no React
 * Native renderer in this workspace (a pinned decision; see
 * `pairing-confirm-lands-in-the-mailbox.test.ts`, whose shape §2 follows), and a substring
 * census cannot tell which verb a name actually presses.
 *
 * ── MUTATIONS WATCHED (each restored, `cmp`-proven) ────────────────────────────────────────
 *
 *  · `rowActions` stops publishing Junk                  ⇒ §1 RED.
 *  · `rowActionVerb` trusts the name it is handed        ⇒ §1's unpublished-name case RED.
 *  · the row junks the list's row, not the projection    ⇒ §2's identity case RED.
 */

/* @reads: apps/mobile/src/ui/MailRow.tsx apps/mobile/app/trash/index.tsx apps/mobile/app/(tabs)/index.tsx apps/mobile/app/(tabs)/receipts.tsx apps/mobile/app/history.tsx apps/mobile/app/folder/[id].tsx
   The paths are built at runtime from `import.meta.url`, so no landing pass can select this file
   when one of them moves — the cli-lease-wiring shape (`reads-list.mjs`). */
const ROW_SRC = readFileSync(fileURLToPath(new URL("../src/ui/MailRow.tsx", import.meta.url)), "utf8");

const OFFERED = { face: "markRead", junkOffered: true } as const;
const NOT_OFFERED = { face: "markRead", junkOffered: false } as const;

describe("§1 the verbs the row publishes", () => {
  it("publishes the read slot, Later and Junk where the row admits spam", () => {
    expect(rowActions(OFFERED).map((a) => a.name)).toEqual(["readSlot", "later", "junk"]);
    expect(rowActions(OFFERED).map((a) => a.verb)).toEqual(["read", "later", "junk"]);
  });

  it("leaves Junk out where the message already presents there", () => {
    expect(rowActions(NOT_OFFERED).map((a) => a.name)).toEqual(["readSlot", "later"]);
    expect(rowActionVerb("junk", NOT_OFFERED), "a verb the row did not publish must not press")
      .toBeNull();
  });

  it("the read slot wears its three faces, and every label is a word the app ships", () => {
    const label = (f: "done" | "markRead" | "markUnread"): string =>
      rowActions({ face: f, junkOffered: true })[0].label;
    expect([label("done"), label("markRead"), label("markUnread")])
      .toEqual([DECKS.en.actionDone, DECKS.en.actionMarkRead, DECKS.en.actionMarkUnread]);
    expect(rowActions(OFFERED)[1].label).toBe(DECKS.en.actionLater);
    // Junk wears the move panel's own word for the destination, never a fourth spelling.
    expect(rowActions(OFFERED)[2].label).toBe(moveTargetLabel("spam"));
    for (const key of ["actionDone", "actionMarkRead", "actionMarkUnread", "actionLater", "placeSpam"] as const) {
      expect(DECKS.de[key], `${key} is missing from the German deck`).toBeTruthy();
    }
  });

  it("every published name maps back to exactly the verb it was published with", () => {
    for (const a of rowActions(OFFERED)) expect(rowActionVerb(a.name, OFFERED)).toBe(a.verb);
    expect(rowActionVerb("moveToMars", OFFERED)).toBeNull();
  });
});

type Call = [string, ...unknown[]];
type Ran = { calls: Call[]; asked: string[] };

/**
 * THE ROW'S DISPATCH, RUN. `new Function` over the component's own bytes with the three names it
 * closes over supplied, so a handler that stops doing what the list says cannot pass this.
 */
function pressOf(src: string): (verb: string, opts?: { face?: string; projected?: unknown }) => Ran {
  const blank = withoutCommentsAndLiterals(src);
  const at = blank.indexOf("const press = (verb");
  if (at === -1) throw new Error("no `const press = (verb` in MailRow.tsx");
  const body = bracketSpan(blank, blank.indexOf("{", blank.indexOf("=>", at)), "{", "}");
  if (!body.closed) throw new Error("the press handler never closed");
  const text = src.slice(body.start, body.end);
  return (verb, opts = {}) => {
    const ran: Ran = { calls: [], asked: [] };
    const projected = "projected" in opts ? opts.projected : { id: "m1", presentedFolder: "INBOX" };
    const w = {
      message: (id: string) => {
        ran.asked.push(id);
        return projected;
      },
      actions: {
        pileToggle: (id: string, kind: string) => void ran.calls.push(["pileToggle", id, kind]),
        resurfaceDone: (id: string) => void ran.calls.push(["resurfaceDone", id]),
        markRowSeen: (id: string, unread: boolean) => void ran.calls.push(["markRowSeen", id, unread]),
        move: (row: unknown, dest: string) => void ran.calls.push(["move", row, dest]),
      },
    };
    const make = new Function("w", "m", "face", `"use strict"; return ((verb) => {${text}});`) as (
      a: typeof w, b: unknown, c: string,
    ) => (v: string) => void;
    make(w, { id: "m1" }, opts.face ?? "markRead")(verb);
    return ran;
  };
}

describe("§2 each verb presses the world's own act", () => {
  const press = pressOf(ROW_SRC);

  it("Later toggles the pile, and asks the world for nothing else", () => {
    const ran = press("later");
    expect(ran.calls).toEqual([["pileToggle", "m1", "replyLater"]]);
    expect(ran.asked, "Later resolved a projection it does not need").toEqual([]);
  });

  it("the read slot presses Done on a resurfaced row and the read switch otherwise", () => {
    expect(press("read", { face: "done" }).calls).toEqual([["resurfaceDone", "m1"]]);
    // The row's own read names the row, so the engine files it at the top of Earlier (2026-10-21).
    expect(press("read", { face: "markRead" }).calls).toEqual([["markRowSeen", "m1", false]]);
    expect(press("read", { face: "markUnread" }).calls).toEqual([["markRowSeen", "m1", true]]);
  });

  it("Junk moves the PROJECTED row to spam — the row the world hands back, not the list's", () => {
    const projected = { id: "m1", presentedFolder: "INBOX", mine: true };
    const ran = press("junk", { projected });
    expect(ran.asked, "the row was junked without resolving it").toEqual(["m1"]);
    expect(ran.calls).toHaveLength(1);
    expect(ran.calls[0][0]).toBe("move");
    expect(ran.calls[0][1], "the move was handed the list's row, not the projection").toBe(projected);
    expect(ran.calls[0][2]).toBe("spam");
  });

  it("a row the mirror no longer holds dispatches nothing at all", () => {
    const ran = press("junk", { projected: undefined });
    expect(ran.asked).toEqual(["m1"]);
    expect(ran.calls, "a move was dispatched for a row that is gone").toEqual([]);
  });
});

describe("§3 the row wires the one list, and grows no undo of its own", () => {
  const code = withoutCommentsAndLiterals(ROW_SRC);

  it("the actions and the dispatch both come from `row-actions.ts`", () => {
    expect(code).toContain("accessibilityActions: rowActions(facts).map(({ name, label }) => ({ name, label }))");
    expect(code).toContain("const verb = rowActionVerb(e.nativeEvent.actionName, facts);");
    expect(code, "a hand-written action list is a second rule").not.toMatch(/name: "readSlot", label:/);
  });

  it("Junk is admitted by the reader's own rule, and an unanswered fact is not a yes", () => {
    /* The RAW source for this one: the scanner blanks string literals, so the destination is
       only readable where it is written. */
    expect(ROW_SRC).toContain("moveTargetsFor({ presentedFolder: m.presentedFolder }).includes(\"spam\")");
    expect(code).toContain("m.presentedFolder !== undefined");
  });

  it("both doors press the same handler, and nothing here reverses anything", () => {
    /* The gesture's release and the actions menu spell the same line, so the reading is the
       COUNT: one of them alone would leave a door dispatching for itself. */
    expect(code.split("if (verb !== null) press(verb);").length - 1,
      "the gesture and the actions menu do not both press the one handler").toBe(2);
    expect(/setTimeout|UNDO_MS|inverseMutations/.test(code),
      "the row must not grow an undo of its own — the verb's toast already carries one").toBe(false);
  });

  it("the verbs are off exactly where the list offers none, and on every list that does", () => {
    const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    /* Trash: a deleted row has no Done, no Later and no Junk, so it publishes none of them —
       read as the ABSENCE of the prop, not as one spelling of the element. The row moved into
       `MailList`'s `renderRow` and its key into `rowKey` (the phone list's virtualization), and
       a pinned literal called that a lost claim; what is claimed is that Trash's row carries no
       `swipe`, and the four lists below carry it. The element is still asserted present, so a
       screen that stopped rendering rows at all cannot pass by having no `swipe` either. */
    const trash = read("../app/trash/index.tsx");
    expect(trash, "the trash screen renders a MailRow").toContain("<MailRow ");
    /* The element's own text, taken to its `/>`. NOT a `[^>]*` character class: `onPress={() =>
       …}` carries a `>`, so that class stops inside the prop and reads a `swipe` after it as
       absent — the mutation that adds one passed under exactly that regex before this line. */
    const rowProps = (src: string): string[] =>
      src.split("<MailRow ").slice(1).map((rest) => rest.slice(0, rest.indexOf("/>")));
    expect(
      rowProps(trash).filter((props) => /\bswipe\b/.test(props)),
      "a deleted row must publish no verbs — no `swipe` on the trash screen's MailRow",
    ).toEqual([]);
    for (const screen of ["../app/(tabs)/index.tsx", "../app/(tabs)/receipts.tsx", "../app/history.tsx", "../app/folder/[id].tsx"]) {
      expect(read(screen), `${screen} renders mail rows without the verbs`).toContain("swipe />");
    }
  });
});

describe("§4 the reading is not vacuous", () => {
  it("the extractor read a real handler out of the real row", () => {
    expect(ROW_SRC.length, "the row is empty").toBeGreaterThan(2000);
    const press = pressOf(ROW_SRC);
    expect(press("later").calls.length, "the extracted handler dispatched nothing").toBe(1);
  });

  it("a handler that lost its Junk arm is refused by §2", () => {
    const OLD = ROW_SRC.replace(
      '    if (verb === "junk") {\n      const row = w.message(m.id);\n      if (row) w.actions.move(row, "spam", members);\n      return;\n    }\n',
      "",
    );
    expect(OLD, "the fixture did not take — §4 would then measure the fixed file").not.toBe(ROW_SRC);
    const ran = pressOf(OLD)("junk");
    expect(ran.calls, "a Junk press fell through to the read switch").not.toContainEqual(["move", expect.anything(), "spam"]);
  });
});
