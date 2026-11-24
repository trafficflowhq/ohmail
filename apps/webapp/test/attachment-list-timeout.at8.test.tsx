/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { OhmailEngine, threadOf } from "@ohmail/client-engine";
import { HttpAdapter } from "@ohmail/client-engine";
import { AttachmentStrip } from "../app/components/AttachmentStrip.js";
import { useMessageAttachments } from "../app/shell/attachments.js";

/**
 * ═══ GAP THE SCREEN A HUNG READ DRAWS ════════════════════════════════════════════════
 *
 * An earlier change gave the LIST a state and made a refusal say so. A request that never answers is not a
 * refusal: nothing rejects, nothing carries a status, and the engine's outcome stays
 * `{state: "loading"}` — which `AttachmentStrip` renders as `null`, on purpose, because the read
 * is one indexed row and a skeleton on every message open would be noise. So the honest choice
 * for a fast read is the silent one for a hung read, and there is nothing in between.
 *
 * This file drives the REAL path — a real `HttpAdapter` over a `fetch` that never settles, a real
 * `OhmailEngine`, the real hook, the real component, wired the way the shared Reader wires them. The
 * bound lives in the adapter (it is the only layer that can abort), so a fake `listAttachments`
 * would prove nothing here: it would hang after the fix exactly as it hangs before it.
 *
 * The engine half is `packages/client-engine/test/attachments-list-timeout.at8.test.ts`.
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

/** Advance the fake clock inside `act`, so the engine's notify lands as a render. */
async function waitMs(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const row = (): HTMLElement | null => host!.querySelector<HTMLElement>(".att-list");

/** The shared Reader's own wiring, copied verbatim — the same harness the test uses. */
function Harness({ engine, messageId }: { engine: OhmailEngine; messageId: string }) {
  const attachments = useMessageAttachments(engine, messageId, { shell: "none", conversationOf: (id: string) => threadOf(engine.read(), id), onDownloadAllFailed: () => {} });
  return attachments
    ? h(AttachmentStrip, {
        items: attachments.itemsOf(messageId),
        onOpen: (attachmentId: string) => attachments.open(messageId, attachmentId),
        onDownloadAll: () => attachments.downloadAll(messageId),
        downloadingAll: attachments.downloadingAll(messageId),
      })
    : null;
}

function engineOver(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>): OhmailEngine {
  return new OhmailEngine({ adapter: new HttpAdapter({ baseUrl: "/api", fetch: fetchImpl }) });
}

describe("a request that never answers stops rendering as nothing", () => {

  it("…and what it says is that ohmail did not answer — not that the mailbox failed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const engine = engineOver(() => new Promise<Response>(() => {}));
    await render(h(Harness, { engine, messageId: "m1" }));
    await waitMs(12_000);

    expect(row()!.textContent).toContain("ohmail didn't answer in time.");
    // `GET /messages/:id/attachments` is `cost: "read"` and opens no IMAP adapter. A sentence
    // here that blamed the user's mail server would be false for every timeout this can produce.
    expect(row()!.textContent, "the list's copy blamed the mailbox for a read that never reaches it")
      .not.toContain("mailbox");
    // Distinct from the two sentences that change shipped: a server that never answered is not a server
    // we could not reach, and it is not a server that refused.
    expect(row()!.textContent).not.toContain("check your connection");
    expect(row()!.textContent).not.toContain("Couldn't load this message's files.");
  });

  it("the diagnosis is in the title, and it is OURS — no server spoke, so none is quoted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const engine = engineOver(() => new Promise<Response>(() => {}));
    await render(h(Harness, { engine, messageId: "m1" }));
    await waitMs(12_000);

    expect(row()!.title).toContain("12000 ms");
  });


});
