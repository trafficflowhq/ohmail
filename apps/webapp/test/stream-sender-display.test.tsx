/** @vitest-environment jsdom */
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { avatarHue, hueStyle } from "@ohmail/ui/base";
import { issue, mountStreamFrame } from "../../../packages/app/test/streams/registered-world.js";

const stored = "sarada@xn--mller-kva.example";
const shown = "sarada@müller.example";

beforeEach(() => {
  localStorage.clear();
  Element.prototype.scrollIntoView ??= () => undefined;
});
afterEach(cleanup);

describe("ACCEPTANCE: a list row", () => {
  it("prints the sender's readable address, and keeps the hue keyed on the stored one", () => {
    const letter = issue("m1", 10, {
      subject: "Rechnung", unread: false, from: { name: "Sarada", address: stored },
    });
    mountStreamFrame({ at: "#/reads", letters: [letter] });
    const card = within(screen.getByRole("region", { name: "News stream" })).getByRole("article");
    const avatar = card.querySelector<HTMLElement>(".oh-avatar")!;
    for (const [name, value] of Object.entries(hueStyle(avatarHue(stored)))) {
      expect(avatar.style.getPropertyValue(name)).toBe(value);
    }
    expect(card.querySelector(".oh-messagehead-address")?.textContent).toBe(shown);
    expect(card.textContent, "the punycode form is still on the row").not.toContain("xn--");
  });
});
