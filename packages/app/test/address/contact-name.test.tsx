/** @vitest-environment jsdom */
import { cleanup, screen } from "@testing-library/react";
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeEach, expect, it } from "vitest";
import { listSeat } from "../places/list-seat.js";
import { letter } from "../reader/support/mail.js";

const address = "anna@acme.test";
const first = `#/address/${encodeURIComponent(address)}`;
const sender = letter("sender", {
  date: "2026-11-10T09:00:00.000Z",
  arrivedAt: "2026-11-10T09:00:00.000Z",
  from: { address, name: "Anna Berg" },
});
const nameless = letter("nameless", {
  date: "2026-11-12T09:00:00.000Z",
  arrivedAt: "2026-11-12T09:00:00.000Z",
  from: { address, name: null },
});
const recipient = letter("recipient", {
  date: "2026-11-11T09:00:00.000Z",
  arrivedAt: "2026-11-11T09:00:00.000Z",
  folder: "Sent" as EngineMessage["folder"],
  to: [{ address: "Anna@Acme.test", name: "Anna B." }],
});

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  Element.prototype.scrollIntoView ??= () => undefined;
});
afterEach(cleanup);

it("uses the newest name for an address from either side of the mail", () => {
  const title = (letters: EngineMessage[]) => {
    cleanup();
    listSeat({ letters, first });
    return screen.getByRole("heading", { level: 1 }).textContent;
  };
  expect(title([nameless, sender])).toBe("Anna Berg");
  expect(title([recipient])).toBe("Anna B.");
  expect(title([sender, recipient, nameless])).toBe("Anna B.");
  expect(title([nameless])).toBe(address);
  expect(title([])).toBe(address);
});
