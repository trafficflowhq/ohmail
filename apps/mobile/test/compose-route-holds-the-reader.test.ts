/**
 * ═══ A FOLD OR AN UNFOLD NEVER TAKES THE WORDS IN NEW MAIL (review H1) ════════════════════════════
 *
 * The reader's move between the pushed route and the pane waited for the reader's own sheets only.
 * With the New mail ROUTE open (the rail's pen, a mailto in a body), an unfold REPLACED the focused
 * route, which was the composer, and a fold pushed the reader over it: either way it unmounted with
 * no close and the typed words went. Every composer now holds the move while it is open, and one
 * unmounted without a close keeps what a close would have kept.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { unmountKeep } from "../src/ui/compose-keep";
import { holdReader, holdWhileOpen, readerHeldNow, readerMoveDue, subscribeReaderHeld } from "../src/ui/reader-held";

const src = (rel: string) => withoutComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
const actions = src("../src/ui/MessageActions.tsx");
const sheet = actions.slice(actions.indexOf("export function ComposeSheet("), actions.indexOf("\nfunction ", actions.indexOf("export function ComposeSheet(")));

describe("the composer holds the reader's move, whatever opened it", () => {
  const token = Symbol("t");
  afterEach(() => holdReader(token, false));

  it("a held token stops the move; its release lets it fire", () => {
    holdReader(token, true);
    expect(readerHeldNow()).toBe(true);
    holdReader(token, false);
    expect(readerHeldNow()).toBe(false);
  });

  it("ComposeSheet takes the hold on mount with no mode or route condition, and gives it back on unmount", () => {
    expect(sheet, "the composer holds nothing; a fold moves the reader over it").toContain(
      "useEffect(() => holdWhileOpen(holdToken), [holdToken]);",
    );
  });

  /* THE UNFOLD, DRIVEN: a stack [Ohbox, message/m1, compose], the message route's replace effect
     re-run on every hold change as `useSyncExternalStore` re-renders it, and REPLACE acting on the
     focused route as expo-router's does (no source). The composer mounts through the same
     `holdWhileOpen` its effect calls, and closes the way a route closes: popped, then unmounted. */
  it("an unfold under an open route composer replaces nothing; once it closes the replace lands on the message route", () => {
    const stack = ["/", "/message/m1", "/compose"];
    const replaces: string[] = [];
    const twoPane = { panes: 2 };
    const messageRouteEffect = () => {
      const targetPath = twoPane.panes === 2 ? "/(tabs)/index" : null;
      if (readerMoveDue(targetPath, readerHeldNow())) {
        replaces.push(stack[stack.length - 1]!);
        stack[stack.length - 1] = targetPath!;
      }
    };
    const unsubscribe = subscribeReaderHeld(messageRouteEffect);
    try {
      const release = holdWhileOpen(Symbol("composer"));
      twoPane.panes = 2;
      messageRouteEffect();
      expect(replaces, "the unfold replaced the focused route, the composer, and the words went").toEqual([]);
      expect(stack).toEqual(["/", "/message/m1", "/compose"]);
      stack.pop();
      release();
      expect(replaces, "after the close the move fires once, on the message route").toEqual(["/message/m1"]);
      expect(stack).toEqual(["/", "/(tabs)/index"]);
    } finally {
      unsubscribe();
    }
  });

  it("the control: a composer that takes no hold is replaced by the unfold", () => {
    const stack = ["/", "/message/m1", "/compose"];
    const focused = () => stack[stack.length - 1];
    expect(readerMoveDue("/(tabs)/index", readerHeldNow())).toBe(true);
    expect(focused(), "REPLACE with no source acts on this route").toBe("/compose");
  });

  it("both movers wait on the hold: the pushed reader's replace and the pair's push", () => {
    expect(src("../app/message/[id].tsx")).toContain("const leaving = usePaneMove(target, held);");
    expect(src("../src/ui/pane-move.ts")).toContain("const due = target !== null && focused && readerMoveDue(target.pathname, held);");
    expect(readerMoveDue(null, false), "no pane to move to").toBe(false);
    expect(readerMoveDue("/(tabs)/index", true)).toBe(false);
    expect(src("../src/ui/list-detail.tsx")).toContain("const holding = plan.panes !== 2 && open !== null && held && lastAxis.current !== null;");
  });
});

describe("a composer is never unmounted without keeping what a close keeps", () => {
  it("an idle letter worth a row is kept; a send in flight or a keep running is not doubled", () => {
    expect(unmountKeep({ phase: "idle", worth: true, keeping: false })).toBe("keep");
    expect(unmountKeep({ phase: "idle", worth: false, keeping: false })).toBe("nothing");
    expect(unmountKeep({ phase: "queued", worth: true, keeping: false })).toBe("nothing");
    expect(unmountKeep({ phase: "sending", worth: true, keeping: false })).toBe("nothing");
    expect(unmountKeep({ phase: "idle", worth: true, keeping: true })).toBe("nothing");
  });

  it("every close goes through `leave`; the unmount keeps unless a close came first", () => {
    expect(sheet.match(/\bonClose\(\)/g)?.length, "a close that skips the mark reads as an unmount and keeps twice").toBe(1);
    expect(sheet).toContain("const leave = () => {\n    closed.current = true;\n    onClose();");
    expect(sheet).toContain("useEffect(() => () => { if (!closed.current) atUnmount.current(); }, []);");
    const keep = sheet.slice(sheet.indexOf("atUnmount.current = () => {"), sheet.indexOf("const send = async ("));
    // Past the draft limit no keep can land, so the unmount keeps nothing (`compose-keep.ts`).
    expect(keep).toContain("unmountKeep({ phase, worth, keeping: keeping.current, tooLong })");
    expect(keep).toContain("void w.actions.draftKeep({");
    expect(keep).toContain("quiet: true");
  });
});
