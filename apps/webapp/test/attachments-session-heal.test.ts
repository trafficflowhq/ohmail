/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MutationRejectedError, OhmailEngine, type EngineAdapter, threadOf } from "@ohmail/client-engine";
import { AttachmentStrip } from "../app/components/AttachmentStrip.js";
import { useMessageAttachments } from "../app/shell/attachments.js";
import {
  markSessionAlive,
  registerSessionProbe,
  resetSessionTruthForTests,
} from "@ohmail/app-logic/session/session-truth";

/**
 * ═══ VWR-3 — AN AUTH FAILURE ON THE ATTACHMENT LIST MUST NOT OUTLIVE THE SESSION ═══════════
 *
 * Observed in live use: ONE 401'd metadata read left "Couldn't load this message's files." on
 * a message for the whole session while the same endpoint answered 200 beside it — no retry
 * affordance (the wire says `retryable: false`, which is true of the request and false of the
 * situation), and only a hard reload cleared it. Three repairs, each asserted here against the
 * real hook over a real engine:
 *
 *  1. the failure is NAMED — the session's, not the files' (`listSignedOut`, not `listFailed`);
 *  2. it is RETRYABLE — the row offers Try again despite the wire flag, because this failure
 *     expires with the session that earned it;
 *  3. it CLEARS ON RECOVERY — a session revival (`markSessionAlive`, published on every real
 *     204 from `/auth/refresh`) re-asks the held auth failure without anybody pressing anything.
 *
 * Plus the escalation: the auth-coded failure calls the session probe, which is what turns a
 * lapsed session into a silent heal and a revoked one into the prompt.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render(element: React.ReactElement): Promise<void> {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(element));
}

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

const unauthorized = (): MutationRejectedError =>
  new MutationRejectedError("authentication required", {
    status: 401,
    code: "unauthorized",
    retryable: false,
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

/** `MessagePane`'s own wiring, exactly as `attachment-list-state.at6.test.ts` mirrors it. */
function Harness({ engine, messageId }: { engine: OhmailEngine; messageId: string }) {
  const attachments = useMessageAttachments(engine, messageId, { conversationOf: (id: string) => threadOf(engine.read(), id), onDownloadAllFailed: () => {} });
  return attachments
    ? h(AttachmentStrip, {
        items: attachments.itemsOf(messageId),
        onOpen: (attachmentId: string) => attachments.open(messageId, attachmentId),
        onDownloadAll: () => attachments.downloadAll(messageId),
        downloadingAll: attachments.downloadingAll(messageId),
      })
    : null;
}

const row = (): HTMLElement | null => host!.querySelector<HTMLElement>(".att-list");
const retry = (): HTMLButtonElement | null => host!.querySelector<HTMLButtonElement>(".att-list-retry");

describe("VWR-3 — the auth-refused list names the session, keeps a retry, and heals on revival", () => {
  it("names the SESSION, not the files — and offers Try again despite `retryable: false`", async () => {
    const engine = new OhmailEngine({
      adapter: adapterWith({ listAttachments: async () => { throw unauthorized(); } }),
    });
    await render(h(Harness, { engine, messageId: "m1" }));

    expect(row(), "the auth failure rendered nothing at all").not.toBeNull();
    expect(row()!.textContent).toContain("Your session ended, so ohmail couldn't answer.");
    expect(row()!.textContent).not.toContain("Couldn't load this message's files.");
    expect(retry(), "an expired-session failure withheld the one press that works after sign-in")
      .not.toBeNull();
  });

  it("escalates the auth-coded failure to the session probe — the fast path to truth", async () => {
    const probe = vi.fn();
    registerSessionProbe(probe);
    const engine = new OhmailEngine({
      adapter: adapterWith({ listAttachments: async () => { throw unauthorized(); } }),
    });
    await render(h(Harness, { engine, messageId: "m1" }));
    expect(probe, "an unauthorized list read never asked the session question").toHaveBeenCalled();
  });

  it("THE DEFECT: a revival re-asks the held auth failure, and the files replace the sentence", async () => {
    let attempt = 0;
    const listAttachments = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw unauthorized();
      return [{
        id: "a1", filename: "invoice.pdf", contentType: "application/pdf",
        sizeBytes: 2_300_000, inline: false, messageId: "m1",
      }];
    });
    const engine = new OhmailEngine({ adapter: adapterWith({ listAttachments }) });
    await render(h(Harness, { engine, messageId: "m1" }));
    expect(row()!.textContent).toContain("Your session ended, so ohmail couldn't answer.");
    expect(listAttachments).toHaveBeenCalledTimes(1);

    // A real 204 from /auth/refresh publishes exactly this. Nothing is pressed.
    await act(async () => {
      markSessionAlive();
    });

    expect(listAttachments, "the revival never re-asked — the failure would stand all session")
      .toHaveBeenCalledTimes(2);
    expect(row(), "the session healed and the sentence stayed").toBeNull();
    expect(host!.querySelector(".att-name")!.textContent).toBe("invoice.pdf");
  });

  it("a NON-auth failure is left alone by a revival — the heal is precise, not a sweep", async () => {
    const listAttachments = vi.fn(async () => {
      throw new MutationRejectedError("no such message", {
        status: 404, code: "not_found", retryable: false,
      });
    });
    const engine = new OhmailEngine({ adapter: adapterWith({ listAttachments }) });
    await render(h(Harness, { engine, messageId: "m1" }));
    expect(listAttachments).toHaveBeenCalledTimes(1);

    await act(async () => {
      markSessionAlive();
    });

    // A new session says nothing about a 404: re-asking would poll a refusal that cannot change.
    expect(listAttachments).toHaveBeenCalledTimes(1);
    expect(row()!.textContent).toContain("Couldn't load this message's files.");
  });
});
