/**
 * THE STANDALONE DOOR'S FORM ENDS ABOVE THE KEYBOARD (Android and iOS). On a 411 dp
 * phone the focused SMTP port sat half under the keyboard and Connect could not be scrolled above
 * it: the window is drawn edge to edge, so the keyboard resizes nothing. A scroller asked to
 * `avoidKeyboard` is shortened by the keyboard's height on Android (`keyboard-room.tsx`) and insets
 * its content by it on iOS (`automaticallyAdjustKeyboardInsets`, measured in window coordinates,
 * which scrolls the focused field into view). Rendered the way `segment-face-renders.test.ts`
 * renders; the rig's frames are the acceptance on a device.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { withoutComments, withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";

const shims = vi.hoisted(() => {
  const colour = new Proxy({}, { get: () => "#000000" });
  const number = new Proxy({}, { get: () => 8 });
  return { os: "android" as string, keyboard: 0, theme: { c: colour, radius: number, space: number, type: {}, lift: () => null } };
});
vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  return { ...real, useState: (v: unknown) => [shims.keyboard || v, () => {}], useEffect: () => {} };
});
vi.mock("react-native", () => ({
  Pressable: "Pressable", Text: "Text", View: "View", ScrollView: "ScrollView", RefreshControl: "RefreshControl",
  StyleSheet: { hairlineWidth: 1 }, Keyboard: { addListener: () => ({ remove() {} }) },
  Platform: { get OS() { return shims.os; } },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) }));
vi.mock("../src/ui/posture", () => ({ usePosture: () => ({}) }));
vi.mock("../src/ui/bottom-chrome", () => ({ useBottomChromeExtent: () => 0 }));
vi.mock("../src/ui/nav-drawn", () => ({ useNavDrawn: () => true }));
vi.mock("../src/ui/list-insets", () => ({ listInsets: () => ({}) }));
vi.mock("../src/ui/scaffold/plan", async (importOriginal) => ({
  ...(await importOriginal<object>()), scaffoldPlan: () => ({}), listNavClearance: () => 0,
}));
vi.mock("../src/ui/Icon", () => ({ Icon: "Icon" }));
vi.mock("../src/theme", () => ({ useTheme: () => shims.theme }));

import { Scroller } from "../src/ui/base";
import { KeyboardRoom } from "../src/ui/keyboard-room";

type El = { type: unknown; props: Record<string, unknown> };
const flat = (style: unknown): Record<string, unknown> =>
  Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean).map(flat)) : ((style as Record<string, unknown>) ?? {});
const render = (os: string, avoidKeyboard?: boolean) => {
  shims.os = os;
  return Scroller({ children: "form", ...(avoidKeyboard === undefined ? {} : { avoidKeyboard }) }) as unknown as El;
};

describe("a scroller asked to avoid the keyboard", () => {
  it("Android: it stands in the keyboard's room, and the room is shortened by the keyboard's height", () => {
    const el = render("android", true);
    expect(el.type).toBe(KeyboardRoom);
    const inner = el.props.children as El;
    expect(inner.type).toBe("ScrollView");
    expect(inner.props.keyboardShouldPersistTaps).toBe("handled");
    shims.keyboard = 812;
    const room = KeyboardRoom({ children: "x" }) as unknown as El;
    shims.keyboard = 0;
    expect(flat(room.props.style)).toMatchObject({ flex: 1, paddingBottom: 812 });
  });
  it("iOS: the scroll view insets its content by the keyboard itself, and a press lands with it up", () => {
    const el = render("ios", true);
    expect(el.type).toBe("ScrollView");
    expect(el.props.automaticallyAdjustKeyboardInsets).toBe(true);
    expect(el.props.keyboardShouldPersistTaps).toBe("handled");
  });
  it("control: a scroller not asked keeps its frame on both platforms", () => {
    for (const os of ["android", "ios"]) {
      const el = render(os);
      expect(el.type, os).toBe("ScrollView");
      expect(el.props.automaticallyAdjustKeyboardInsets, os).toBeFalsy();
    }
  });
});

/* THE CENSUS: every screen that draws a text field asks every scroller it draws to avoid the
   keyboard. On the iPhone a first tap with the keyboard up only closed it (Connect waited for a
   second tap). `Scroller` and `MailList` ask with `avoidKeyboard`; a bare list with "handled". */
const APP = fileURLToPath(new URL("../app/", import.meta.url));
const UI = fileURLToPath(new URL("../src/ui/", import.meta.url));
/* The src/ui files that draw a text field, themselves or through another one. INLINE ones draw
   it into their caller's scroller, so a screen rendering one is a form; OWN_WINDOW ones draw
   theirs in their own sheet, modal or drawer, whose scrollers are held here instead. */
const INLINE = [
  "ComposeCopies", "Doors", "Field", "FoldersGroup", "MoreNav", "RecipientInput", "SenderNamePanel", "SignaturesPanel",
];
const OWN_WINDOW = ["MessageActions", "list-detail"];
const read = (dir: string) =>
  (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => ({ file: f, src: withoutComments(readFileSync(join(dir, f), "utf8")) }));
const draws = (names: string[]) => new RegExp(`<(${["TextInput", ...names].join("|")})\\b`);
const uiFields = (() => {
  const ui = read(UI);
  const found = new Set<string>();
  for (let size = -1; size !== found.size; ) {
    size = found.size;
    const through = INLINE.filter((n) => found.has(`${n}.tsx`));
    for (const f of ui) if (draws(through).test(f.src)) found.add(f.file);
  }
  return ui.filter((f) => found.has(f.file));
})();
const FIELD = draws(INLINE);
const SCROLLER = /<(Scroller|MailList|FlatList|SectionList|ScrollView)\b/g;
/** Each scroller's opening tag, its props walked to the `>` that closes it. */
function scrollerTags(src: string): { name: string; tag: string }[] {
  const walk = withoutCommentsAndLiterals(src);
  const out: { name: string; tag: string }[] = [];
  for (const m of walk.matchAll(SCROLLER)) {
    let depth = 0;
    let i = m.index! + m[0].length;
    for (; i < walk.length; i++) {
      const c = walk[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0 && walk[i - 1] !== "=") break;
    }
    out.push({ name: m[1]!, tag: src.slice(m.index!, i + 1) });
  }
  return out;
}
const asks = (s: { name: string; tag: string }): boolean =>
  s.name === "Scroller" || s.name === "MailList"
    ? /\bavoidKeyboard\b(?!\s*=\s*\{\s*false)/.test(s.tag)
    : /keyboardShouldPersistTaps="handled"/.test(s.tag);
const forms = read(APP).filter((s) => FIELD.test(s.src));

describe("every screen with a text field avoids the keyboard", () => {
  it("names the form screens it holds to it, so the census cannot pass over none", () => {
    expect(forms.map((f) => f.file).sort()).toEqual(
      expect.arrayContaining([
        "(tabs)/more.tsx", "away.tsx", "connect.tsx", "search.tsx", "seed-review.tsx", "servers.tsx", "settings.tsx",
        "standalone.tsx", "welcome.tsx",
      ]),
    );
  });
  it("each scroller on those screens asks for it", () => {
    const missing = forms.flatMap((f) => scrollerTags(f.src).filter((s) => !asks(s)).map((s) => `${f.file}: <${s.name}`));
    expect(missing).toEqual([]);
  });
  it("every src/ui file that draws a field is placed, inline or in its own window", () => {
    expect(uiFields.map((f) => f.file.replace(/\.tsx$/, "")).sort()).toEqual([...INLINE, ...OWN_WINDOW].sort());
  });
  it("each scroller in those files asks for it (the Tag sheet's list under its field)", () => {
    const missing = uiFields.flatMap((f) => scrollerTags(f.src).filter((s) => !asks(s)).map((s) => `${f.file}: <${s.name}`));
    expect(missing).toEqual([]);
  });
  it("control: the walk reads a tag's props past an arrow, and refuses one that does not ask", () => {
    const [mail] = scrollerTags("<MailList renderRow={(r) => <Row r={r} />} avoidKeyboard\n/>");
    expect(asks(mail!)).toBe(true);
    const [bare] = scrollerTags("<Scroller bounded>{x}</Scroller>");
    expect(asks(bare!)).toBe(false);
  });
});
