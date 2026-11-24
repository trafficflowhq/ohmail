/** @vitest-environment jsdom */
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { letter, mountReader } from "./support/mail.js";

/**
 * THE OPEN LETTER's SENDER ADDRESS IS ON SCREEN WHATEVER ITS RECIPIENTS ARE. Moved here from
 * `apps/webapp/test/lists-and-cards-dom.test.tsx` ("a Bcc-only message's header carries the from line", over today's
 * MessagePane): a letter with no To and no Cc draws no recipients' line, and today's address lived beside it, so a
 * person saw a display name only. The new head prints the sender's address beside the name, whole. Every address is
 * invented.
 */

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("the open message's sender address is on screen whatever the recipients block shows", () => {
  it("a Bcc-only letter's head carries the sender's address, whole, beside the name", () => {
    mountReader({
      letters: [
        letter("b1", {
          threadId: null,
          subject: "Your order",
          from: { name: "Harbour Supply", address: "orders@harbour-supply.invalid" },
          to: [],
          cc: [],
        }),
      ],
      open: "b1",
    });
    expect(
      screen.queryByRole("button", { name: "details" }),
      "premise: no recipients' line, and no details beside it, for a Bcc-only letter",
    ).toBeNull();
    const sender = screen.getByRole("button", { name: /Harbour Supply/ });
    expect(sender.textContent, "the sender's address is not on screen").toContain(
      "orders@harbour-supply.invalid",
    );
  });
});
