import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * WHICH SET THE OHBOX AND THE SCREENER ARE HANDED, READ FROM THE SOURCE: moved word for word out of
 * `not-organizing-yet-says-so.test.tsx` (which mounts today's Screener view and waits for the Screener place), and
 * re-pointed by path (RULING-NEW-SHELL-FIRST D (3)) from today's `AppShell.tsx` to the two files of the new shell
 * that hand it: the ground's Screener mount (the Screener's model's facts) and the Ohbox's live hook (its feed).
 */

describe("nothingOrganizesOf — every mailbox nothing organizes, and why", () => {
  it("the shell hands the Ohbox and the Screener this set, not the never-agreed one", () => {
    const screener = readFileSync(resolve(process.cwd(), "packages/app/src/mail/ground/ScreenerMount.tsx"), "utf8");
    const ohbox = readFileSync(resolve(process.cwd(), "packages/app-logic/src/ohbox/live.ts"), "utf8");
    /* The Screener takes it as a fact of its model; the seated Ohbox as a member of its live hook's feed. */
    expect(screener.match(/notOrganizingYet(=\{|: )demo \? null : nothingOrganizesOf\(facts\)/g)).toHaveLength(1);
    expect(ohbox.match(/const notOrganizing = demo \? null : nothingOrganizesOf\(facts\);/g)).toHaveLength(1);
    for (const shell of [screener, ohbox]) {
      expect(shell).not.toMatch(/demo \? null : notOrganizingYetOf\(facts\)/);
    }
  });
});
