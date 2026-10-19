/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

/**
 * WHEN THE MAILBOX FACTS WERE LAST READ — the "Checked" line's guard against a check stamp from facts
 * a hidden tab has not refreshed. Every accepted answer moves it, an UNCHANGED one too (an identical
 * poll publishes nothing, so the facts' identity cannot say when they were read), and it stays put
 * while no poll runs.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const NOW = new Date("2026-10-19T12:00:00.000Z");
const { MemoryMirrorStore, OhmailEngine } = await import("@ohmail/client-engine");
const { FACTS_POLL_MS } = await import("../app/shell/MailStateProvider.js");

const row = () => ({
  id: "mb_1", address: "rig@example.invalid", status: "connected", errorCode: null, disabledReason: null,
  syncBlockedReason: null, syncBlockedSince: null, lastSyncAt: NOW.toISOString(), createdAt: NOW.toISOString(),
});

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  vi.useRealTimers();
});

describe("factsReadAt", () => {
  it("advances on every accepted answer, identical ones included, and holds between them", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryMirrorStore();
    await store.load();
    const engine = new OhmailEngine({
      store, now: () => NOW,
      adapter: {
        sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString() }),
        mutate: async () => ({ changes: [], seq: null }),
        fetchBody: async () => null,
      } as never,
    });
    let calls = 0;
    const probe = async () => { calls++; return structuredClone([row()]); };
    let readAt: (() => number | null) | null = null;
    const facts: unknown[] = [];

    const { EngineProvider } = await import("../app/shell/engine.js");
    const { MailStateProvider, useMailState } = await import("../app/shell/MailStateProvider.js");
    function Watch(): React.ReactElement {
      const b = useMailState();
      readAt = b.factsReadAt;
      facts.push(b.mailboxes);
      return h("i", null, "x");
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages: messages as never, timeZone: "UTC", now: NOW,
        children: h(EngineProvider as never, {
          demo: false, engine,
          children: h(MailStateProvider as never, { probe, mirrored: 0, children: h(Watch) } as never),
        } as never),
      } as never));
    });
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
    };
    await settle();
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(readAt).toBeTypeOf("function");
    const first = readAt!();
    expect(first).toBe(NOW.getTime());
    const published = facts.filter((f) => f !== null);
    const identity = published[published.length - 1];

    await act(async () => { await vi.advanceTimersByTimeAsync(FACTS_POLL_MS + 50); });
    await settle();
    expect(calls).toBeGreaterThanOrEqual(2);
    // The answer was identical, so nothing re-published …
    const after = facts.filter((f) => f !== null);
    expect(after[after.length - 1]).toBe(identity);
    // … and still the read is recorded.
    expect(readAt!()).toBeGreaterThanOrEqual(first! + FACTS_POLL_MS);

    // No poll while the tab is hidden: the stamp holds.
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    const held = readAt!();
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * FACTS_POLL_MS); });
    await settle();
    expect(readAt!()).toBe(held);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
});
