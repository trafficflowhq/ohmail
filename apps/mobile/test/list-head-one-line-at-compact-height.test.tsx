/** @vitest-environment jsdom */
/**
 * THE LIST HEAD IS ONE LINE AT COMPACT HEIGHT (L-19), RENDERED. The iPhone Pro Max held sideways
 * (956 x 440) splits into two panes, and the list's head (title, meta, freshness, Mark all read)
 * stood ~300 of 440 pt tall: one row of mail showed. At compact height the meta and the freshness
 * ride the title's baseline row; on a taller window they stand under the title as before.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Theme } from "../src/theme";
import { MailThemeContext } from "../src/theme/mail-context";
import { derivePosture } from "../src/ui/posture/derive";
import { mount, styleOf } from "./_rendered-dom";

vi.mock("react-native", async () => (await import("./_rendered-dom")).rnDom);
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("../src/theme", () => ({
  useTheme: () => ({
    c: { ink: "ink", accent: "accent", ink3: "ink3" },
    type: { h1: { fontSize: 30 }, caption: { fontSize: 12 }, sectionLabel: { fontWeight: "700" }, meta: {} },
    radius: { pill: 999 },
    space: { paneXCompact: 16 },
    mail: live.mail, face: live.face, scheme: "light", textCap: 2, textKey: 0.8,
  }),
}));
vi.mock("../src/ui/Icon", () => ({ Icon: () => null, NavigationIcon: () => null }));
vi.mock("../src/state/live", () => ({ readerZone: () => "UTC" }));
vi.mock("../src/state/mail-event-port", () => ({ mailEventPort: () => null }));
vi.mock("../src/state/world", () => ({
  useLiveSession: () => null,
  useWorld: () => ({ worldKey: "", mailboxes: { known: false, ownAddresses: [] } }),
}));
vi.mock("../src/switch/mail-calendar-port", () => ({
  mailCalendarPort: () => live.calendar ? { native: {}, sender: {} } : null,
}));
vi.mock("../src/ui/Sheet", () => ({ Sheet: () => null, SheetRow: () => null }));
const live = vi.hoisted(() => ({
  posture: null as unknown, mail: undefined as true | undefined, face: "paper" as "paper" | "ohmarchy", calendar: true,
}));
vi.mock("../src/ui/posture", async () => ({
  ...(await import("../src/ui/posture/derive")),
  usePosture: () => live.posture,
  useAppWindow: () => ({ width: 0, height: 0 }),
}));

const { ViewHead, Waterline } = await import("../src/ui/base");
const { MailCalendarSwitch } = await import("../src/ui/MailCalendarSwitch");

let open: { unmount(): void } | null = null;
afterEach(() => { open?.unmount(); open = null; live.mail = undefined; live.face = "paper"; live.calendar = true; });

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
  it("places a Paper phone title 16 points after the calendar button", () => {
    pose(390, 844);
    live.mail = true;
    const m = mount(<ViewHead title="News" leading={<MailCalendarSwitch />} />); open = m;
    const button = m.el.querySelector('[data-label="ohcal"]');
    const title = m.el.querySelector('[data-role="header"]');
    const row = title?.parentElement ?? null;
    expect(button?.nextElementSibling).toBe(title);
    expect(styleOf(row?.parentElement ?? null).paddingHorizontal).toBe(16);
    expect(styleOf(button).width).toBe(44);
    expect(styleOf(row).columnGap).toBe(8);
    expect(styleOf(button).marginEnd).toBe(8);
  });

  it("places the title directly at the gutter if the calendar switch is unavailable", () => {
    pose(390, 844);
    live.mail = true;
    live.calendar = false;
    const m = mount(<ViewHead title="Settings" leading={<MailCalendarSwitch />} />); open = m;
    const title = m.el.querySelector('[data-role="header"]');
    expect(title?.parentElement?.firstElementChild).toBe(title);
    expect(styleOf(title?.parentElement?.parentElement ?? null).paddingHorizontal).toBe(16);
  });

  it("keeps the drawer's calendar control free of the title gap", () => {
    pose(390, 844);
    live.mail = true;
    const m = mount(<MailCalendarSwitch drawer />); open = m;
    const button = m.el.querySelector('[data-label="ohcal"]');
    expect(button).not.toBeNull();
    expect(styleOf(button)).toMatchObject({ minHeight: 44, paddingHorizontal: 20 });
    expect(styleOf(button).marginEnd).toBeUndefined();
  });

  it.each([
    { title: "Ohbox", gap: 14 },
    { title: "Settings", gap: 12 },
  ])("puts the $title sheet six points below the calendar on a Paper phone", ({ title, gap }) => {
    pose(390, 844);
    live.mail = true;
    const placement = { aboveSheet: true };
    const m = mount(<ViewHead title={title} style={{ paddingBottom: gap }}
      leading={<MailCalendarSwitch />} {...placement} />); open = m;
    const button = m.el.querySelector('[data-label="ohcal"]');
    const head = button?.parentElement?.parentElement ?? null;
    expect(styleOf(button).height).toBe(44);
    expect(styleOf(head).paddingBottom).toBe(6);
    pose(390, 440);
    m.render(<ViewHead title={title} style={{ paddingBottom: gap }} leading={<MailCalendarSwitch />} {...placement} />);
    const shortButton = m.el.querySelector('[data-label="ohcal"]');
    expect(styleOf(shortButton?.parentElement?.parentElement ?? null).paddingBottom).toBe(gap);
  });

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

  it.each([
    { title: "Ohbox", attention: true, color: "accent" },
    { title: "News", attention: false, color: "ink" },
  ])("draws the mail title’s full stop and keeps $title as the accessible name", ({ title, attention, color }) => {
    pose(390, 844);
    live.mail = true;
    const m = mount(<ViewHead title={title} attention={attention} />); open = m;
    const heading = m.el.querySelector('[data-role="header"]');
    expect(heading?.getAttribute("data-label")).toBe(title);
    expect(heading?.textContent?.replace(/\u2060/g, "")).toBe(title);
    const dot = styleOf(heading?.querySelector("[data-ax-hidden]") ?? null);
    expect(dot.backgroundColor).toBe(color);
    expect(dot.width).toBeCloseTo(10.2);
    expect(dot.height).toBeCloseTo(10.2);
    expect(dot.borderRadius).toBeCloseTo(5.1);
  });

  it("uses the square face’s mark inside mail and leaves an ordinary standalone heading alone", () => {
    pose(390, 844);
    live.face = "ohmarchy";
    const title = <ViewHead title="Settings" />;
    const m = mount(title); open = m;
    expect(m.el.querySelector('[data-role="header"] [data-ax-hidden]')).toBeNull();
    m.render(<MailThemeContext.Provider value={{} as Theme}>{title}</MailThemeContext.Provider>);
    const dot = styleOf(m.el.querySelector('[data-role="header"] [data-ax-hidden]'));
    expect(dot.width).toBeCloseTo(12.6);
    expect(dot.borderRadius).toBe(0);
  });

  it("draws the News boundary's stop at its own caption size", () => {
    live.mail = true;
    const m = mount(<Waterline label="Earlier" meta="11:00" />); open = m;
    const label = [...m.el.querySelectorAll('[data-rn="Text"]')]
      .find((node) => node.textContent?.replace(/\u2060/g, "") === "Earlier");
    const dot = styleOf(label?.querySelector("[data-ax-hidden]") ?? null);
    expect(dot.backgroundColor).toBe("ink");
    expect(dot.width).toBeCloseTo(4.08);
  });
});
