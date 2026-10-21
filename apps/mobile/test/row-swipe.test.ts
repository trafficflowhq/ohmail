/**
 * ═══ SWIPE VERBS ON A MAIL ROW ══════════════════════════════════════════════
 *
 * One-hand triage: the sheet is two taps and a thumb has one. What is measured here is the
 * arithmetic that decides — claim, fire, offset, and which of the read slot's three faces the
 * row is wearing — plus the two rules that keep a shortcut from becoming a trap:
 *
 *  · A SWIPE IS NEVER THE ONLY DOOR. Every verb it carries is on the row's own sheet and is
 *    published as an accessibility action on the row, because a gesture is invisible to a screen
 *    reader. Measured on the rendered source, not on a comment: the row declares both actions and
 *    routes them to the same two presses the gesture does.
 *  · NO SECOND UNDO. The presses are `pileToggle` and the read slot's own arms, whose toasts
 *    already carry the engine's inverse (`verb-undo-live.test.ts` drives that on a real wire), so
 *    nothing about undo is re-implemented on the row. A second undo mechanism is a second
 *    contract, and the two would drift.
 *  · NO NEW DEPENDENCY. `react-native-gesture-handler` does not resolve from this app and is a
 *    NATIVE module; `PanResponder` is React Native's own and behaves the same on both platforms,
 *    which is the parity rule this app is held to. Asserted against the manifest.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  readFaceOf, swipeClaims, swipeOffset, swipeVerbFor,
  SWIPE_CLAIM_DX, SWIPE_FIRE_DX, SWIPE_MAX_DX,
} from "../src/ui/row-swipe";
import { DECKS } from "../src/copy";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("the list keeps the scroll until the row has earned it", () => {
  it("claims nothing short of the threshold, however clean the direction", () => {
    expect(swipeClaims(SWIPE_CLAIM_DX - 1, 0)).toBe(false);
    expect(swipeClaims(SWIPE_CLAIM_DX, 0)).toBe(true);
    expect(swipeClaims(-SWIPE_CLAIM_DX, 0), "both directions, one rule").toBe(true);
  });

  it("refuses a diagonal — a scroll that wandered is a scroll", () => {
    // 40 across and 30 down: past the distance, not past the ratio.
    expect(swipeClaims(40, 30)).toBe(false);
    expect(swipeClaims(40, 10)).toBe(true);
    expect(swipeClaims(0, 60), "a straight scroll never reaches a row").toBe(false);
  });
});

describe("what a release does", () => {
  it("fires nothing short of the firing point — a half swipe is a mind changed", () => {
    expect(swipeVerbFor(SWIPE_FIRE_DX - 1)).toBeNull();
    expect(swipeVerbFor(-(SWIPE_FIRE_DX - 1))).toBeNull();
    expect(swipeVerbFor(0)).toBeNull();
  });

  it("leading is the read slot and trailing is Later — the compact bar's own order", () => {
    expect(swipeVerbFor(SWIPE_FIRE_DX)).toBe("read");
    expect(swipeVerbFor(-SWIPE_FIRE_DX)).toBe("later");
    expect(swipeVerbFor(300)).toBe("read");
    expect(swipeVerbFor(-300)).toBe("later");
  });
});

describe("how far the row is drawn", () => {
  it("follows the finger to the firing point, then resists", () => {
    expect(swipeOffset(40)).toBe(40);
    expect(swipeOffset(SWIPE_FIRE_DX)).toBe(SWIPE_FIRE_DX);
    const over = swipeOffset(SWIPE_MAX_DX);
    expect(over).toBeGreaterThan(SWIPE_FIRE_DX);
    expect(over, "a row that follows a finger off screen reads as a delete about to happen")
      .toBeLessThan(SWIPE_MAX_DX);
  });

  it("is bounded however far the finger goes, and symmetric", () => {
    expect(swipeOffset(4000)).toBe(swipeOffset(SWIPE_MAX_DX));
    expect(swipeOffset(-4000)).toBe(-swipeOffset(SWIPE_MAX_DX));
  });
});

describe("the read slot's three faces — the reader's own rule, in one place", () => {
  it("is Done on a resurfaced row whatever its read state", () => {
    expect(readFaceOf({ pile: "resurfaced", unread: true })).toBe("done");
    expect(readFaceOf({ pile: "resurfaced", unread: false })).toBe("done");
  });

  it("is Mark as read on an unread row and Mark unread on a read one", () => {
    expect(readFaceOf({ pile: null, unread: true })).toBe("markRead");
    expect(readFaceOf({ pile: "reply_later", unread: false })).toBe("markUnread");
  });

  it("wears the sheet's own three words, in both catalogues", () => {
    for (const key of ["actionDone", "actionMarkRead", "actionMarkUnread", "actionLater"] as const) {
      expect(DECKS.en[key], `${key} is missing`).toBeTruthy();
      expect(DECKS.de[key], `${key} is missing from the German deck`).toBeTruthy();
    }
  });
});

describe("a swipe is a shortcut, never the only door", () => {
  const row = read("../src/ui/MailRow.tsx");

  it("publishes the row's verbs as accessibility actions on the row itself", () => {
    // The list and the dispatch are ONE rule, in `row-actions.ts`, which
    // `mail-row-actions.test.ts` drives — including the Junk the gesture has no side for.
    expect(row).toContain("accessibilityActions: rowActions(facts)");
    expect(row).toContain("onAccessibilityAction:");
    expect(row).toContain("rowActionVerb(e.nativeEvent.actionName, facts)");
  });

  it("routes the action and the gesture to the SAME press", () => {
    // Both doors call `press`, which is the one place a verb is dispatched from — the count,
    // because the two doors spell the line identically and one alone would prove nothing.
    expect(row.split("if (verb !== null) press(verb);").length - 1,
      "the gesture and the actions menu do not both press the one handler").toBe(2);
    expect(row).toContain("const verb = swipeVerbFor(dxNow.current);");
  });

  it("dispatches the world's own verbs, so the undo pill is the verb's own", () => {
    expect(row).toContain('w.actions.pileToggle(m.id, "replyLater", members)');
    expect(row).toContain("w.actions.resurfaceDone(m.id, members)");
    expect(row).toContain('w.actions.markRowSeen(m.id, face === "markUnread", members)');
    // No second undo: nothing on this row schedules, holds or reverses anything itself.
    expect(/setTimeout|UNDO_MS|inverseMutations/.test(row),
      "the row must not grow an undo of its own — the verb's toast already carries one").toBe(false);
  });

  it("is OFF where the verbs do not apply, and on every mail list where they do", () => {
    // Trash: a deleted row has no Done and no Later, so it takes no gesture.
    expect(read("../app/trash/index.tsx")).toContain("<MailRow m={r.mail} onPress={() => openRow(r.mail.id)} />");
    for (const screen of ["../app/(tabs)/index.tsx", "../app/(tabs)/receipts.tsx", "../app/history.tsx", "../app/folder/[id].tsx"]) {
      expect(read(screen), `${screen} renders mail rows without the shortcut`).toContain("swipe />");
    }
  });
});

describe("no new dependency", () => {
  it("is built on React Native's own PanResponder, not a native gesture module", () => {
    const row = read("../src/ui/MailRow.tsx");
    expect(row).toContain('import { Animated, PanResponder, View } from "react-native";');
    expect(row.includes("react-native-gesture-handler"),
      "a native module means a prebuild and a pod install on both platforms for one gesture")
      .toBe(false);
    const manifest = JSON.parse(read("../package.json")) as { dependencies: Record<string, string> };
    expect(Object.keys(manifest.dependencies)).not.toContain("react-native-gesture-handler");
  });
});
