/** @vitest-environment jsdom */
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { act, message, mountShell, ROSTER, storeWith, stubDom, unmountAll, waitFor } from "../_draft-shell.js";

const updatedAt = "2026-11-01T00:00:00.000Z";
const rail = () => screen.getByRole("navigation", { name: "Places" });

/** The registered rails read tags and pile counts from the same mirror as the list. */
async function mountTaggedMail() {
  const messages = ["m1", "m2", "m3"].map((id, index) => message(id, {
    labels: ["t-1"],
    triage: index < 2 ? { messageId: id, state: "set_aside", setAt: updatedAt, updatedAt, bubbleUpAt: null } : null,
  }));
  const store = await storeWith(messages, []);
  await store.applyChanges([{
    type: "tag", op: "create", id: "t-1", seq: 50_000, updatedAt,
    entity: { id: "t-1", name: "Receipts 2026", hue: "teal", createdAt: updatedAt, updatedAt },
  }]);
  await mountShell("#/ohbox", messages, [], { store });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  stubDom();
});
afterEach(unmountAll);

describe("today's rail, fed to the frame", () => {
  it("folds the tags as today's rail did, and offers a new tag in place", async () => {
    await mountTaggedMail();
    expect(within(rail()).queryByRole("button", { name: "Receipts 2026 3" })).toBeNull();
    fireEvent.click(within(rail()).getByRole("button", { name: "Tags", expanded: false }));
    await unmountAll();
    stubDom();
    await mountTaggedMail();
    expect(within(rail()).getByRole("button", { name: "Receipts 2026 3" })).toBeTruthy();
    fireEvent.click(within(rail()).getByRole("button", { name: "Tags" }));
    expect(within(rail()).queryByRole("button", { name: "Receipts 2026 3" })).toBeNull();
    await unmountAll();
    stubDom();
    await mountTaggedMail();
    expect(within(rail()).queryByRole("button", { name: "Receipts 2026 3" })).toBeNull();
    expect(within(rail()).getByRole("button", { name: "Tags" }).getAttribute("aria-expanded")).toBe("false");
  });
});

describe("a row dragged to the fed rail", () => {
  it("still finds its targets: a pile by the rail's id, a tag by its own", async () => {
    await mountTaggedMail();
    fireEvent.click(within(rail()).getByRole("button", { name: "Tags", expanded: false }));
    const pile = within(rail()).getByRole("button", { name: "Parked 2" });
    const tag = within(rail()).getByRole("button", { name: "Receipts 2026 3" });
    const group = within(rail()).getByRole("button", { name: "Tags" });
    expect(pile.closest("[data-rail-drop]")?.getAttribute("data-rail-drop")).toBe("aside");
    expect(tag.closest("[data-rail-tag-id]")?.getAttribute("data-rail-tag-id")).toBe("t-1");
    expect(group.closest("[data-rail-drop],[data-rail-tag-id]")).toBeNull();
  });
});

describe("today's strips, as notices in the one slot", () => {
  it("says who stopped organizing a mailbox, with its two answers, and Dismiss sends the acknowledgement", async () => {
    const acknowledge = vi.fn(async () => undefined);
    const mailbox = {
      ...ROSTER[0], id: "mb-1", address: "lena@example.com", organizerRole: "reader",
      organizedBy: { kind: "local", name: "Kestrel", since: updatedAt },
      organizeConsentedAt: null, organizerState: "stopped", organizerEventAt: updatedAt, organizerEventSeenAt: null,
    } as MailboxFacts;
    await mountShell("#/ohbox", [message("m1")], [], {
      roster: [mailbox], mailboxNotices: { organizerNotice: acknowledge },
    });
    await waitFor(() => screen.queryByText(/Kestrel stopped organizing lena@example.com/) !== null, "the organizer notice");
    const said = screen.getByText(/Kestrel stopped organizing lena@example.com/).closest<HTMLElement>('[role="status"]')!;
    expect(within(said).getByRole("button", { name: "Mailboxes" })).toBeTruthy();
    await act(async () => { fireEvent.click(within(said).getByRole("button", { name: "Dismiss" })); });
    expect(acknowledge).toHaveBeenCalledWith("mb-1");
    expect(screen.queryByText(/Kestrel stopped organizing/)).toBeNull();
  });

  it("offers the letters a gap left behind, and an answer reaches the mailbox with both counts", async () => {
    const answer = vi.fn(async () => undefined);
    const mailbox = { ...ROSTER[0], id: "mb-1", gapLetters: 4, gapStrangers: 0 } as MailboxFacts;
    await mountShell("#/ohbox", [message("m1")], [], {
      roster: [mailbox], mailboxNotices: { gapLetters: answer },
    });
    const file = await screen.findByRole("button", { name: /File them/ });
    await act(async () => { fireEvent.click(file); });
    expect(answer).toHaveBeenCalledWith("mb-1", { file: true, count: 4, strangers: 0 });
  });
});
