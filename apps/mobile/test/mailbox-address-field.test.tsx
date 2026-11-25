/** @vitest-environment jsdom */
import { act } from "react";
import { expect, it, vi } from "vitest";
import { mount, rnDom, styleOf } from "./_rendered-dom";

vi.mock("react-native", () => ({
  ...rnDom,
  TextInput: ({ accessibilityLabel, multiline, value, style, placeholder }: {
    accessibilityLabel: string; multiline: boolean; value: string; style: unknown; placeholder: string;
  }) => {
    const Control = multiline ? "textarea" : "input";
    return <Control aria-label={accessibilityLabel} value={value} placeholder={placeholder} readOnly data-layout={JSON.stringify(style)} />;
  },
}));
vi.mock("../src/ui/base", () => ({ Tap: rnDom.Pressable, Txt: rnDom.Text }));
vi.mock("../src/theme", () => ({ useTheme: () => ({ scheme: "light", face: "paper", hit: 44, type: {}, c: {} }) }));

const { Field } = await import("../src/ui/Field");

it("the long mailbox address can remain visible after focus leaves the sign-in field", () => {
  const address = ["a-long-mailbox", "example.invalid"].join("@");
  const view = mount(
    <Field
      label="Mailbox address"
      value={address}
      onChange={() => undefined}
      sentence={{ before: "I’m", after: "with", placeholder: "email address", compact: true }}
      input={{ keyboardType: "email-address" }}
    />,
  );
  try {
    const input = view.el.querySelector<HTMLInputElement | HTMLTextAreaElement>('[aria-label="Mailbox address"]')!;
    act(() => { input.focus(); input.blur(); });
    expect(input.value === address).toBe(true);
    expect(input.tagName).toBe("TEXTAREA");
    expect(input.dataset.layout).not.toContain('"position":"absolute"');
  } finally {
    view.unmount();
  }
});

it.each([
  ["long", ["a-long-mailbox-address-that-wraps", "example.invalid"].join("@")],
  ["short", ["a", "b.ch"].join("@")],
  ["empty", ""],
])("lays out the %s mailbox address as its own sentence field", (_length, address) => {
  const placeholder = "email address";
  const view = mount(
    <Field
      label="Mailbox address"
      value={address}
      onChange={() => undefined}
      sentence={{ before: "I’m", after: "with", placeholder }}
      input={{ keyboardType: "email-address" }}
    />,
  );
  try {
    const field = view.el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Mailbox address"]')!;
    const row = field.parentElement!;
    expect(row.firstElementChild?.textContent).toBe("I’m");
    expect(field.nextElementSibling?.textContent).toBe("with");
    expect(styleOf(row)).toMatchObject({ flexWrap: "wrap", alignItems: "baseline" });
    expect(field.value === address).toBe(true);
    expect(field.placeholder).toBe(placeholder);
    const layout = JSON.parse(field.dataset.layout!).flat();
    const editorStyle = Object.assign({}, ...layout);
    expect(editorStyle).toMatchObject({ maxWidth: "100%", borderStyle: "dotted", paddingVertical: 0 });
    for (const key of ["width", "flex", "flexGrow", "flexBasis"]) {
      expect(editorStyle).not.toHaveProperty(key);
    }
    expect(styleOf(field.nextElementSibling)).not.toHaveProperty("borderBottomWidth");
  } finally {
    view.unmount();
  }
});
