/** @vitest-environment jsdom */
/**
 * THE PHONE'S RECIPIENT FIELDS SUGGEST, rendered. Typing in To, Cc or Bcc offers the known
 * correspondents the web's field offers (`addressBook` + `matchAddresses`, up to six); a press
 * writes the one the person picked in place of what they were typing and keeps every entry before it.
 */
import { act, createElement as h, forwardRef, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AddressBookEntry } from "@ohmail/client-engine";

const keyboard = new Map<string, () => void>();
vi.mock("react-native", async () => ({
  ...(await import("./_rendered-dom")).rnDom,
  Keyboard: { addListener: (name: string, fn: () => void) => (keyboard.set(name, fn), { remove: () => keyboard.delete(name) }) },
  TextInput: forwardRef<HTMLInputElement, { value: string; accessibilityLabel?: string; onChangeText?: (v: string) => void; onFocus?: () => void; onBlur?: () => void }>(
    (p, ref) => h("input", {
      ref, value: p.value, "data-label": p.accessibilityLabel, onFocus: p.onFocus, onBlur: p.onBlur,
      onChange: (e: { target: { value: string } }) => p.onChangeText?.(e.target.value),
    }),
  ),
}));
vi.mock("../src/theme", () => ({
  useTheme: () => ({ c: new Proxy({}, { get: () => "#000" }), type: new Proxy({}, { get: () => ({}) }), radius: new Proxy({}, { get: () => 8 }), textCap: 2, hit: 48 }),
}));
vi.mock("../src/ui/base", () => ({
  Tap: (p: { children?: ReactNode; accessibilityLabel?: string; onPress?: () => void; hitSlop?: unknown; style?: unknown }) =>
    h("div", { "data-row": p.accessibilityLabel, "data-slop": JSON.stringify(p.hitSlop ?? "auto"), "data-style": JSON.stringify(p.style), onClick: p.onPress }, p.children),
  Txt: (p: { children?: ReactNode; numberOfLines?: number }) => h("span", { "data-lines": p.numberOfLines ?? "" }, p.children),
}));

const { mount } = await import("./_rendered-dom");
const { RecipientInput, stepBack } = await import("../src/ui/RecipientInput");

const entry = (address: string, name = ""): AddressBookEntry => ({ address, name, count: 1, lastAt: 0, evidence: "they_wrote" });
const BOOK = [
  entry("persephone@example.test", "Persephone Lind"),
  entry("pers.only@example.test"),
  entry("nora@example.test", "Lindt, Nora"),
  ...Array.from({ length: 8 }, (_, i) => entry(`person${i}@example.test`)),
];

function field(value: string) {
  const changed: string[] = [];
  const back = { current: null as (() => void) | null };
  const props = { label: "To", value, editable: true, book: () => BOOK, back, onChangeText: (v: string) => changed.push(v) };
  const r = mount(h(RecipientInput, props));
  const focus = () => act(() => r.el.querySelector("input")!.focus());
  const rows = () => [...r.el.querySelectorAll("[data-row]")].map((n) => n.getAttribute("data-row"));
  const press = (i: number) => act(() => (r.el.querySelectorAll("[data-row]")[i] as HTMLElement).click());
  const type = (v: string) => act(() => {
    const input = r.el.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return { ...r, changed, focus, rows, press, props, back, type };
}

describe("a recipient field suggests the people the mirror knows", () => {
  it("nothing until the field is being typed in; then up to six who match", () => {
    const f = field("pers");
    expect(f.rows(), "suggested while nobody types here").toEqual([]);
    f.focus();
    expect(f.rows()).toHaveLength(6);
    expect(f.rows()[0]).toContain("persephone@example.test");
    act(() => f.el.querySelector("input")!.blur());
    expect(f.rows(), "still suggested after the field was let go").toEqual([]);
    f.unmount();
  });

  it("a press writes the pick in place of the typed part and keeps the entries before it", () => {
    const f = field('"Doe, Ann" <ann@example.test>, pers');
    f.focus();
    f.press(0);
    expect(f.changed).toEqual(['"Doe, Ann" <ann@example.test>, Persephone Lind <persephone@example.test>, ']);
    f.unmount();
  });

  it("a name the field cannot read back goes as the bare address", () => {
    const f = field("lindt");
    f.focus();
    expect(f.rows()).toHaveLength(1);
    f.press(0);
    expect(f.changed).toEqual(["nora@example.test, "]);
    f.unmount();
  });

  it("after a separator, or with no match, nothing is offered", () => {
    const f = field("pers, ");
    f.focus();
    expect(f.rows()).toEqual([]);
    f.render(h(RecipientInput, { ...f.props, value: "zzz" }));
    expect(f.rows()).toEqual([]);
    f.unmount();
  });

  it("a row is its own 48 dp target: no slop reaching into the row above or the field", () => {
    const f = field("person");
    f.focus();
    const rows = [...f.el.querySelectorAll("[data-row]")];
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.getAttribute("data-slop"), "an address-only row's slop crosses the 4 dp gap").toBe("0");
      expect(JSON.parse(row.getAttribute("data-style")!).minHeight).toBeGreaterThanOrEqual(48);
    }
    f.unmount();
  });

  it("names and addresses wrap at large text, never cut: two addresses that differ mid-way stay apart", () => {
    const f = field("pers");
    f.focus();
    const lines = [...f.el.querySelectorAll("[data-row] span")].map((n) => n.getAttribute("data-lines"));
    expect(lines.length).toBeGreaterThan(6);
    expect(lines.every((n) => n === ""), "a suggestion line is capped").toBe(true);
    f.unmount();
  });

  it("Back closes the open list first and leaves the sheet; the next Back is the sheet's", () => {
    const f = field("pers");
    expect(stepBack(f.back), "a Back with no list taken").toBe(false);
    f.focus();
    expect(f.rows()).toHaveLength(6);
    let took = false;
    act(() => { took = stepBack(f.back); });
    expect(took, "Back went past the open list").toBe(true);
    expect(f.rows()).toEqual([]);
    expect(stepBack(f.back), "the second Back was taken too").toBe(false);
    f.type("perso");
    expect(f.rows(), "typing on did not bring the list back").not.toEqual([]);
    f.unmount();
  });

  it("the keyboard going away takes the list with it; typing brings it back", () => {
    const f = field("pers");
    f.focus();
    act(() => keyboard.get("keyboardDidHide")!());
    expect(f.rows()).toEqual([]);
    expect(stepBack(f.back)).toBe(false);
    f.type("perso");
    expect(f.rows()).not.toEqual([]);
    f.unmount();
  });
});
