/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore, MutationRejectedError, OhmailEngine,
  type EngineMutation, type MirrorStore, type SendAndDonePlan,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";

/**
 * SEND + DONE SURVIVES THE SURFACE. A Send + Done pressed with no connection went queued; the
 * release was held in the pressing surface's memory, so when the next open's replay confirmed the
 * send nothing filed the source. The release rides the send's outbox row, and the replayed
 * confirmation hands the intent to the shell's outcome door, which reads the release then.
 * Mutation: the late pass's `andDone` hand-over removed → case 1 red.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const NOW = new Date("2026-09-27T09:00:00.000Z");
const PLAN: SendAndDonePlan = { section: "new", source: "m1", messageIds: ["m1"] };
let root: Root | null = null;
let host: HTMLDivElement | null = null;
const noToast = (): void => {};

function engineOver(store: MirrorStore, net: { offline: boolean }, copy: Record<string, string> = {}): OhmailEngine {
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: "1", hasMore: false, serverTime: NOW.toISOString(),
      }),
      fetchBody: async () => null,
      mutate: async (m: EngineMutation) => {
        if (m.kind !== "mail_send") return { changes: [], seq: null };
        if (net.offline) throw new MutationRejectedError("network failure", { code: "network", retryable: true });
        return { changes: [], seq: null, entityId: "d1", providerMessageId: "<d1@x>", ...copy };
      },
    } as never,
  });
}

/** One send lane, and the shell's outcome door modelled: the intent that arrives is recorded. */
async function surface(engine: OhmailEngine, released: SendAndDonePlan[], copies: unknown[] = []) {
  const { useMailSend } = await import("../app/shell/mail-send.js");
  let api!: { send: (m: Record<string, unknown>, opts?: { andDone?: SendAndDonePlan }) => void; phase: () => string };
  const Probe = (): null => {
    const mail = useMailSend(
      engine as never, noToast as never, (() => {}) as never,
      ((_key: string, _m: unknown, accepted: boolean, _phase: unknown, detail?: { andDone?: SendAndDonePlan; copy?: unknown }) => {
        const intent = detail?.andDone;
        if (intent === undefined || !accepted) return false;
        released.push(intent);
        copies.push(detail?.copy);
        return true;
      }) as never,
    );
    api = {
      send: (m, opts) => (mail.send as unknown as (m: unknown, o?: unknown) => void)(m, opts),
      phase: () => mail.stateOf("compose").phase,
    };
    return null;
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", now: NOW, children: h(Probe) }));
  });
  // Through the LATEST render's hook, never the first one's.
  return {
    send: (m: Record<string, unknown>, opts?: { andDone?: SendAndDonePlan }) => api.send(m, opts),
    phase: () => api.phase(),
  };
}

async function killTab(): Promise<void> {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
}

const drain = async (n = 30): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1); });
};

const message = {
  kind: "mail_send", inReplyTo: null, mailboxId: "mb", subject: "Invoice 12", body: "thanks, done",
  to: [{ name: null, address: "ada@fake.test" }],
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  window.localStorage.clear();
});
afterEach(async () => {
  await killTab();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("a Send + Done confirmed after a reload", () => {
  it("1 — the next open's replay hands the release to the shell, which files the source", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    const first = engineOver(store, { offline: true });
    const released1: SendAndDonePlan[] = [];
    const s1 = await surface(first, released1);
    await act(async () => { await first.start(); });
    await act(async () => { s1.send(message, { andDone: PLAN }); });
    await drain();
    expect(s1.phase(), "the offline press did not queue").toBe("queued");
    expect(released1, "a queued send released its source").toEqual([]);
    await killTab();

    const second = engineOver(store, { offline: false });
    const released2: SendAndDonePlan[] = [];
    await surface(second, released2);
    await act(async () => { await second.start(); });
    await drain();
    expect(released2.length, "the send was confirmed on the next open and its source was not filed").toBe(1);
    expect(released2[0], "the intent handed back is not the one pressed").toEqual(PLAN);
  });

  it("1b — a replayed Send + Done whose Sent copy is missing hands the note to the release", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    const first = engineOver(store, { offline: true });
    const s1 = await surface(first, []);
    await act(async () => { await first.start(); });
    await act(async () => { s1.send(message, { andDone: PLAN }); });
    await drain();
    await killTab();

    const second = engineOver(store, { offline: false }, { sentCopy: "missing", sentCopyReason: "full" });
    const copies: unknown[] = [];
    await surface(second, [], copies);
    await act(async () => { await second.start(); });
    await drain();
    expect(copies, "the release was told nothing of the missing copy").toEqual([{ state: "missing", reason: "full" }]);
  });

  it("CONTROL: a plain Send confirmed on the next open files nothing", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    const first = engineOver(store, { offline: true });
    const s1 = await surface(first, []);
    await act(async () => { await first.start(); });
    await act(async () => { s1.send(message); });
    await drain();
    await killTab();

    const second = engineOver(store, { offline: false });
    const released: SendAndDonePlan[] = [];
    await surface(second, released);
    await act(async () => { await second.start(); });
    await drain();
    expect(released, "a plain Send filed its source").toEqual([]);
  });
});
