/** @vitest-environment jsdom */
import { NONE } from "@ohmail/app/host";
import { within } from "@testing-library/react";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { afterEach, beforeEach, expect, it } from "vitest";
import en from "../../messages/en.json";
import { mountShell, press, ROSTER, stubDom, unmountAll, waitFor } from "../_draft-shell.js";

const eventAt = "2026-09-27T09:00:00.000Z";
const changed = Array.from({ length: 5 }, (_, i): MailboxFacts => ({
  ...ROSTER[0]!,
  id: `mailbox-${i}`,
  address: [`mailbox-${i}`, "example.invalid"].join("@"),
  organizerRole: "reader",
  organizerState: "stopped",
  organizedBy: { kind: "local", name: "Office", since: eventAt },
  organizerEventAt: eventAt,
  organizerEventSeenAt: null,
}));

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  stubDom();
});
afterEach(unmountAll);

it("opens the full list from a grouped notice and keeps only the mailbox whose dismissal was refused", async () => {
  const dismissed: string[] = [];
  const { el } = await mountShell("#/ohbox", [], [], {
    roster: changed,
    places: { settings: NONE },
    mailboxNotices: {
      organizerNotice: async (id) => {
        dismissed.push(id);
        if (id === changed[0]!.id) throw new TypeError();
      },
    },
  });
  const page = within(el);
  const action = (name: string) => page.queryByRole("button", { name });
  await waitFor(() => action(en.mailboxes.noticeCountShow) !== null, "the grouped notice");
  expect(action(en.mailboxes.noticeDismiss)).toBeNull();
  expect(action(en.mailboxes.noticeOpenMailboxes)).toBeNull();
  expect(dismissed).toEqual([]);
  const show = action(en.mailboxes.noticeCountShow);
  expect(show).not.toBeNull();
  await press(show, en.mailboxes.noticeCountShow);
  const dialog = within(page.getByRole("dialog", { name: /5 mailboxes are no longer being organized/ }));
  expect(dialog.getAllByRole("listitem").map((item) => item.textContent)).toEqual(
    changed.map((row) => `${row.address} · Office · stopped`),
  );
  await press(dialog.getByRole("button", { name: en.mailboxes.noticeDismiss }), "dismiss the inspected group");
  await waitFor(() => page.queryByText(en.mailboxes.noticeDismissOffline) !== null, "the refusal");
  expect(dismissed).toEqual(changed.map((row) => row.id));
  expect(action(en.mailboxes.noticeCountShow)).toBeNull();
  expect(page.queryAllByRole("status").some((el) => el.textContent?.includes(changed[0]!.address))).toBe(true);
}, 30_000);

it("offers the real Mailboxes roster from a single-mailbox organizer notice", async () => {
  const { el } = await mountShell("#/ohbox", [], [], {
    roster: [changed[0]!, ...changed.slice(1).map((row) => ({ ...row, organizerEventSeenAt: eventAt }))],
    mailboxNotices: { organizerNotice: async () => {} },
  });
  const page = within(el);
  const roster = await page.findByRole("button", { name: en.mailboxes.noticeOpenMailboxes });
  expect(page.queryByRole("button", { name: en.mailboxes.noticeDismiss })).not.toBeNull();
  await press(roster, "open Mailboxes");
  expect(window.location.hash).toBe("#/settings/mailboxes");
  for (const row of changed) {
    expect((await page.findAllByText(row.address, { exact: true })).length).toBeGreaterThan(0);
  }
});
