/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MutationRejectedError, OhmailEngine, type EngineAdapter, threadOf } from "@ohmail/client-engine";
import { AttachmentStrip, listRetryIsOffered } from "../app/components/AttachmentStrip.js";
import { useMessageAttachments } from "../app/shell/attachments.js";
import { resetSessionTruthForTests } from "@ohmail/app-logic/session/session-truth";

/**
 * ═══ ONE RE-ASK PER OPEN, AND ONLY WHERE IT HELPS ══
 *
 * A failed attachment list is the surface's own question, asked again the way a person asks it:
 * by opening the message. The rule is the row's own affordance — a failure with a Try again is
 * one anybody may ask again, so a FRESH OPEN asks once; a failure with no press is one the server
 * has ANSWERED (not this account's message, no such message), and re-asking it on every open is
 * polling a refusal that cannot change.
 *
 * Measured before the fix: a 404'd list was re-asked on EVERY re-open, because closing the
 * message released the held failure along with the byte state and the next open found nothing to
 * refuse. Both halves are counted here against the real hook over a real engine.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  resetSessionTruthForTests();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  resetSessionTruthForTests();
  vi.restoreAllMocks();
});

function adapterWith(over: Partial<EngineAdapter> = {}): EngineAdapter {
  return {
    sync: async () => ({ changes: [], cursor: "1", hasMore: false }) as never,
    mutate: async () => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    listAttachments: async () => [],
    fetchAttachment: async () => new Blob(["%PDF"], { type: "application/pdf" }),
    ...over,
  };
}

/** `AppShell`'s own wiring: one hook, the OPEN message's id, `null` when nothing is open. */
function Harness({ engine, messageId }: { engine: OhmailEngine; messageId: string | null }) {
  const attachments = useMessageAttachments(engine, messageId, { conversationOf: (id: string) => threadOf(engine.read(), id), onDownloadAllFailed: () => {} });
  return attachments && messageId
    ? h(AttachmentStrip, {
        items: attachments.itemsOf(messageId),
        onOpen: (attachmentId: string) => attachments.open(messageId, attachmentId),
        onDownloadAll: () => attachments.downloadAll(messageId),
        downloadingAll: attachments.downloadingAll(messageId),
      })
    : null;
}

/** ONE mounted shell for the whole case — a close is `messageId: null`, never an unmount. */
async function show(engine: OhmailEngine, messageId: string | null): Promise<void> {
  if (!root) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => root!.render(h(Harness, { engine, messageId })));
}

const row = (): HTMLElement | null => host!.querySelector<HTMLElement>(".att-list");
const retry = (): HTMLButtonElement | null => host!.querySelector<HTMLButtonElement>(".att-list-retry");

const refusal = (status: number, code: string, retryable: boolean) => async (): Promise<never> => {
  throw new MutationRejectedError(`HTTP ${status}`, { status, code, retryable });
};

describe("a failed attachment list is re-asked once on a later open", () => {
  it("open → 500 → failed; close; open again → ONE more request; open again without closing → none", async () => {
    const listAttachments = vi.fn(refusal(500, "internal", true));
    const engine = new OhmailEngine({ adapter: adapterWith({ listAttachments }) });

    await show(engine, "m1");
    expect(listAttachments).toHaveBeenCalledTimes(1);
    expect(row()!.textContent).toContain("Couldn't load this message's files.");
    expect(retry(), "a retryable failure withheld its own press").not.toBeNull();

    await show(engine, null);
    expect(listAttachments, "closing the message asked something").toHaveBeenCalledTimes(1);

    await show(engine, "m1");
    expect(listAttachments, "a fresh open did not ask again").toHaveBeenCalledTimes(2);

    // A RE-RENDER IS NOT AN OPEN. The same message, still open, rendered again: the engine's own
    // refusal to re-ask a held failure without a human press is what holds this line.
    await show(engine, "m1");
    await show(engine, "m1");
    expect(listAttachments, "a re-render asked again — the loop this rule exists to stop")
      .toHaveBeenCalledTimes(2);
  });

  it("a WITHHELD list — answered, no press offered — is not re-asked on a re-open", async () => {
    const listAttachments = vi.fn(refusal(404, "not_found", false));
    const engine = new OhmailEngine({ adapter: adapterWith({ listAttachments }) });

    await show(engine, "m1");
    expect(listAttachments).toHaveBeenCalledTimes(1);
    expect(retry(), "an answered refusal offered a press it cannot honour").toBeNull();

    await show(engine, null);
    await show(engine, "m1");
    expect(listAttachments, "an answered refusal was polled on the next open").toHaveBeenCalledTimes(1);
    // And it still SAYS so: keeping the refusal is not the same as going silent.
    expect(row()!.textContent).toContain("Couldn't load this message's files.");

    await show(engine, null);
    await show(engine, "m1");
    expect(listAttachments).toHaveBeenCalledTimes(1);
  });

  it("an AUTH-shaped refusal keeps its re-ask — it expires with the session that earned it", async () => {
    const listAttachments = vi.fn(refusal(401, "unauthorized", false));
    const engine = new OhmailEngine({ adapter: adapterWith({ listAttachments }) });

    await show(engine, "m1");
    expect(listAttachments).toHaveBeenCalledTimes(1);
    // `retryable: false` on the wire, a press all the same — and therefore a re-ask on a re-open.
    expect(retry()).not.toBeNull();

    await show(engine, null);
    await show(engine, "m1");
    expect(listAttachments, "the session's own failure was kept like an answered one")
      .toHaveBeenCalledTimes(2);
  });

  it("a kept refusal does not outlive the message becoming readable: the row's press still asks", async () => {
    let attempt = 0;
    const listAttachments = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new MutationRejectedError("HTTP 500", { status: 500, code: "internal", retryable: true });
      return [{
        id: "a1", filename: "invoice.pdf", contentType: "application/pdf",
        sizeBytes: 12, inline: false, messageId: "m1",
      }];
    });
    const engine = new OhmailEngine({ adapter: adapterWith({ listAttachments }) });

    await show(engine, "m1");
    expect(retry()).not.toBeNull();
    await act(async () => { retry()!.click(); });
    expect(listAttachments).toHaveBeenCalledTimes(2);
    expect(host!.querySelector(".att-name")!.textContent).toBe("invoice.pdf");
  });
});

describe("one predicate decides the press and the re-ask", () => {
  it("names the answered refusals and nothing else", () => {
    expect(listRetryIsOffered("internal", true)).toBe(true);
    expect(listRetryIsOffered("timeout", true)).toBe(true);
    expect(listRetryIsOffered("network", true)).toBe(true);
    expect(listRetryIsOffered(null, true)).toBe(true);
    // The two the auth middleware mints: no press on the wire, a press all the same.
    expect(listRetryIsOffered("unauthorized", false)).toBe(true);
    expect(listRetryIsOffered("csrf_failed", false)).toBe(true);
    // Answered.
    expect(listRetryIsOffered("not_found", false)).toBe(false);
    expect(listRetryIsOffered("forbidden", false)).toBe(false);
  });
});
