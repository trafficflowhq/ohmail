/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HELP_STATES, HelpPane, helpWayOf, type HelpModel } from "../../../src/settings/help/index.js";
import { drawn, said } from "./words.js";

afterEach(cleanup);

const seen = (words: string) => (document.body.textContent ?? "").includes(words);
const build = { facts: HELP_STATES.compose.model.facts };

describe("which way Write to us goes", () => {
  it("opens the composer wherever this door has a mailbox that sends, whatever the build says of links", () => {
    expect(helpWayOf(true, { mailtoLeaves: true })).toBe("compose");
    expect(helpWayOf(true, { mailtoLeaves: false })).toBe("compose");
  });

  it("is a mail link where none sends and a link leaves, and the copy where it would not", () => {
    expect(helpWayOf(false, { mailtoLeaves: true })).toBe("mailto");
    expect(helpWayOf(false, { mailtoLeaves: false })).toBe("copy");
  });
});

describe("the Help pane", () => {
  it("opens the composer with one press, and says it is the person's own mailbox", () => {
    const write = vi.fn();
    drawn(<HelpPane model={{ ...build, write: { kind: "compose", write } }} />);
    fireEvent.click(screen.getByRole("button", { name: said("en", "help", "write") }));
    expect(write).toHaveBeenCalledTimes(1);
    expect(seen("From your mailbox.")).toBe(false);
  });

  it("is a link to the mail app where nothing here sends", () => {
    drawn(<HelpPane model={{ ...build, write: { kind: "mailto", href: "mailto:?subject=Help" } }} />);
    expect(screen.getByRole("link", { name: said("en", "help", "write") }).getAttribute("href")).toBe(
      "mailto:?subject=Help",
    );
    expect(
      screen
        .getByRole("toolbar", { name: "Help & contact" })
        .contains(screen.getByRole("link", { name: said("en", "help", "write") })),
    ).toBe(true);
  });

  it("offers the address and the block to copy where a link would not leave, and says which was copied", () => {
    const copy = vi.fn();
    const model = (copied: "address" | "diag" | null): HelpModel => ({
      ...build,
      write: { kind: "copy", copied, copy },
    });
    drawn(<HelpPane model={model(null)} />);
    fireEvent.click(screen.getByRole("button", { name: said("en", "help", "copyAddress") }));
    fireEvent.click(screen.getByRole("button", { name: said("en", "help", "copyDiag") }));
    expect(copy.mock.calls).toEqual([["address"], ["diag"]]);
    expect(seen(said("en", "help", "writeWhyCopy"))).toBe(true);
    cleanup();
    drawn(<HelpPane model={model("diag")} />);
    expect(screen.getByRole("button", { name: said("en", "help", "copied") })).toBeTruthy();
    expect(screen.getByRole("button", { name: said("en", "help", "copyAddress") })).toBeTruthy();
  });

  it("names the release and the build's first nine characters, and says none where the build does not", () => {
    drawn(<HelpPane model={HELP_STATES.compose.model} />);
    const version = screen.getByRole("group", { name: said("en", "help", "versionLabel") });
    expect(version.textContent).toContain(`2.0.0 · ${said("en", "help", "dBuild")} localbuil`);
    expect(version.textContent).not.toContain("localbuild");
    cleanup();
    drawn(<HelpPane model={HELP_STATES.noBuild.model} />, "de");
    expect(screen.getByRole("group", { name: said("de", "help", "versionLabel") }).textContent).toContain(
      said("de", "help", "dNone"),
    );
  });

  it("shows readable sync errors in both languages", () => {
    const facts = {
      ...build.facts,
      mailboxes: [{ provider: "imap" as const, lastSyncError: "storage" as const }],
    };
    drawn(<HelpPane model={{ facts, write: { kind: "compose", write: () => {} } }} />);
    expect(screen.getByRole("group", { name: "Last sync error" }).textContent).toContain("Mailbox full");
    cleanup();
    drawn(<HelpPane model={{ facts, write: { kind: "compose", write: () => {} } }} />, "de");
    expect(screen.getByRole("group", { name: "Letzter Sync-Fehler" }).textContent).toContain("Postfach voll");
  });

  it("omits the extra diagnostic notes", () => {
    drawn(<HelpPane model={HELP_STATES.compose.model} />);
    expect(seen("Includes your account ID when available.")).toBe(false);
    expect(seen("Nothing is sent automatically.")).toBe(false);
  });
});
