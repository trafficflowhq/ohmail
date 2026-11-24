/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createTranslator } from "next-intl";
import { screen, within } from "@testing-library/react";
import { TextProvider } from "@ohmail/app/text";
import { ApiError } from "../app/api-client";
import messages from "../messages/en.json";
import type { MutationResult } from "@ohmail/client-engine";
import { UnsavedListOf, unsavedTitle } from "../../../packages/app/src/mail/ground/UnsavedList.js";

/**
 * THE "COULD NOT BE SAVED" STRIP, and the failure state on the drafted-reply button.
 *
 * Both exist because of one defect with two ends. `GET /drafts/:id` answered `500 internal error`
 * to an id it could not parse; the engine's outbox classifies any unhandled 500 as retryable and
 * used to re-queue it for ever, and the drafted-reply button rendered the server's own
 * `"internal error"` and re-offered itself. The server end is fixed. These are the client end: a
 * bounded queue has to SAY when it gives up, and a surface has to say something usable when the
 * server does not.
 *
 * The strip's absence at zero is asserted first, deliberately — a strip that is always present
 * reading "0 changes could not be saved" is a control that lies about the state it describes, and
 * it is the version of this feature that would pass a careless test.
 */

// The house convention for a component test in this suite: without it React logs "the current
// testing environment is not configured to support act(...)" on every render, and a real warning
// added later would be lost in the noise.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  host?.remove();
  host = null;
});

function mkAbandoned(rows: Array<{
  id: string; kind: string; message: string; code: string | null; status: number | null;
  superseded?: boolean; retryable?: boolean; refusedCode?: string | null;
}>) {
  return rows.map((r) => ({
    id: r.id,
    key: `key-${r.id}`,
    mutation: { kind: r.kind } as never,
    at: 1,
    attempts: 8,
    error: { message: r.message, code: r.code, status: r.status },
    superseded: r.superseded ?? false,
    retryable: r.retryable ?? !(r.superseded ?? false),
    refusedCode: r.refusedCode ?? ((r.superseded ?? false) ? "outbox_superseded" : null),
  }));
}

const words = createTranslator({ locale: "en", messages });
const fixed = { queued: [], onClose: () => {}, onRetryQueued: async () => null, onDiscardQueued: async () => {} };
const dialog = () => screen.queryByRole("dialog");

function render(
  rows: ReturnType<typeof mkAbandoned>,
  acts: {
    onRetry?: (id: string) => Promise<MutationResult>;
    onDiscard?: (id: string) => Promise<void>;
  } = {},
  open = true,
) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <TextProvider locale="en" messages={messages} timeZone="UTC">
        <UnsavedListOf
          {...fixed}
          open={open}
          title={unsavedTitle(words, rows.length, 0) ?? ""}
          abandoned={rows}
          onRetry={acts.onRetry ?? (async (id) => ({ id, key: id, status: "confirmed" as const, seq: 1 }))}
          onDiscard={acts.onDiscard ?? (async () => {})}
        />
      </TextProvider>,
    );
  });
  return host!;
}

describe("the changes-that-did-not-land strip", () => {
  it("counts what was abandoned and lists each one behind a disclosure", () => {
    const rows = mkAbandoned([
      { id: "a", kind: "mail_send", message: "internal error", code: "internal", status: 500 },
      { id: "b", kind: "move", message: "that folder is gone", code: "not_found", status: 404 },
    ]);
    expect(unsavedTitle(words, rows.length, 0)).toBe("2 changes could not be saved");
    const closed = render(rows, {}, false);
    expect(dialog()).toBeNull();
    act(() => { root!.unmount(); });
    closed.remove();

    const opened = render(rows);
    expect(dialog()!.textContent).toContain("2 changes could not be saved");
    expect(within(dialog()!).getAllByRole("listitem")).toHaveLength(2);
    expect(opened.textContent).toContain("Sending a message");
    expect(opened.textContent).toContain("Filing a message");
  });

  it("quotes a server sentence a person can act on, and refuses to quote one they cannot", () => {
    const el = render(mkAbandoned([
      { id: "a", kind: "move", message: "that folder is gone", code: "not_found", status: 404 },
      { id: "b", kind: "mail_send", message: "internal error", code: "internal", status: 500 },
    ]));

    // A real refusal is passed through verbatim — the code that made the decision wrote it.
    expect(el.textContent).toContain("that folder is gone");
    // An unhandled fault is NOT. Putting the words "internal error" in front of a person is the
    // app quoting itself; this says what is actually known instead.
    expect(el.textContent).not.toContain("internal error");
    expect(el.textContent).toContain("The server refused it and did not say why.");
  });

  it("falls back to a generic label for a verb it has no words for, rather than crashing", () => {
    // A kind with no entry in KIND_LABELS. The obvious spelling — a computed
    // `t(`unsavedKind.${kind}`)` — THROWS `MISSING_MESSAGE` here, and it would throw inside the one
    // surface that only renders when something has already gone wrong.
    const el = render(mkAbandoned([
      { id: "z", kind: "verb_added_next_tuesday", message: "nope", code: "conflict", status: 409 },
    ]));
    expect(el.textContent).toContain("A change to your mailbox");
    expect(el.textContent).not.toContain("verb_added_next_tuesday");
  });


  it("a terminal retry outcome survives the row it was rendered in — the check-Sent case", async () => {
    /**
     * THE COLLISION BETWEEN TWO CORRECT RULES. "Absent at zero" is right, and rendering the retry's
     * answer on the row it belongs to is right — but a terminal retry REMOVES that row, so when
     * the last record is retried and comes back `send_unverified`, the component unmounted before
     * the sentence could appear. No warning, no record, and a person free to send again mail that
     * may already have left. Watched red by retrying the LAST record away.
     */
    const rows = mkAbandoned([
      { id: "only", kind: "mail_send", message: "internal error", code: "internal", status: 500 },
    ]);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    // The engine's real shape after a terminal retry: the record is gone, the outcome carries the
    // sentence. The parent re-renders with an EMPTY collection.
    let current = rows;
    const render = () => act(() => {
      root!.render(
        <TextProvider locale="en" messages={messages} timeZone="UTC">
          <UnsavedListOf
            {...fixed}
            open
            title={unsavedTitle(words, rows.length, 0) ?? ""}
            abandoned={current}
            onRetry={async (id) => {
              current = [];
              return {
                id, key: id, status: "rolled_back" as const, seq: null,
                error: new ApiError(200, "send_unverified",
                  "We could not confirm this send. Check your Sent folder before retrying."),
              } as unknown as MutationResult;
            }}
            onDiscard={async () => {}}
          />
        </TextProvider>,
      );
    });
    render();

    await act(async () => { within(dialog()!).getByRole("button", { name: messages.sync.unsavedRetry }).click(); });
    render();

    expect(host!.textContent).toContain("Sent folder");
    expect(dialog()).not.toBeNull();
  });

});
