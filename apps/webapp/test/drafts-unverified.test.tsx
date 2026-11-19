/** @vitest-environment jsdom */
import type { EngineDraft } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { DraftsView } from "../app/views/DraftsView";

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

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

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

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let opened: string[] = [];
let discarded: string[] = [];

async function mountDrafts(drafts: EngineDraft[]): Promise<void> {
  opened = [];
  discarded = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        now: new Date("2026-08-07T15:00:00.000Z"),
        children: h(DraftsView, {
          settled: true,
          owed: false,
          drafts,
          scheduled: [],
          now: new Date("2026-08-07T15:00:00.000Z"),
          onOpen: (d: EngineDraft) => { opened.push(d.id); },
          onDiscard: (id: string) => { discarded.push(id); },
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

const q = <T extends Element>(sel: string): T | null => host!.querySelector<T>(sel);
const qa = (sel: string): Element[] => Array.from(host!.querySelectorAll(sel));
const press = async (el: HTMLElement): Promise<void> => { await act(async () => { el.click(); }); };

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
});

describe("the row says what is and is not known", () => {
  /**
   * ══ THE CENTRAL GUARD ══════════════════════════════════════════════════════════════════
   *
   * Mutation: drop the `d.status !== "draft"` block from `DraftsView`. Real failure text:
   *   AssertionError: an unverified send carries no state line — the row is indistinguishable
   *   from an ordinary draft: expected null not to be null
   */
  it("an unverified row carries the not-confirmed line; an ordinary draft carries none", async () => {
    await mountDrafts([
      draft({ id: "u1", status: "unverified" }),
      draft({ id: "p1", updatedAt: "2026-08-07T13:00:00.000Z" }),
    ]);

    const rows = qa(".draft-row");
    expect(rows).toHaveLength(2);
    const state = q<HTMLElement>('.draft-row[data-id="u1"] .draft-state');
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
    expect(q('.draft-row[data-id="p1"] .draft-state')).toBeNull();
  });

  it("a stranded `sending` row carries the interrupted line instead", async () => {
    await mountDrafts([draft({ id: "s1", status: "sending" })]);
    const state = q<HTMLElement>('.draft-row[data-id="s1"] .draft-state');
    expect(state, "a stranded send carries no state line").not.toBeNull();
    expect(state!.textContent).toMatch(/interrupted/i);
  });

  it("an unverified row still opens and still discards — recovery needs both verbs", async () => {
    await mountDrafts([draft({ id: "u1", status: "unverified" })]);

    await press(q<HTMLButtonElement>('.draft-row[data-id="u1"] .draft-open')!);
    expect(opened, "the stranded row cannot be opened, so its text cannot be recovered")
      .toEqual(["u1"]);

    await press(q<HTMLButtonElement>('.draft-row[data-id="u1"] .draft-discard')!);
    // The destructive button by its label: Keep comes first in the confirm, on purpose.
    await press(
      Array.from(host!.querySelectorAll<HTMLButtonElement>(".draft-confirm button"))
        .find((b) => (b.textContent ?? "").trim() === "Discard")!,
    );
    expect(discarded, "the stranded row cannot be discarded").toEqual(["u1"]);
  });
});
