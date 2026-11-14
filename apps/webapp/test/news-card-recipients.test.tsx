/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { message, mountShell, stubDom, unmountAll } from "./_draft-shell.js";
import { code } from "./_news-recipient-source.js";

const letter = message("news-recipients", {
  folder: "ohmail/News",
  subject: "The weekly note",
  from: { name: "Ida Vogt", address: "ida@example.test" },
  to: [{ name: null, address: "me@example.test" }],
});

async function cardHead(to: typeof letter.to): Promise<HTMLElement> {
  const shell = await mountShell("#/reads", [{ ...letter, to }]);
  const stream = within(shell.el).getByRole("region", { name: "News stream" });
  const card = within(stream).getByRole("article");
  expect(within(card).getByRole("heading", { name: letter.subject! })).toBeTruthy();
  return within(card).getByRole("button", { name: /^Ida Vogt/ }).closest("header")!;
}

beforeEach(() => stubDom());
afterEach(unmountAll);

describe("a card with one recipient is the header it was", () => {
  it("renders NO recipients block — `To: you` under every subject says nothing", async () => {
    const head = await cardHead(letter.to);
    expect(within(head).queryByRole("paragraph"), "a one-recipient card grew a recipients block").toBeNull();
    expect(within(head).queryByRole("button", { name: /^(me|you)/i })).toBeNull();
    expect(within(head).getByText("Ida Vogt").textContent).toBe("Ida Vogt");
    expect(within(head).getByRole("time").textContent).toBeTruthy();
  });

  it("renders no block when the message has no To and no Cc at all", async () => {
    const head = await cardHead([]);
    expect(within(head).queryByRole("paragraph")).toBeNull();
  });
});

describe("the block is mounted, never re-spelled", () => {
  it("both surfaces mount MessageHead and neither draws its own chips", () => {
    const parts = [
      "../../../packages/app/src/reader/Letter.tsx",
      "../../../packages/app/src/stream/StreamColumn.tsx",
    ];
    for (const part of parts) {
      const source = code(readFileSync(new URL(part, import.meta.url), "utf8"));
      expect(source, part).toMatch(/<MessageHead\s/);
      expect(source, part).not.toContain('"oh-messagehead-person"');
      expect(source, part).not.toContain("<ContactCard");
    }
  });

  it("the comment stripper does not eat the code it is asked about", () => {
    // The stripper is now load-bearing for the census above, so it is itself under test:
    // a class name in JSX must survive, and a forked implementation hidden in a comment
    // must not. Both directions, because only one of them fails loudly.
    expect(code('const a = 1; // "rcpt-chip"')).not.toContain("rcpt-chip");
    expect(code('/* <ContactPopover /> */ const b = 2;')).not.toContain("<ContactPopover");
    expect(code('<button className="rcpt-chip">')).toContain('"rcpt-chip"');
    expect(code('const u = "https://x.invalid/a"; // note')).toContain("https://x.invalid/a");
  });
});
