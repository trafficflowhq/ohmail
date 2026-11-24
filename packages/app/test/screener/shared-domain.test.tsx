/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { modelOf, mountPlace, sender, type Asked } from "./screener-world.js";

vi.mock("@ohmail/app-logic/screener", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ohmail/app-logic/screener")>();
  return { ...real, isSharedDomain: (address: string) => address.endsWith("@shared-provider.example") };
});

let asked: Asked;
beforeEach(() => {
  asked = { flushes: 0 };
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
});
afterEach(cleanup);

it("a sender at a shared provider's domain is decided alone: no whole-domain reach is offered anywhere", () => {
  const free = sender("free", "Free Mail", {
    from: { name: "Free Mail", address: "someone@shared-provider.example" },
  });
  mountPlace(modelOf(asked, { waiting: [free], waitingCount: 1 }));
  const reading = screen.getByRole("region", { name: "Reading" });
  expect(within(reading).queryByRole("button", { name: "Decision scope" })).toBeNull();
  act(() => {
    fireEvent.keyDown(document.body, { key: "s" });
  });
  const card = screen.getByRole("dialog", { name: "Change this sender's screening" });
  expect(within(card).queryByRole("radio", { name: /Everyone at/ })).toBeNull();
  fireEvent.click(within(card).getByRole("radio", { name: "Receipts" }));
  expect(asked.decided).toEqual([{ id: "free", dest: "receipts", read: false, scope: "sender" }]);
});
