/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ApiError } from "../app/api-client";
import messages from "../messages/en.json";
import type { MutationResult } from "@ohmail/client-engine";
import { UnsavedChangesList } from "../app/shell/UnsavedChanges";

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

function render(
  rows: ReturnType<typeof mkAbandoned>,
  acts: {
    onRetry?: (id: string) => Promise<MutationResult>;
    onDiscard?: (id: string) => Promise<void>;
  } = {},
) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <UnsavedChangesList
          abandoned={rows}
          onRetry={acts.onRetry ?? (async (id) => ({ id, key: id, status: "confirmed" as const, seq: 1 }))}
          onDiscard={acts.onDiscard ?? (async () => {})}
        />
      </NextIntlClientProvider>,
    );
  });
  return host!;
}

describe("the changes-that-did-not-land strip", () => {
  it("renders NOTHING when nothing was abandoned", () => {
    const el = render(mkAbandoned([]));
    // Not a hidden node and not a zero count — absent. RED-FIRST: delete the `length === 0` guard
    // in the component and this fails on the very first assertion.
    expect(el.querySelector(".unsaved")).toBeNull();
    expect(el.textContent).toBe("");
  });

  it("counts what was abandoned and lists each one behind a disclosure", () => {
    const el = render(mkAbandoned([
      { id: "a", kind: "mail_send", message: "internal error", code: "internal", status: 500 },
      { id: "b", kind: "move", message: "that folder is gone", code: "not_found", status: 404 },
    ]));

    expect(el.querySelector(".unsaved")).not.toBeNull();
    expect(el.textContent).toContain("2 changes could not be saved");
    // Collapsed by default: the strip states the fact, the list is on request.
    expect(el.querySelectorAll(".unsaved-row")).toHaveLength(0);

    act(() => {
      el.querySelector<HTMLButtonElement>(".unsaved-toggle")!.click();
    });
    expect(el.querySelectorAll(".unsaved-row")).toHaveLength(2);
    expect(el.textContent).toContain("Sending a message");
    expect(el.textContent).toContain("Filing a message");
  });

  it("quotes a server sentence a person can act on, and refuses to quote one they cannot", () => {
    const el = render(mkAbandoned([
      { id: "a", kind: "move", message: "that folder is gone", code: "not_found", status: 404 },
      { id: "b", kind: "mail_send", message: "internal error", code: "internal", status: 500 },
    ]));
    act(() => { el.querySelector<HTMLButtonElement>(".unsaved-toggle")!.click(); });

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
    act(() => { el.querySelector<HTMLButtonElement>(".unsaved-toggle")!.click(); });
    expect(el.textContent).toContain("A change to your mailbox");
    expect(el.textContent).not.toContain("verb_added_next_tuesday");
  });

  it("offers no Try again once a newer change to the same thing has been saved", () => {
    // Retrying a superseded record would push an older intent over the newer one the person
    // cannot see — draft body B replayed on top of body C. The record stays listed (throwing it
    // away silently is the failure this whole collection exists to prevent) and Discard remains.
    const el = render(mkAbandoned([
      { id: "a", kind: "draft_save", message: "internal error", code: "internal", status: 500, superseded: true },
    ]));
    act(() => { el.querySelector<HTMLButtonElement>(".unsaved-toggle")!.click(); });

    expect(el.querySelectorAll(".unsaved-row")).toHaveLength(1);
    const buttons = el.querySelectorAll<HTMLButtonElement>(".unsaved-acts button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toBe("Discard");
    expect(el.textContent).toContain("A newer change to the same thing has since been saved");
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
        <NextIntlClientProvider locale="en" messages={messages}>
          <UnsavedChangesList
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
        </NextIntlClientProvider>,
      );
    });
    render();

    act(() => { host!.querySelector<HTMLButtonElement>(".unsaved-toggle")!.click(); });
    await act(async () => { host!.querySelector<HTMLButtonElement>(".unsaved-acts button")!.click(); });
    render();

    expect(host!.textContent).toContain("Sent folder");
    expect(host!.querySelector(".unsaved")).not.toBeNull();
  });

  it("Try again and Discard reach the engine, by id", async () => {
    const retried: string[] = [];
    const discarded: string[] = [];
    const el = render(
      mkAbandoned([{ id: "a", kind: "move", message: "nope", code: "conflict", status: 409 }]),
      {
        onRetry: async (id) => { retried.push(id); return { id, key: id, status: "confirmed" as const, seq: 1 }; },
        onDiscard: async (id) => { discarded.push(id); },
      },
    );
    act(() => { el.querySelector<HTMLButtonElement>(".unsaved-toggle")!.click(); });

    const buttons = el.querySelectorAll<HTMLButtonElement>(".unsaved-acts button");
    expect(buttons).toHaveLength(2);
    await act(async () => { buttons[0]!.click(); });
    await act(async () => { buttons[1]!.click(); });

    expect(retried).toEqual(["a"]);
    expect(discarded).toEqual(["a"]);
  });
});

describe("the drafted-reply button's failure sentence", () => {
  /**
   * `messageFor` is the whole decision and it is pure, so it is tested directly rather than through
   * the hook — the alternative is standing up an engine, a session and a paid route to observe one
   * string.
   */
  it("passes a server refusal through verbatim, and never quotes an unhandled fault", async () => {
    const { messageFor } = await import("@ohmail/app-logic/writing/draft-reply");
    const FALLBACK = "That did not work.";
    const OPAQUE = "opaque sentence";

    // The refusals this path was built around: each already carries a true, actionable sentence.
    for (const [status, code, msg] of [
      [402, "payment_required", "no AI credits remain on this account"],
      [422, "unprocessable", "cannot AI-draft a sensitive message"],
      [503, "unavailable", "this deployment has no AI drafter connected"],
    ] as const) {
      expect(messageFor(new ApiError(status, code, msg), FALLBACK, OPAQUE)).toBe(msg);
    }

    // The unhandled fault — the shape `GET /drafts/:id` answered for a malformed id. Note the 503
    // above is ALSO a 5xx and is NOT swallowed: the discriminator is the code, not the status, and
    // a `status >= 500` rule would have eaten the most useful sentence on this path.
    expect(messageFor(new ApiError(500, "internal", "internal error"), FALLBACK, OPAQUE)).toBe(OPAQUE);
    // A blank message is the same failure with fewer characters.
    expect(messageFor(new ApiError(500, "some_code", "   "), FALLBACK, OPAQUE)).toBe(OPAQUE);
    // Something that is not an ApiError at all is not a refusal and gets the caller's fallback.
    expect(messageFor(new Error("boom"), FALLBACK, OPAQUE)).toBe(FALLBACK);
  });

  it("a send retried from the strip whose key had already delivered says so", async () => {
    const rows = mkAbandoned([{ id: "x", kind: "mail_send", message: "Not sent.", code: "network", status: null }]);
    const onRetry = async (id: string): Promise<MutationResult> => ({
      id, key: `key-${id}`, status: "confirmed", seq: 1, firstSend: { status: "sent", at: "2026-10-03T08:00:00.000Z" },
    });
    const el = render(rows, { onRetry });
    act(() => { el.querySelector<HTMLButtonElement>(".unsaved-toggle")!.click(); });
    const row = el.querySelector(".unsaved-row")!;
    const button = [...row.querySelectorAll("button")].find((b) => b.textContent === messages.sync.unsavedRetry);
    expect(button, "the row offers no Try again").toBeDefined();
    await act(async () => { button!.click(); });
    expect(el.textContent, "a retry answered from an earlier delivery said nothing").toContain(messages.sync.unsavedSendAlreadyWent);
  });
});

