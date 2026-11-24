/** @vitest-environment jsdom */
import { act, fireEvent } from "@testing-library/react";
import { expect, it } from "vitest";
import { json } from "./account/account-harness";
import { closeMailPage, inboxPage, mountMailPage, prepareMailPage, scopedSyncResponse, tick } from "./fixtures/mounted-mail-page";

it("disambiguates the selected person when a namesake arrives", async () => {
  const initial = await inboxPage(2).json();
  const [rule, first, second] = initial.changes.creates;
  const address = first.entity.from.address as string;
  const firstLetter = { ...first, entity: { ...first.entity, from: { name: "Ben Arnold", address }, authVerdict: "pass" } };
  const secondLetter = { ...second, entity: { ...second.entity,
    from: { name: "Ben Arnold", address: ["another-ben", "mail.invalid"].join("@") }, authVerdict: "pass",
  } };
  let namesake = false;
  let delivered = false;
  await prepareMailPage({
    "GET /api/hello": () => json({ product: "ohmail", needsSetup: false, features: { searchPeople: true } }),
    "GET /api/sync": () => {
      const creates = namesake ? [secondLetter] : [rule, firstLetter];
      if (namesake) delivered = true;
      return scopedSyncResponse({ ...initial, cursor: namesake ? "c2" : "c1", changes: { ...initial.changes, creates } });
    },
  });
  try {
    window.location.hash = "#/search";
    const page = await mountMailPage();
    await act(async () => {
      fireEvent.change(page.getByRole("textbox", { name: "Search" }), { target: { value: "from:ben " } });
    });
    expect(page.getByRole("button", { name: "Remove Ben Arnold" })).toBeTruthy();
    namesake = true;
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await tick(3000);
    expect(delivered).toBe(true);
    expect(page.getByRole("button", { name: `Remove ${address}` })).toBeTruthy();
    expect(page.queryByRole("button", { name: "Remove Ben Arnold" })).toBeNull();
  } finally {
    closeMailPage();
  }
});
