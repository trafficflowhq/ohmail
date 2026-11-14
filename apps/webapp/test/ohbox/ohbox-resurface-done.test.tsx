/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSeat, sent } from "../../../../packages/app/test/places/list-seat.js";
import { letter } from "../../../../packages/app/test/reader/support/mail.js";
import messages from "../../messages/en.json";

const at = "2026-11-17T09:00:00.000Z";
const returnAt = "2026-11-28T09:00:00.000Z";

function filed(id: string, subject: string, state: "bubbled_up" | "reply_later") {
  return letter(id, {
    subject,
    unread: false,
    triage: { messageId: id, state, bubbleUpAt: state === "bubbled_up" ? returnAt : null, setAt: at, updatedAt: at },
  });
}

beforeEach(() => {
  window.localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  Element.prototype.scrollIntoView ??= () => undefined;
});
afterEach(cleanup);

describe("the Resurface pile's rows carry the same verb, read for a scheduled row", () => {
  it("a scheduled row offers Done and dispatches `resurface_done` for its message", async () => {
    const { mail } = listSeat({
      first: "#/triage/resurface/m/other",
      letters: [
        filed("booked", "Remember the market", "bubbled_up"),
        filed("other", "Remember the meeting", "bubbled_up"),
      ],
    });
    await act(async () => undefined);

    const list = within(screen.getByRole("listbox", { name: messages.resurface.title }));
    const row = list.getByRole("option", { name: /Remember the market/ });
    expect(list.getByRole("option", { name: /Remember the meeting/ }).getAttribute("aria-selected")).toBe("true");
    const done = within(row.parentElement!).getByRole("button", { name: messages.later.row.done });
    fireEvent.click(done);
    await act(async () => undefined);

    expect(sent(mail)).toEqual(["triage_set booked none", "mark_seen booked read"]);
    expect(list.getByRole("option", { name: /Remember the meeting/ })).toBeTruthy();
  });

  it("the other piles' rows do NOT carry it — done is a claim about a resurface", async () => {
    listSeat({ first: "#/triage", letters: [filed("queued", "Answer the invitation", "reply_later")] });
    await act(async () => undefined);

    const list = within(screen.getByRole("listbox", { name: messages.later.title }));
    expect(list.getByRole("option", { name: /Answer the invitation/ })).toBeTruthy();
    expect(list.queryByRole("button", { name: messages.later.row.done })).toBeNull();
  });
});
