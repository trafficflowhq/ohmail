/** @vitest-environment jsdom */
/**
 * THE LIST HEAD IS ONE LINE AT COMPACT HEIGHT (L-19), RENDERED. The iPhone Pro Max held sideways
 * (956 x 440) splits into two panes, and the list's head (title, meta, freshness, Mark all read)
 * stood ~300 of 440 pt tall: one row of mail showed. At compact height the meta and the freshness
 * ride the title's baseline row; on a taller window they stand under the title as before.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { derivePosture } from "../src/ui/posture/derive";
import { mount, styleOf } from "./_rendered-dom";

vi.mock("react-native", async () => (await import("./_rendered-dom")).rnDom);
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("../src/theme", () => ({
  useTheme: () => ({ c: new Proxy({}, { get: () => "#000" }), type: new Proxy({}, { get: () => ({}) }), textCap: 2, textKey: 0.8 }),
}));
vi.mock("../src/ui/Icon", () => ({ Icon: () => null }));
const live = vi.hoisted(() => ({ posture: null as unknown }));
vi.mock("../src/ui/posture", async () => ({
  ...(await import("../src/ui/posture/derive")),
  usePosture: () => live.posture,
  useAppWindow: () => ({ width: 0, height: 0 }),
}));

const { ViewHead } = await import("../src/ui/base");

let open: { unmount(): void } | null = null;
afterEach(() => { open?.unmount(); open = null; });

const pose = (width: number, height: number) => { live.posture = derivePosture({ width, height, platform: "ios", folds: null, hasFold: false }); };
const textNode = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll('[data-rn="Text"]')].find((n) => n.textContent === text) ?? null;
/** The head's first row: the View that holds the title. */
const titleRow = (el: HTMLElement) => textNode(el, "Ohbox")!.parentElement!;

function head() {
  return (
    <ViewHead
      title="Ohbox"
      meta="1 unread of 18"
      inline={(oneLine) => <span data-fresh={oneLine ? "row" : "under"}>Checked just now</span>}
      right={<span data-right="">Mark all read</span>}
    />
  );
}

describe("the list head at compact height (L-19)", () => {
  it("956 x 440: title, meta, freshness and the control share the title's baseline row", () => {
    pose(956, 440);
    const m = mount(head()); open = m;
    const row = titleRow(m.el);
    expect(styleOf(row)).toMatchObject({ flexDirection: "row", alignItems: "baseline" });
    expect(row.contains(textNode(m.el, "1 unread of 18"))).toBe(true);
    expect(row.contains(m.el.querySelector("[data-fresh]"))).toBe(true);
    expect(m.el.querySelector("[data-fresh]")!.getAttribute("data-fresh")).toBe("row");
    expect(row.contains(m.el.querySelector("[data-right]"))).toBe(true);
    // One line: the meta takes no top margin of its own beside the title.
    expect(styleOf(textNode(m.el, "1 unread of 18")).marginTop).toBeUndefined();
  });

  it("a tall window (402 x 874) keeps the meta and the freshness under the title", () => {
    pose(402, 874);
    const m = mount(head()); open = m;
    const row = titleRow(m.el);
    expect(styleOf(row), "the title's row wraps the control at the largest text").toMatchObject({ flexDirection: "row", flexWrap: "wrap" });
    expect(row.contains(textNode(m.el, "1 unread of 18"))).toBe(false);
    expect(row.contains(m.el.querySelector("[data-fresh]"))).toBe(false);
    expect(m.el.querySelector("[data-fresh]")!.getAttribute("data-fresh")).toBe("under");
    expect(row.contains(m.el.querySelector("[data-right]"))).toBe(true);
    expect(styleOf(textNode(m.el, "1 unread of 18")).marginTop).toBe(4);
  });

  it("News keeps its meta beside the title on a tall window too (metaBeside)", () => {
    pose(402, 874);
    const m = mount(<ViewHead title="News" meta="2 new" metaBeside />); open = m;
    expect(textNode(m.el, "News")!.parentElement!.contains(textNode(m.el, "2 new"))).toBe(true);
    expect(styleOf(textNode(m.el, "2 new")).marginTop).toBeUndefined();
  });

  it("lines under the head (a hint, a note) follow it on either window", () => {
    for (const [w, h] of [[956, 440], [402, 874]] as const) {
      pose(w, h);
      const m = mount(<ViewHead title="News" meta="2 new"><span data-hint="">hint</span></ViewHead>);
      const hint = m.el.querySelector("[data-hint]");
      expect(hint, `${w} x ${h}`).not.toBeNull();
      expect(textNode(m.el, "News")!.parentElement!.contains(hint)).toBe(false);
      m.unmount();
    }
  });
});
