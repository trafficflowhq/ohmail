/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useKeyBindings } from "@ohmail/app-logic/keys";
import { mountOvers, press } from "../../../packages/app/test/overs/over-world.js";
import { Frame } from "@ohmail/app/frame";
import { NONE } from "@ohmail/app/host";
import { TextProvider } from "@ohmail/app/text";
import { fakeHost, NO_ENGINE } from "../../../packages/app/test/support/fake-host.js";
import { FRAME_WORDS } from "../../../packages/app/test/support/frame-words.js";
import { message, mountShell, stubAnimate, stubDom, unmountAll } from "./_draft-shell.js";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

afterEach(async () => {
  cleanup();
  await unmountAll();
  vi.unstubAllGlobals();
});

describe("ShortcutHint — the one item at the pane foot", () => {
  it("with no ? binding it renders NOTHING — never a guessed hint", () => {
    const made = fakeHost({
      engine: NO_ENGINE,
      scope: "acct-1",
      service: "self",
      places: {
        ohbox: { id: "ohbox", body: "ohbox", rail: null, panes: { kind: "wide", Wide: () => <p>Inbox view</p> } },
      },
      overs: { palette: NONE, keys: NONE },
    });
    render(<TextProvider locale="en" messages={FRAME_WORDS.en} timeZone="UTC"><Frame host={made.host} /></TextProvider>);
    expect(screen.getByText("Inbox view")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /shortcuts/i })).toBeNull();
    act(() => press("?"));
    expect(screen.queryByRole("dialog", { name: /shortcuts/i })).toBeNull();
  });

  it("the movement hints are GENERATED — the enabled arrow winner's own label, never a typed one", () => {
    const moves: string[] = [];
    function Arrows() {
      useKeyBindings([
        { chord: "ArrowDown", group: "navigate", label: "shadowed and disabled", disabled: true, run: () => {} },
        { chord: "ArrowDown", group: "navigate", label: "next message", run: () => { moves.push("down"); } },
      ], "global");
      return null;
    }
    stubAnimate();
    mountOvers(() => <Arrows />);
    act(() => press("ArrowDown"));
    expect(moves).toEqual(["down"]);
    act(() => press("?"));
    const sheet = within(screen.getByRole("dialog", { name: "Keyboard shortcuts" }));
    expect(sheet.getAllByText("next message")).toHaveLength(1);
    expect(sheet.queryByText("shadowed and disabled")).toBeNull();
  });
});

describe("every pane-foot strip is the affordance, not a legend", () => {
  it("no view hand-types a key legend again", () => {
    const parts = [
      "packages/app/src/stream/StreamList.tsx",
      "packages/app/src/stream/StreamColumn.tsx",
      "packages/app/src/screener/ScreenerList.tsx",
      "packages/app/src/screener/ScreenerReading.tsx",
      "packages/app/src/ohbox/Seat.tsx",
      "packages/app-logic/src/ohbox/keys.ts",
    ];
    for (const part of parts) {
      const source = read(part);
      expect(source.includes("hintMove"), `${part} carries a hand-typed key legend again`).toBe(false);
      expect(source.includes("hintAllKeys"), `${part} still renders the old '? all keys' span`).toBe(false);
    }
  });
});

describe("the strip cannot wrap and cannot push the pane wider", () => {
  it("under 700px the strips are gone entirely — no keyboard chrome over a phone's list", async () => {
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal("innerHeight", 844);
    stubDom({ narrow: true });
    const { el } = await mountShell("#/reads", [message("news-shortcuts", { folder: "ohmail/News" })]);
    const stream = within(el).getByRole("region", { name: "News stream" });
    expect(within(stream).getByRole("heading", { name: "Subject news-shortcuts" })).toBeTruthy();
    expect(stream.closest('[data-device="phone"]')).not.toBeNull();
    expect(within(el).queryByRole("button", { name: /shortcuts/i })).toBeNull();
    expect([...el.querySelectorAll("kbd")].some((key) => key.textContent === "?")).toBe(false);
  });

  it("a coarse pointer hides the strips — a keycap on a keyboardless device is a lie", () => {
    const touch = read("packages/app/src/keys/touch-keys.css");
    const coarse = touch.slice(touch.indexOf("@media (pointer: coarse)"));
    expect(coarse).toContain(".view .list-hints");
    expect(coarse).toContain(".view .stream-hints");
  });
});

describe("both themes resolve the affordance", () => {
  const style = read("packages/ui/src/base/Overlays/key-help.css");

  it("key-help.css names no literal color — tokens only", () => {
    expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b|oklch\(|rgb\(|hsl\(/);
  });

  it("every color token it reads is defined for light AND dark", () => {
    const tokens = read("packages/tokens/src/tokens.css") + read("packages/tokens/src/design/tokens.css");
    const names = new Set(
      [...style.matchAll(/(?:color|background):\s*var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]!),
    );
    expect(names.size, "no color token found").toBeGreaterThan(0);
    for (const name of names) {
      const definitions = tokens.match(new RegExp(`${name}\\s*:`, "g")) ?? [];
      expect(definitions.length, `${name} is not defined in both themes`).toBeGreaterThanOrEqual(2);
    }
  });
});
