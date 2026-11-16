/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { design } from "../../src/base/index.js";
import { LookPicture, SettingTile, SettingTiles } from "../../src/mail/index.js";

afterEach(cleanup);

const ROWS = [
  { who: "Giulia Ferrari", address: "giulia@terracotta-milano.example", time: "09:12" },
  { who: "Petra Wyss", address: "petra@makersfest.example", time: "08:47" },
] as const;

describe("LookPicture", () => {
  it.each([
    ["paper", "light"],
    ["paper", "dark"],
    ["ohmarchy", "light"],
    ["ohmarchy", "dark"],
  ] as const)(
    "a %s picture in %s carries every value of that face and scheme on its own root, and says its face",
    (face, scheme) => {
      const { container } = render(<LookPicture face={face} scheme={scheme} title="Ohbox" rows={ROWS} />);
      const root = container.firstElementChild as HTMLElement;
      expect(root.getAttribute("data-face")).toBe(face);
      const values = design.faces[face][scheme] as Readonly<Record<string, string>>;
      /* Every name of the data, each with its value: none left to wear the page's face, none chosen by hand. */
      const set = Array.from({ length: root.style.length }, (_, i) => root.style.item(i)).filter((name) =>
        name.startsWith("--"),
      );
      expect(set.sort()).toEqual(
        Object.keys(values)
          .map((name) => `--${name}`)
          .sort(),
      );
      for (const [name, value] of Object.entries(values))
        expect(root.style.getPropertyValue(`--${name}`), name).toBe(value);
    },
  );

  it("is not heard, and draws the words it is handed: the title, who and when", () => {
    const { container } = render(<LookPicture face="paper" scheme="light" title="Ohbox" rows={ROWS} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(root.textContent).toBe("OhboxGGiulia Ferrari09:12PPetra Wyss08:47");
  });
});

describe("SettingTiles", () => {
  it("is a group named by its label; each tile a button named by its name and tag, pressed when it is the one", () => {
    const paper = vi.fn();
    const ohmarchy = vi.fn();
    render(
      <SettingTiles label="Look">
        <SettingTile name="oh" on onPress={paper}>
          <LookPicture face="paper" scheme="light" title="Ohbox" rows={ROWS} />
        </SettingTile>
        <SettingTile name="ohmarchy" tag="follows Omarchy" on={false} onPress={ohmarchy}>
          <LookPicture face="ohmarchy" scheme="light" title="Ohbox" rows={ROWS} />
        </SettingTile>
      </SettingTiles>,
    );
    const group = screen.getByRole("group", { name: "Look" });
    const on = screen.getByRole("button", { name: "oh" });
    const off = screen.getByRole("button", { name: "ohmarchy follows Omarchy" });
    expect(group.contains(on) && group.contains(off)).toBe(true);
    expect([on.getAttribute("aria-pressed"), off.getAttribute("aria-pressed")]).toEqual(["true", "false"]);
    fireEvent.click(off);
    expect([paper.mock.calls.length, ohmarchy.mock.calls.length]).toEqual([0, 1]);
  });
});
