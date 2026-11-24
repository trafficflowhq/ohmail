/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Editor } from "@tiptap/react";
import type { EngineMessage } from "@ohmail/wire";
import { listSeat, sent } from "../places/list-seat.js";
import { letter } from "../reader/support/mail.js";

const dateAt = (day: number) => new Date(Date.UTC(2026, 10, day, 9)).toISOString();

function filed(
  id: string,
  subject: string,
  state: "reply_later" | "set_aside" | "bubbled_up",
  day: number,
): EngineMessage {
  const date = dateAt(day);
  return letter(id, {
    subject,
    unread: false,
    date,
    arrivedAt: date,
    triage: {
      messageId: id,
      state,
      bubbleUpAt: state === "bubbled_up" ? dateAt(28) : null,
      setAt: date,
      updatedAt: date,
    },
  });
}

const LETTERS = [
  filed("reply", "Reply to the kiln", "reply_later", 14),
  filed("reply_other", "Confirm the next firing", "reply_later", 13),
  filed("park_first", "Save the glaze samples", "set_aside", 15),
  filed("park_second", "Save the studio plans", "set_aside", 16),
  filed("booked", "Remember the market", "bubbled_up", 17),
];

const rail = () => within(screen.getByRole("navigation", { name: "Places" }));
const option = (subject: string) => screen.getByRole("option", { name: new RegExp(subject) });
const reading = () => within(screen.getByRole("region", { name: "Reading" }));
const settled = async () => {
  await act(async () => undefined);
};

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  Element.prototype.scrollIntoView ??= () => undefined;
});
afterEach(() => cleanup());

describe("the three triage piles in the shared mail frame", () => {
  it.each([
    ["Answer Later", "#/triage/m/reply", "Reply to the kiln"],
    ["Parked", "#/triage/aside/m/park_second", "Save the studio plans"],
    ["Resurface", "#/triage/resurface/m/booked", "Remember the market"],
  ])("opens %s and its own first letter from the sidebar", async (name, hash, subject) => {
    const { address, mail } = listSeat({ letters: LETTERS, first: "#/ohbox" });
    fireEvent.click(rail().getByRole("button", { name: new RegExp(`^${name}(?: [0-9]+)?$`) }));
    await settled();
    expect(address.read()).toBe(hash);
    expect(
      within(screen.getByRole("listbox", { name })).getByRole("option", { name: new RegExp(subject) }),
    ).toBeTruthy();
    expect(reading().getByRole("heading", { name: subject })).toBeTruthy();
    expect(sent(mail)).toEqual([]);
  });

  it.each([
    ["#/triage", "Reply to the kiln", "2 to answer"],
    ["#/triage/aside", "Save the studio plans", "2 parked"],
    ["#/triage/resurface", "Remember the market", "1 set to come back"],
  ])("rests at %s until a letter is chosen", async (hash, subject, summary) => {
    const { address, mail } = listSeat({ letters: LETTERS, first: hash });
    await settled();
    expect(address.read()).toBe(hash);
    expect(option(subject).getAttribute("aria-selected")).toBe("false");
    expect(reading().queryByRole("heading", { name: subject })).toBeNull();
    expect(reading().getByRole("paragraph").textContent).toBe(summary);
    expect(sent(mail)).toEqual([]);

    fireEvent.click(option(subject));
    await settled();
    expect(reading().getByRole("heading", { name: subject })).toBeTruthy();
  });

  it("shows the unread count for a resting wide pile with unread mail", async () => {
    const parked = filed("unread", "Look at the glaze samples", "set_aside", 15);
    listSeat({ letters: [...LETTERS, { ...parked, unread: true }], first: "#/triage/aside" });
    await settled();
    expect(reading().getByRole("paragraph").textContent).toBe("1 unread");
  });

  it("keeps the selected Parked letter when leaving via the rail and coming back", async () => {
    const { address } = listSeat({ letters: LETTERS, first: "#/triage/aside" });
    fireEvent.click(option("Save the glaze samples"));
    await settled();
    expect(address.read()).toBe("#/triage/aside/m/park_first");
    fireEvent.click(rail().getByRole("button", { name: /^Ohbox/ }));
    fireEvent.click(rail().getByRole("button", { name: /^Parked/ }));
    await settled();
    expect(address.read()).toBe("#/triage/aside/m/park_first");
    expect(reading().getByRole("heading", { name: "Save the glaze samples" })).toBeTruthy();
  });

  it("offers to mark a read Parked letter unread and changes only that letter", async () => {
    const { mail } = listSeat({ letters: LETTERS, first: "#/triage/aside/m/park_first" });
    await settled();
    fireEvent.click(reading().getByRole("button", { name: "Mark unread" }));
    await settled();
    expect(sent(mail)).toEqual(["mark_seen park_first unread"]);
  });

  it("a link to an older parked member opens its current conversation row", async () => {
    const build = (id: string, date: string) =>
      letter(id, {
        threadId: "studio_plan",
        subject: "Studio plans",
        unread: false,
        date,
        arrivedAt: date,
        triage: { messageId: id, state: "set_aside", bubbleUpAt: null, setAt: date, updatedAt: date },
      });
    const older = build("older", "2026-11-17T12:00:00Z");
    const { address } = listSeat({
      first: "#/triage/aside/m/older",
      letters: [older, build("newest", "2026-11-18T12:00:00Z")],
      more: {
        "rule:known_sender": {
          id: "known_sender",
          kind: "sender",
          match: older.from.address,
          destination: "INBOX",
          priority: 0,
          enabled: true,
          provenance: "manual",
          createdAt: older.date,
          updatedAt: older.date,
          stats: { hits: 0, lastHitAt: null, demotions: 0 },
        },
      },
    });
    await act(async () => undefined);
    const rows = within(screen.getByRole("listbox", { name: "Parked" })).getAllByRole("option");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute("aria-selected")).toBe("true");
    expect(address.read()).toBe("#/triage/aside/m/newest");
  });

  it("shows the live Reply Run in the Reader, with Skip and Exit that leave mail alone", async () => {
    const { address, mail } = listSeat({ letters: LETTERS, first: "#/triage" });
    await settled();
    fireEvent.click(screen.getByRole("button", { name: /Reply Run/ }));
    await settled();
    expect(address.read()).toBe("#/triage/m/reply");
    await reading().findByRole("textbox", { name: "Reply body" }); // the reply's editor loads its own code; the run's count is read once the reply is ready
    const run = () => reading().getByRole("toolbar", { name: "Reply run" });
    expect(reading().getByRole("status").textContent).toBe("1 of 2");
    fireEvent.click(within(run()).getByRole("button", { name: "Skip" }));
    await settled();
    expect(address.read()).toBe("#/triage/m/reply_other");
    expect(reading().getByRole("status").textContent).toBe("2 of 2");
    fireEvent.click(within(run()).getByRole("button", { name: "Exit" }));
    await settled();
    expect(reading().queryByRole("toolbar", { name: "Reply run" })).toBeNull();
    expect(sent(mail)).toEqual([]);
  });

  it("the phone reader's Back ends Reply Run and retains its reply words", async () => {
    const { address } = listSeat({ letters: LETTERS, first: "#/triage", room: "phone" });
    await settled();
    const start = () => screen.getByRole("button", { name: "Reply Run" });
    fireEvent.click(start());
    await settled();
    const reader = () => within(screen.getByRole("dialog", { name: "Reading" }));
    const reply = () => reader().getByRole("textbox", { name: "Reply body" });
    await reader().findByRole("textbox", { name: "Reply body" }); // the reply's editor loads its own code before it can hold words
    const editor = (reply() as HTMLElement & { editor: Editor }).editor;
    await act(async () => {
      editor.commands.setContent("<p>Keep these reply words</p>");
    });
    fireEvent.click(reader().getByRole("button", { name: /^Back$|^Answer Later$/ }));
    await settled();
    expect(address.read()).toBe("#/triage");
    fireEvent.click(start());
    await settled();
    expect(reply().textContent).toBe("Keep these reply words");
  });

  it("Done in Resurface clears the selected booking before the deliberate read", async () => {
    const { mail } = listSeat({ letters: LETTERS, first: "#/triage/resurface" });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await settled();
    expect(sent(mail)).toEqual(["triage_set booked none", "mark_seen booked read"]);
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  });
});
