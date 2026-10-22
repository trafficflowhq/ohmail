/**
 * CONTINUITY ACROSS POSTURE CHANGES — the open message and the reading position survive a
 * fold, an unfold and a rotation (Apple: "right where the user left off"; Android: preserve
 * and restore). Three mechanisms, each measured: the selection is the ROUTE's `open` param
 * (a param is not a tree position, so no remount can drop it); the scroll offset lives in
 * `pane-memory`, OUTSIDE the tree, keyed by message — and posture is not an input to that
 * module by construction; a posture change that removes or adds the second pane MIGRATES the
 * open reading between the pushed route and the pair (`pane-routes`), same id both ways.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { paneScrollOf, recordPaneScroll } from "../src/ui/pane-memory";
import { paneRouteFor } from "../src/ui/pane-routes";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("pane-memory: the offset survives what a posture change does to the tree", () => {
  it("what was recorded is what comes back, per message", () => {
    recordPaneScroll("msg:a", 812);
    recordPaneScroll("msg:b", 40);
    expect(paneScrollOf("msg:a")).toBe(812);
    expect(paneScrollOf("msg:b")).toBe(40);
    expect(paneScrollOf("msg:never-seen")).toBe(0);
  });

  it("posture is not an input: the module imports NOTHING — dependency-free by construction", () => {
    const src = read("../src/ui/pane-memory.ts");
    const imports = src.split("\n").filter((l) => l.trimStart().startsWith("import "));
    expect(imports, "pane-memory grew an import — a fold could reach a reading position").toEqual([]);
  });

  it("bounded, LRU: the newest CAP offsets stay, the oldest goes, a re-read refreshes nothing", () => {
    recordPaneScroll("msg:evict-me", 7);
    for (let i = 0; i < 64; i++) recordPaneScroll(`msg:fill-${i}`, i);
    expect(paneScrollOf("msg:evict-me")).toBe(0);
    expect(paneScrollOf("msg:fill-63")).toBe(63);
    // recording again re-inserts at the fresh end — the courtesy follows the reader
    recordPaneScroll("msg:fill-0", 5);
    for (let i = 100; i < 163; i++) recordPaneScroll(`msg:fill-${i}`, i);
    expect(paneScrollOf("msg:fill-0")).toBe(5);
  });
});

describe("pane-routes: where a full-screen reading lands when the second pane arrives", () => {
  const base = { id: "m1", place: "ohbox" as const };
  it("each surface pairs with its own list", () => {
    expect(paneRouteFor(base)).toEqual({ pathname: "/", params: { open: "m1" } });
    expect(paneRouteFor({ ...base, place: "reads" })).toEqual({ pathname: "/reads", params: { open: "m1" } });
    expect(paneRouteFor({ ...base, place: "receipts" })).toEqual({ pathname: "/receipts", params: { open: "m1" } });
    expect(paneRouteFor({ ...base, historyPlace: "INBOX" })).toEqual({ pathname: "/history", params: { open: "m1" } });
  });
  it("gate-held mail and folder mail stay full-screen — never beside the wrong list", () => {
    expect(paneRouteFor({ ...base, gateHeld: true })).toBeNull();
    expect(paneRouteFor({ ...base, folderLeaf: "Invoices" })).toBeNull();
  });
});

describe("the migrations are wired, both directions", () => {
  it("the message route yields to the pair when a second pane arrives", () => {
    const route = read("../app/message/[id].tsx");
    expect(route).toContain("paneRouteFor");
    expect(route).toContain("const leaving = usePaneMove(target, held);");
    expect(read("../src/ui/pane-move.ts")).toContain("router.dismissTo({ pathname: leaving.pathname, params: leaving.params });");
    expect(route).toContain("plan.panes === 2");
  });
  it("the sender route yields to the Screener pair, shelf named", () => {
    const route = read("../app/sender/[seg]/[id].tsx");
    expect(route).toContain('usePaneMove(twoPane && id !== "" ? { pathname: "/screener", params: { open: id, seg } } : null, held)');
  });
  it("the pair hands an open reading to the pushed route when the pane goes", () => {
    const ld = read("../src/ui/list-detail.tsx");
    expect(ld).toContain("if (!twoPane && open !== null)");
    expect(ld).toContain("router.push(toRoute(open))");
  });
  it("the selection is the route's open param — state no remount holds", () => {
    const ld = read("../src/ui/list-detail.tsx");
    expect(ld).toContain('useLocalSearchParams<{ open?: string }>');
    expect(ld).toContain("router.setParams({ open: id })");
    // and no useState holds the selection
    expect(/useState[^;]*open/i.test(ld)).toBe(false);
  });
});

describe("the reader writes and restores its position through pane-memory", () => {
  it("MessageReader records on scroll and restores the same key", () => {
    const src = read("../src/ui/MessageReader.tsx");
    expect(src).toContain("const scrollKey = `msg:${id}`;");
    expect(src).toContain("recordPaneScroll(scrollKey, y)");
    // Every scroll report goes through the open anchor, which stands on the offset the view reached.
    expect(src).toContain("const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => anchor.reached(e.nativeEvent.contentOffset.y);");
    expect(src).toContain("stand: (y) => standRef.current(y),");
    // Read ONCE per mount: a fresh offset each render scrolled the reader back to a stale place.
    expect(src).toContain("const startAt = useMemo(() => ({ x: 0, y: paneScrollOf(scrollKey) }), [scrollKey]);");
    expect(src).toContain("contentOffset={startAt}");
  });
});
