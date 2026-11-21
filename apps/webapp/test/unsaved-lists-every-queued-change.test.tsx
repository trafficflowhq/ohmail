/** @vitest-environment jsdom */
/**
 * THE PANEL LISTS EVERY CHANGE THAT HAS NOT GONE THROUGH, EACH WITH ITS OWN REASON.
 *
 * A user's mail (2026-10-01): "N changes have not gone through yet" until a restart, and Screener
 * decisions not saved. The panel read the queued DISCARDS only, so a waiting Screener decision was
 * listed nowhere, and every row said "This browser could not reach your account" whatever its
 * last attempt had met. The pure half, props in and markup out: what a person reads per row.
 * Mutations: `queuedReason` answering the reach sentence for everything → cases 1, 2, 4 and 6 red;
 * the server's own sentence dropped → case 2 red.
 */
import type { EngineMutation } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { TextProvider } from "@ohmail/app/text";
import type { QueuedChange } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { UnsavedListOf, unsavedTitle } from "../../../packages/app/src/mail/ground/UnsavedList.js";
import { copyRefused, type MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { createTranslator } from "next-intl";

const S = messages.sync;
const words = createTranslator({ locale: "en", messages });
afterEach(cleanup);

const queued = (
  id: string, kind: string, error: { code: string | null; message: string; status: number | null } | null,
): QueuedChange => ({ id, key: `key-${id}`, mutation: { kind } as unknown as EngineMutation, error });

/** The panel, opened: one `[label, reason]` per listed row. */
function rowsOf(changes: readonly QueuedChange[], mailboxes: MailboxFacts[] | null = null): Array<[string, string]> {
  render(
    <TextProvider locale="en" messages={messages} timeZone="UTC">
      <UnsavedListOf
        open
        onClose={() => {}}
        title={unsavedTitle(words, 0, changes.length) ?? ""}
        abandoned={[]}
        queued={changes}
        held={copyRefused(mailboxes) ? messages.mailboxes.desktopStateStoreRefused : undefined}
        onRetry={async (id) => ({ id, key: id, status: "confirmed", seq: 1 })}
        onDiscard={async () => {}}
        onRetryQueued={async () => null}
        onDiscardQueued={async () => {}}
      />
    </TextProvider>,
  );
  return within(screen.getByRole("dialog")).getAllByRole("listitem").map((row) => {
    const line = row.querySelector("p")!;
    return [line.children[0]?.textContent ?? "", line.children[1]?.textContent ?? ""];
  });
}

describe("the Unsaved changes panel over the queue", () => {
  it("1 — a Screener decision waiting behind another change is listed, and says it has not been sent", () => {
    expect(rowsOf([queued("a", "screener_decide", null)])).toEqual([[S.unsavedKindScreener, S.unsavedQueuedWaiting]]);
    expect(screen.getByRole("dialog").textContent).toContain("1 change has not gone through yet");
  });

  it("2 — a rule refused with a 503 says the server's own sentence, and an opaque refusal says so plainly", () => {
    expect(rowsOf([
      queued("r1", "rule_create", { code: "unavailable", message: "The service is busy. Try again in a minute.", status: 503 }),
      queued("r2", "rule_create", { code: "internal", message: "internal error", status: 500 }),
    ])).toEqual([
      [S.unsavedKindRule, "The service is busy. Try again in a minute."],
      [S.unsavedKindRule, S.unsavedQueuedServerWhy],
    ]);
  });

  it("3 — a discard that could not reach the account, or met no answer, keeps the reach sentence", () => {
    expect(rowsOf([
      queued("d1", "draft_discard", { code: "network", message: "network failure: TypeError", status: null }),
      queued("d2", "draft_discard", { code: "timeout", message: "no answer within 75000 ms", status: null }),
      queued("d3", "draft_discard", { code: "offline_read_only", message: "the session could not be renewed", status: 503 }),
    ])).toEqual([
      [S.unsavedKindDraftDiscard, S.unsavedQueuedWhy],
      [S.unsavedKindDraftDiscard, S.unsavedQueuedWhy],
      [S.unsavedKindDraftDiscard, S.unsavedQueuedWhy],
    ]);
  });

  it("4 — a press kept across a sign-out says why it is kept, in its own sentence", () => {
    expect(rowsOf([queued("k", "screener_decide", { code: "not_signed_in", message: S.keptSessionEnded, status: 409 })]))
      .toEqual([[S.unsavedKindScreener, S.keptSessionEnded]]);
  });

  it("5 — every kind of queued change is listed with its kind and counted", () => {
    const rows = rowsOf([
      queued("a", "screener_decide", null),
      queued("b", "rule_create", { code: "unavailable", message: "busy", status: 503 }),
      queued("c", "draft_discard", { code: "network", message: "x", status: null }),
      queued("d", "move", null),
    ]);
    expect(rows.map(([label]) => label)).toEqual([
      S.unsavedKindScreener, S.unsavedKindRule, S.unsavedKindDraftDiscard, S.unsavedKindMove,
    ]);
    expect(screen.getByRole("dialog").textContent).toContain("4 changes have not gone through yet");
  });

  it("6 — while this computer's copy refuses its own pull, a change the door held offline says so, not the reach sentence", () => {
    const stuck = { id: "mb", address: "a", status: "error", errorCode: "storage", errorDetail: "MIRROR_STORE_REFUSED" } as MailboxFacts;
    expect(rowsOf([
      queued("o", "move", { code: "offline_read_only", message: "this install is offline", status: 503 }),
      queued("n", "move", { code: "network", message: "network failure: TypeError", status: null }),
    ], [stuck])).toEqual([
      [S.unsavedKindMove, messages.mailboxes.desktopStateStoreRefused],
      [S.unsavedKindMove, S.unsavedQueuedWhy],
    ]);
  });
});
