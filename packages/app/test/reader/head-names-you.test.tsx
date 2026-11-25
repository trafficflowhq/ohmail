/** @vitest-environment jsdom */
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { letter, mountReader } from "./support/mail.js";

/**
 * THE HEAD NAMES THE PERSON READING AS THEMSELVES, IN THEIR OWN LANGUAGE. Moved here from
 * `apps/webapp/test/reads-recipients.test.tsx` ("the German face calls the reader `dich`", over today's recipients
 * block): the open letter's head names everyone it went to (no field folds into a count any more), and the account's
 * own address appears with the German self-label in the explicit recipient line. Every address is invented.
 */

const ME = [{ id: "mb-1", address: "me@x.invalid", addressIsOwn: true, status: "active" }];
const THREE = [
  { name: "Anna Roth", address: "anna@x.invalid" },
  { name: "Bo Lind", address: "bo@x.invalid" },
  { name: "Cy Cole", address: "cy@x.invalid" },
];

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("the open letter's head names everyone it went to", () => {
  it("the German face calls the reader `dich`", async () => {
    mountReader({
      letters: [
        letter("m1", { to: [{ name: null, address: "me@x.invalid" }, ...THREE], threadId: null } as never),
      ],
      open: "m1",
      lang: "de",
      host: { mailboxes: async () => ME },
    });
    const address = ME[0]!.address;
    const label = `dich (${address})`;
    const you = await screen.findByRole("button", { name: label });
    expect(screen.queryByRole("button", { name: address })).toBeNull();
    const line = you.closest("p")!;
    const names = [...line.querySelectorAll("button")].map((b) => b.textContent);
    expect(names.slice(0, 2)).toEqual([label, "Anna Roth"]);
  });
});
