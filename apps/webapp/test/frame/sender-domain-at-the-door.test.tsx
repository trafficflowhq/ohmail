/** @vitest-environment jsdom */
/**
 * THE SENDER's DOMAIN, OVER THE NEW SHELL's DOOR (an identity surface). The open letter's head
 * draws the sender's address with its domain as one piece of its own, whatever the name the sender chose says, so that
 * a line short of room cuts the local part and never the domain (how it lays out: the kit's own case in a browser,
 * `packages/ui/test/mail/sender-domain-in-a-browser.test.tsx`); a screen reader hears the name and the address whole.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { message, mountShell, stubDom, unmountAll, waitFor } from "../_draft-shell.js";

/** Sixty characters the sender chose; the address is the one the test door's rule lets into the Ohbox. */
const NAME = "Lena Kaufmann of Atelier Eichspan, Customer Care and Billing";
const ADDRESS = "colleague@example.invalid";

const letter = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="region"][aria-label="Open message"]');

beforeEach(() => {
  try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
});
afterEach(async () => {
  await unmountAll();
});

describe("the open letter's head, as the hosts mount it", () => {
  it("draws the sender's domain as one whole piece beside a long name, and says the name and the address whole", async () => {
    await mountShell("#/ohbox/m/m1", [message("m1", { from: { address: ADDRESS, name: NAME } } as never)]);
    await waitFor(() => letter()?.textContent?.includes(ADDRESS.slice(0, 9)) === true, "the letter's head");
    const head = letter()!;
    const sender = [...head.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.getAttribute("aria-haspopup") === "dialog" && (b.getAttribute("aria-label") ?? "").startsWith(NAME),
    );
    expect(sender?.getAttribute("aria-label"), "the sender's control, by what it says").toBe(`${NAME} ${ADDRESS}`);
    const pieces = [...sender!.querySelectorAll<HTMLElement>("*")].map((el) => el.textContent);
    expect(pieces, "the domain stands as one piece of its own").toContain("@example.invalid");
    expect(pieces, "the local part stands apart from it").toContain("colleague");
  }, 30_000);
});
