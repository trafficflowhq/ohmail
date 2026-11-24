/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import messages from "../messages/en.json";
import german from "../messages/de.json";
import {
  ISO,
  answerSyncWith,
  installShellEnv,
  page,
  mailbox,
  mountShell,
  teardownShellEnv,
  textOf,
  tick,
} from "./fixtures/live-walk-shell";
import { readingColumn, seatedList } from "./ohbox/_finders";

/**
 * The signup account step uses the studio's sentence and field label in both languages.
 * An empty Ohbox says that it is empty and draws group headings only once there is mail.
 */

describe("the signup account step", () => {
  it("uses the account sentence and Email label in English and German", () => {
    expect(messages.join.account).toBe("I’m <name>,</name> at <email>,</email> with a password of <password></password>.");
    expect(german.join.account).toBe(
      "Ich bin <name>,</name> meine Adresse ist <email>,</email> und mein Passwort ist <password></password>.",
    );
    expect(messages.join.emailLabel).toBe("Email");
    expect(german.join.emailLabel).toBe("E-Mail");
  });
});

describe("an empty Ohbox says it is empty", () => {
  beforeEach(installShellEnv);
  afterEach(teardownShellEnv);
  /* The list's group headings by their names (the kit's heading draws its count beside the name), its rows as options,
     its groups as listboxes, and its empty sentence as the kit's Empty says it, the closing dot drawn by the kit.
     The Ohbox list and reading column are separate frame sections. The level-2 group's name comes first. */
  const list = (c: HTMLElement): HTMLElement => {
    const at = seatedList(c);
    expect(at, "the Ohbox's list is not drawn").not.toBeNull();
    return at!;
  };
  const headings = (c: HTMLElement): Array<string | null> =>
    [...list(c).querySelectorAll("h2")].map((n) => n.querySelector("span")?.textContent ?? n.textContent);
  const NOTHING = messages.ohbox.empty.nothing;

  it("no rows means no group headings, and one line saying so", async () => {
    // Mounted through the real shell on a mailbox that has never completed a cycle: no "New"/"Earlier" over an empty
    // column, no empty listbox to land in, and the pane's own one line.
    const c = await mountShell([mailbox({ lastSyncAt: null, createdAt: ISO })]);
    await tick(0);

    expect(c.querySelectorAll("[role=option][data-id]").length, "the premise: no mail").toBe(0);
    expect(headings(c)).toEqual([]);
    expect(list(c).querySelectorAll("[role=listbox]").length, "an empty listbox to land in").toBe(0);
    expect(textOf(c)).toContain(NOTHING);

    // The pane says what it owns and no more: WHY the list is empty is the frame's notice, which says the first sync.
    expect(textOf(c)).toContain(messages.frame.connection.firstSync.title);

    // One empty state, not two: no "Nothing open." beside "Nothing in your Ohbox.".
    expect(readingColumn(c)?.textContent ?? "", "a second empty state").toBe("");
  });

  it("and a heading comes back the moment there is something under it", async () => {
    // The other half of "never weaken an assertion": suppressing an EMPTY group must not have
    // suppressed a full one. Red if either label is deleted rather than made conditional.
    //
    // Two unread messages and no read ones, so exactly ONE group is populated — which also
    // pins the narrower claim: the heading that appears is the heading whose rows exist.
    answerSyncWith(() => page(2, "INBOX"));
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);

    expect(c.querySelectorAll("[role=option][data-id]").length, "the premise: mail arrived").toBe(2);
    expect(headings(c)).toEqual(["New"]);
    expect(textOf(c)).not.toContain(NOTHING);
  });
});
