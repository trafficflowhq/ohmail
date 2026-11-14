/** @vitest-environment jsdom */
import type { EngineDraft } from "@ohmail/wire";
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountShell, press, stubDom, unmountAll, waitFor } from "./_draft-shell.js";

/**
 * ═══ A SEND THAT DID NOT CONFIRM IS FINDABLE, SAYS SO, AND CAN BE RECOVERED ══════════════
 *
 * ── THE LOSS THIS CLOSES ─────────────────────────────────────────────────────────────────
 *
 * An `unverified` send — SMTP threw AND the server's Sent-folder probe found nothing — leaves
 * its full text in a draft row and appends nothing to any Sent folder. The Drafts list used to
 * filter to `status === "draft"`, so after the compose sheet closed NO surface anywhere named
 * the state: the user, told to "check your Sent folder", found nothing there, found nothing in
 * Drafts either, and concluded the message was gone. Seen on a live account: a send went
 * `unverified` and its only copy sat in a row no list showed.
 *
 * `draftsList` now surfaces those rows (and `sending` rows old enough that no send can still
 * be running) — that inclusion is pinned in `compose-autosave.test.tsx` beside the selector's
 * other consumers. What THIS file pins is the surface: the row must SAY what is and is not
 * known, in the row, before any press — and the saying must survive a refactor, which is what
 * the mutation runs below measured.
 *
 * ── RECOVERY IS A FRESH ROW, STRUCTURALLY ────────────────────────────────────────────────
 *
 * `SendService.reserve` sends only a `status='draft'` row, so "open it to send again" cannot
 * mean adopting the stranded row — every retry would 409 forever (the compose surface had
 * exactly that defect: after an `unverified` outcome the plan still carried the row's id, and
 * the deliberate second press the warning invites answered "draft cannot be sent from status
 * 'unverified'"). The shell therefore seeds the TEXT, lets autosave write a fresh row, and
 * discards the stranded one only when the fresh send CONFIRMS. Those are shell decisions
 * (`AppShell.openDraft` / `sendCompose` / `onSendSettled`, the `recoverySeed` ref), pinned
 * structurally below the way `compose-autosave.test.tsx` pins the autosave wiring.
 */

const draft = (over: Partial<EngineDraft> = {}): EngineDraft => ({
  id: "d1",
  mailboxId: "mb-1",
  threadId: null,
  inReplyToMessageId: null,
  subject: "Invoice for the paper order",
  body: "The only copy of this text lives in this row.",
  to: [{ name: null, address: "sam@customer.example" }],
  cc: [],
  bcc: [],
  rationale: null,
  status: "draft",
  createdAt: "2026-08-07T09:00:00.000Z",
  updatedAt: "2026-08-07T14:02:00.000Z",
  ...over,
});

beforeEach(stubDom);
afterEach(unmountAll);

const row = async (subject: string): Promise<HTMLElement> =>
  screen.findByRole("option", { name: new RegExp(subject) });

describe("the row says what is and is not known", () => {
  /**
   * ══ THE CENTRAL GUARD ══════════════════════════════════════════════════════════════════
   *
   * Mutation: drop the `d.status !== "draft"` block from the registered Drafts list. Real failure text:
   *   AssertionError: an unverified send carries no state line — the row is indistinguishable
   *   from an ordinary draft: expected null not to be null
   */
  it("an unverified row carries the not-confirmed line; an ordinary draft carries none", async () => {
    await mountShell("#/drafts", [], [
      draft({ id: "u1", subject: "Invoice awaiting confirmation", status: "unverified" }),
      draft({ id: "p1", subject: "Ordinary invoice draft", updatedAt: "2026-08-07T13:00:00.000Z" }),
    ]);

    const held = await row("Invoice awaiting confirmation");
    const ordinary = await row("Ordinary invoice draft");
    expect(screen.getAllByRole("option")).toHaveLength(2);
    const state = within(held.parentElement!.parentElement!).queryByRole("status");
    expect(
      state,
      "an unverified send carries no state line — the row is indistinguishable from an ordinary draft",
    ).not.toBeNull();
    // The sentence states uncertainty and points at Sent — never "failed", never a claim it went.
    expect(state!.textContent).toMatch(/not sure this was sent/i);
    expect(state!.textContent).toMatch(/sent folder/i);
    // Out of band, so it must reach a screen reader without focus near it.
    expect(state!.getAttribute("role")).toBe("status");
    // The ordinary draft says nothing.
    expect(within(ordinary.parentElement!.parentElement!).queryByRole("status")).toBeNull();
  });

  it("a stranded `sending` row carries the interrupted line instead", async () => {
    await mountShell("#/drafts", [], [draft({ id: "s1", status: "sending" })]);
    const held = await row("Invoice for the paper order");
    const description = held.getAttribute("aria-description");
    expect(description, "a stranded send carries no announced state").not.toBeNull();
    expect(description).toMatch(/interrupted/i);
  });

  it("an unverified row still opens and still discards — recovery needs both verbs", async () => {
    const shell = await mountShell("#/drafts", [], [draft({ id: "u1", status: "unverified" })]);
    const held = await row("Invoice for the paper order");
    await press(held, "the held draft");
    await screen.findByRole("button", { name: "Send again" });
    expect(window.location.hash).toBe("#/drafts/m/u1");

    await press(within(held.parentElement!).getByRole("button", { name: "Discard" }), "Discard");
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(shell.sent.filter(({ kind }) => kind === "draft_discard")).toEqual([]);
    await waitFor(() => shell.sent.some(({ kind }) => kind === "draft_discard"), "one discard when Undo closes", 450);
    expect(shell.sent.filter(({ kind }) => kind === "draft_discard")).toEqual([{ kind: "draft_discard", draftId: "u1", ifUpdatedAt: draft({ id: "u1" }).updatedAt }]);
    expect(shell.sent.filter(({ kind }) => kind === "mail_send")).toEqual([]);
  }, 20_000);
});
