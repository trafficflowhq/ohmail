/** @vitest-environment jsdom */
import { KeymapContext, useKeyBindings, useKeymapStore } from "@ohmail/app-logic/keys";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AboutPane,
  aboutMailboxesOf,
  aboutPoliciesOf,
  aboutStates,
  HOSTED_POLICIES,
  type AboutModel,
} from "../../../src/settings/about/index.js";
import { FrameContext, type FrameInner } from "../../../src/frame/commands.js";
import { SHEET_CHORD } from "../../../src/frame/keyboard/availability.js";
import { drawn, said } from "./words.js";

afterEach(cleanup);

const seen = (words: string) => (document.body.textContent ?? "").includes(words);
const publisher = { lines: ["The Publisher Ltd", "1 Street, Town"], address: "help@example.org" };
const states = aboutStates(publisher, "The server could not be reached.");
const group = (lang: "en" | "de", key: string) =>
  screen.getByRole("group", { name: said(lang, "about", key) });

describe("the mailbox line, from the server's list", () => {
  it("is being read while there is no list, and a disabled mailbox is not connected", () => {
    expect(aboutMailboxesOf(null)).toEqual({ kind: "reading" });
    expect(aboutMailboxesOf([{ address: "a@example.org", status: "disabled", lastSyncAt: null }])).toEqual({
      kind: "none",
    });
  });

  it("names the first connected mailbox and counts the others, with its sync exactly as the server said", () => {
    expect(
      aboutMailboxesOf([
        { address: "off@example.org", status: "disabled", lastSyncAt: "2026-11-16T08:00:00Z" },
        { address: "a@example.org", status: "active", lastSyncAt: null },
        { address: "b@example.org", status: "active", lastSyncAt: "2026-11-16T08:00:00Z" },
      ]),
    ).toEqual({ kind: "some", first: "a@example.org", others: 1, lastSyncAt: null });
  });
});

describe("where the policies are linked", () => {
  it("on the managed service alone, whose documents they are", () => {
    expect(aboutPoliciesOf({ service: "managed" })).toEqual(HOSTED_POLICIES);
    expect(aboutPoliciesOf({ service: "self" })).toBeNull();
    expect(aboutPoliciesOf({ service: "ownComputer" })).toBeNull();
  });
});

function AboutWithShortcut({ frame }: { frame: FrameInner }) {
  const keys = useKeymapStore();
  return (
    <KeymapContext.Provider value={keys}>
      <FrameContext.Provider value={frame}>
        <KeyboardHelpBinding />
        <AboutPane model={states.synced.model} />
      </FrameContext.Provider>
    </KeymapContext.Provider>
  );
}

function KeyboardHelpBinding() {
  useKeyBindings(
    [{ chord: SHEET_CHORD, group: "app", label: "Keyboard shortcuts", run: () => {} }],
    "global",
  );
  return null;
}

describe("the About pane", () => {
  it("opens the frame's keyboard sheet from About", () => {
    const over = vi.fn();
    const frame = { api: { commands: { over }, plan: { device: "desktop" } } } as unknown as FrameInner;
    drawn(<AboutWithShortcut frame={frame} />);
    fireEvent.click(screen.getByRole("button", { name: said("en", "settingsAbout", "showKeyboard") }));
    expect(over.mock.calls).toEqual([["keys"]]);
  });

  it("says a failed read as not read, with the server's sentence, never as no mailbox", () => {
    drawn(<AboutPane model={states.failed.model} />);
    expect(seen(said("en", "settingsAbout", "notRead"))).toBe(true);
    expect(seen("The server could not be reached.")).toBe(true);
    expect(seen(said("en", "about", "noMailbox"))).toBe(false);
  });

  it("says a mailbox never synced as not synced yet, never as just now", () => {
    drawn(<AboutPane model={states.neverSynced.model} />);
    expect(seen(`mila@example.org — ${said("en", "about", "neverSynced")}.`)).toBe(true);
  });

  it("says reading, none and several as the shipped pane does", () => {
    drawn(<AboutPane model={states.reading.model} />);
    expect(seen(said("en", "about", "loading"))).toBe(true);
    cleanup();
    drawn(<AboutPane model={states.none.model} />);
    expect(seen(said("en", "about", "noMailbox"))).toBe(true);
    cleanup();
    drawn(<AboutPane model={states.several.model} />);
    expect(seen("mila@example.org and 2 more")).toBe(true);
  });

  it("names the build in a group a screen reader and the journeys find by its label", () => {
    drawn(<AboutPane model={states.synced.model} />, "de");
    expect(group("de", "buildLabel").textContent).toContain("2.0.0 · Build local.");
  });

  it("says the one check this window cannot make only where the server said it does not name its answers", () => {
    drawn(<AboutPane model={states.synced.model} />);
    expect(seen(said("en", "about", "accountHeaderMissing"))).toBe(false);
    cleanup();
    drawn(<AboutPane model={{ ...states.synced.model, namesAccount: null }} />);
    expect(seen(said("en", "about", "accountHeaderMissing"))).toBe(false);
    cleanup();
    drawn(<AboutPane model={states.unnamed.model} />);
    expect(group("en", "accountHeaderLabel")).toBeTruthy();
    expect(seen(said("en", "about", "accountHeaderMissing"))).toBe(true);
  });

  it("links the three documents where they govern, and none on a self-hosted install", () => {
    drawn(<AboutPane model={states.synced.model} />);
    const links = screen.getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toEqual([
      ["help@example.org", "mailto:help@example.org"],
      [said("en", "settingsAbout", "privacy"), "/privacy"],
      [said("en", "settingsAbout", "subprocessors"), "/subprocessors"],
      [said("en", "settingsAbout", "imprint"), "/imprint"],
    ]);
    cleanup();
    drawn(<AboutPane model={states.selfHosted.model} />);
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(seen(said("en", "about", "yourMail"))).toBe(false);
  });

  it("writes the publisher's lines as the host holds them, untranslated", () => {
    const model: AboutModel = states.synced.model;
    drawn(<AboutPane model={model} />, "de");
    expect(seen("The Publisher Ltd · 1 Street, Town")).toBe(true);
  });
});
