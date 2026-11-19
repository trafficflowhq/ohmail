/** @vitest-environment jsdom */
/**
 * THE CHANGES THAT DID NOT GO THROUGH, LISTED (the switch's point 66): what the `unsaved` notice's "Show
 * them" opens, the kit's dialog with one row a change. Each says what the person was doing and why it did not go
 * through, with Try again and Discard: a given-up change re-queued under its own key, or thrown away; a waiting one
 * retried now, or withdrawn by its key (a withdrawn draft delete is never sent). No Try again where a newer change
 * replaced it. A retry's answer is said in its row, and where it took the row away (a send that may have left), over
 * the answers.
 */
import type { EngineMutation } from "@ohmail/wire";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AbandonedMutation, MutationResult, QueuedChange } from "@ohmail/client-engine";
import { UnsavedListOf, type UnsavedListProps } from "../../src/mail/ground/UnsavedList.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import frameEn from "../../messages/frame.en.json" with { type: "json" };
import mailboxesEn from "../../messages/mailboxes.en.json" with { type: "json" };

/** The list's words: the sync namespace of the frame's file, and the mailboxes' one sentence it borrows. */
const WORDS = { sync: frameEn.sync, mailboxes: mailboxesEn.mailboxes } as unknown as Messages;
const S = frameEn.sync;
const given = (id: string, kind: string, over: Partial<AbandonedMutation> = {}): AbandonedMutation =>
  ({
    id,
    key: `key-${id}`,
    mutation: { kind } as unknown as EngineMutation,
    error: { code: "policy", message: "The server kept refusing this.", status: 422 },
    retryable: true,
    superseded: false,
    ...over,
  }) as unknown as AbandonedMutation;
const waiting = (id: string, kind: string, error: QueuedChange["error"] = null): QueuedChange => ({
  id,
  key: `key-${id}`,
  mutation: { kind } as unknown as EngineMutation,
  error,
});
const confirmed = (id: string, over: Partial<MutationResult> = {}): MutationResult =>
  ({ id, key: `key-${id}`, status: "confirmed", seq: 1, ...over }) as MutationResult;

const pressed: string[] = [];
function list(over: Partial<UnsavedListProps>) {
  const props: UnsavedListProps = {
    open: true,
    onClose: () => pressed.push("close"),
    title: "2 changes could not be saved",
    abandoned: [],
    queued: [],
    onRetry: async (id) => {
      pressed.push(`retry:${id}`);
      return confirmed(id);
    },
    onDiscard: async (id) => void pressed.push(`discard:${id}`),
    onRetryQueued: async (id) => {
      pressed.push(`retryQueued:${id}`);
      return null;
    },
    onDiscardQueued: async (key) => void pressed.push(`withdraw:${key}`),
    ...over,
  };
  const view = (p: UnsavedListProps) => (
    <TextProvider locale="en" messages={WORDS} timeZone="Europe/Zurich">
      <UnsavedListOf {...p} />
    </TextProvider>
  );
  const { rerender } = render(view(props));
  return { again: (next: Partial<UnsavedListProps>) => rerender(view({ ...props, ...next })) };
}
const rows = () => screen.queryAllByRole("listitem");
const rowText = () => rows().map((r) => r.textContent ?? "");
const answers = (row: HTMLElement) =>
  within(row)
    .queryAllByRole("button")
    .map((b) => b.textContent);
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

beforeEach(() => {
  pressed.length = 0;
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("the list of the changes that did not go through", () => {
  it("lists each change with what it was and why, given-up and waiting alike, under the notice's sentence", () => {
    list({
      abandoned: [given("a", "move")],
      queued: [
        waiting("b", "screener_decide"),
        waiting("c", "draft_discard", { code: "network", message: "", status: null }),
        waiting("d", "rule_create", { code: "internal", message: "internal error", status: 500 }),
      ],
    });
    expect(screen.getByRole("dialog").textContent).toContain("2 changes could not be saved");
    const said = rowText();
    expect(said[0]).toContain(S.unsavedKindMove);
    expect(said[0]).toContain("The server kept refusing this.");
    expect(said[1]).toContain(S.unsavedKindScreener);
    expect(said[1]).toContain(S.unsavedQueuedWaiting);
    expect(said[2]).toContain(S.unsavedKindDraftDiscard);
    expect(said[2]).toContain(S.unsavedQueuedWhy);
    expect(said[3]).toContain(S.unsavedQueuedServerWhy);
    for (const row of rows()) expect(answers(row)).toEqual([S.unsavedRetry, S.unsavedDiscard]);
  });

  it("offers no Try again where a newer change replaced it, nor where the refusal is kept; says the server gave no reason", () => {
    list({
      abandoned: [
        given("a", "tag_assign", { superseded: true, retryable: false }),
        given("b", "folder_create", {
          retryable: false,
          error: { code: null, message: "", status: 500 },
        } as never),
      ],
    });
    const [first, second] = rows();
    expect(first!.textContent).toContain(S.unsavedSuperseded);
    expect(answers(first!)).toEqual([S.unsavedDiscard]);
    expect(second!.textContent).toContain(S.unsavedNoReason);
    expect(answers(second!)).toEqual([S.unsavedDiscard]);
  });

  it("Try again and Discard answer the given-up change by its id; the waiting one is retried by id and withdrawn by its key", async () => {
    list({ abandoned: [given("a", "move")], queued: [waiting("b", "draft_discard")] });
    const [a, b] = rows();
    fireEvent.click(within(a!).getByRole("button", { name: S.unsavedRetry }));
    await flush();
    fireEvent.click(within(a!).getByRole("button", { name: S.unsavedDiscard }));
    await flush();
    fireEvent.click(within(b!).getByRole("button", { name: S.unsavedRetry }));
    await flush();
    fireEvent.click(within(b!).getByRole("button", { name: S.unsavedDiscard }));
    await flush();
    expect(pressed).toEqual(["retry:a", "discard:a", "retryQueued:b", "withdraw:key-b"]);
  });

  it("says a retry's refusal in its row, and a waiting change's refusal in its own", async () => {
    list({
      abandoned: [given("a", "move")],
      queued: [waiting("b", "rule_create")],
      onRetry: async (id) =>
        ({
          ...confirmed(id),
          status: "rolled_back",
          error: { code: "gone", message: "That folder is gone." },
        }) as never,
      onRetryQueued: async (id) =>
        ({
          ...confirmed(id),
          status: "rolled_back",
          error: { code: "rule", message: "That rule is refused." },
        }) as never,
    });
    fireEvent.click(within(rows()[0]!).getByRole("button", { name: S.unsavedRetry }));
    await flush();
    expect(rowText()[0]).toContain("That folder is gone.");
    fireEvent.click(within(rows()[1]!).getByRole("button", { name: S.unsavedRetry }));
    await flush();
    expect(rowText()[1]).toContain("That rule is refused.");
  });

  it("a retried send whose key had already gone is said once, over the answers, after its row left; nothing is sent again", async () => {
    const shown = list({
      abandoned: [given("s", "mail_send")],
      onRetry: async (id) => {
        pressed.push(`retry:${id}`);
        return confirmed(id, { firstSend: { at: "2026-09-27T08:00:00.000Z" } } as never);
      },
    });
    fireEvent.click(within(rows()[0]!).getByRole("button", { name: S.unsavedRetry }));
    await flush();
    shown.again({ abandoned: [] });
    expect(rows()).toEqual([]);
    expect(screen.getByRole("dialog").textContent).toContain(S.unsavedSendAlreadyWent);
    expect(pressed).toEqual(["retry:s"]);
  });

  it("closes by its way out; nothing listed and nothing to say draws no dialog", () => {
    const shown = list({ queued: [waiting("b", "move")] });
    fireEvent.click(screen.getByRole("button", { name: S.unsavedHide }));
    expect(pressed).toEqual(["close"]);
    shown.again({ queued: [] });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
