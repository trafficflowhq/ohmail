/** @vitest-environment jsdom */
import type { EngineDraft } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { DraftsView } from "../app/views/DraftsView";

/**
 * ═══ WHAT THE DRAFTS SCREEN SAYS AFTER A HANDOVER ════════════════════════════════════════
 *
 * `QAO-SCHEDULED-SEND-ORPHANED-BY-MIGRATION`'s surface half, and the reason the row is HIGH
 * rather than a bookkeeping note. The measured screen:
 *
 *   Scheduled
 *   Invoice for the paper order        Sends Tue 14:50
 *
 * for a Tuesday 14:50 that had gone, on an install that could never send it and would never say
 * so. `scheduleLabel` prints a past instant as an ordinary weekday and clock with no past-tense
 * marker, so the promise renders identically before and after its own moment — for ever.
 *
 * The fix does not touch this view. It makes the ROW true, and this file is the assertion that a
 * true row renders as the truth on this client: the appointment leaves the "Scheduled" list
 * entirely, lands in Drafts under the standing `scheduleFailedNote` frame, and quotes the
 * server's sentence. That is the send-window contract's existing shape for a schedule that could
 * not be kept (`send_error` is schedule-only; a failed schedule wears the sentence), reused
 * rather than extended — which is why no new copy key was needed on this surface.
 *
 * ── HOW TO WATCH IT FAIL ─────────────────────────────────────────────────────────────────
 *
 * Delete the `d.status === "draft" && d.sendError` note from `DraftsView` and the second case
 * goes red with the row carrying no sentence at all — a message the person was promised would
 * send, sitting silently in Drafts. Run.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const NOW = new Date("2026-09-01T15:00:00.000Z");
/**
 * `STAND_DOWN_SEND_SENTENCES["organized_elsewhere:cloud"]`, written out rather than imported.
 *
 * This app does not depend on `@trafficflow/db` and must not start to for a test — the browser
 * bundle has no business naming the server's schema package, and `pnpm -F @ohmail/webapp
 * typecheck`, which DOES typecheck this directory, would not resolve it. The drift that invites is
 * closed from the other side: `packages/db/test/stand-down-sends-census.test.ts` reads THIS FILE
 * and asserts the sentence quoted here is the one the database stores.
 */
const SENTENCE =
  "ohmail Cloud took over organizing this mailbox, so the scheduled send was not made here. "
  + "Schedule it again where the mailbox is organized now.";

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
  createdAt: "2026-09-01T09:00:00.000Z",
  updatedAt: "2026-09-01T14:29:00.000Z",
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(drafts: EngineDraft[], scheduled: EngineDraft[]): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        now: NOW,
        children: h(DraftsView, {
          settled: true,
          owed: false,
          drafts,
          scheduled,
          now: NOW,
          onOpen: () => {},
          onDiscard: () => {},
          onResolve: () => {},
          onCancelSchedule: () => {},
          onEditScheduled: () => {},
          onSendAgain: () => {},
          repliesHere: () => false,
        }),
      }),
    );
  });
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
});

describe("a scheduled send a handover ended", () => {
  it("BEFORE the fix the screen promises a time that has gone", async () => {
    // The orphan, rendered. This is not a guard on new code — it is the measurement, kept, so
    // that the case below is legible as the change and so that a future edit to `scheduleLabel`
    // cannot quietly make a past appointment read as a future one somewhere else.
    await mount([], [draft({ status: "scheduled", sendAt: "2026-09-01T14:50:00.000Z" })]);
    const text = host!.textContent ?? "";
    expect(text).toContain("Scheduled");
    // The CLOCK, matched as a shape rather than as a literal: `scheduleLabel` renders in the
    // reader's own zone (`activeFormatZone()`, which this provider does not drive), so a literal
    // "14:50" would be an assertion about the machine running the suite. The claim is that a PAST
    // instant renders with no past-tense marker at all — the same "Sends {when}" a future one
    // gets, here the clock alone because the instant is earlier the same day.
    expect(text, "the measured sentence: a past instant printed as a plain clock")
      .toMatch(/Sends \d{2}:\d{2}/);
  });

  it("AFTER it the row is an ordinary draft that says it was not sent, and why", async () => {
    // Exactly what `closeStoodDownAppointments` leaves: `status:'draft'`, no `sendAt`, the
    // sentence in `sendError`. The shared `draftsList` selector puts such a row in Drafts and the
    // `scheduled` list is empty, which is what removes the promise from the screen.
    await mount([draft({ sendError: SENTENCE })], []);
    const text = host!.textContent ?? "";

    // The promise is GONE — no heading, no "Sends", no time.
    expect(text, "the appointment is still being promised").not.toMatch(/Sends \w/);
    // And the section itself is gone — `DraftsView` renders the heading only for a non-empty
    // list, so an empty one takes the promise off the screen rather than leaving an empty shelf.
    expect(text, "the Scheduled section is still on screen with nothing in it")
      .not.toMatch(/Scheduled[A-Z]/);

    // And the row says what happened, in the frame this surface already had.
    expect(text).toContain(
      "This message wasn't sent at its scheduled time: ohmail Cloud took over organizing this "
      + "mailbox, so the scheduled send was not made here. Schedule it again where the mailbox "
      + "is organized now.",
    );
    // The message itself is still here — the whole point of failing rather than dropping it.
    expect(text).toContain("Invoice for the paper order");
  });
});
