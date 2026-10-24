/** @vitest-environment jsdom */
/**
 * ═══ THE BADGE RULE IS STATED, AND THE STATEMENT IS TRUE ═══
 *
 * Three surfaces carried the same badge semantics unwritten (web rail, phone tabs, desktop
 * `set_badge`), and a number that might mean different things per device erodes trust in all
 * of them. The fix is a sentence in Settings → Notifications; a claim is a contract, so this
 * file pins BOTH halves on the shipped shell: the sentence renders, and the numbers it
 * describes are the numbers the code feeds — the app-icon sink (`onUnread`, the desktop's
 * `set_badge` feed) and the rail's Ohbox count both read the OHBOX UNREAD count, not list
 * length, not a third derivation. The phone tabs read the same engine fields
 * (`(tabs)/_layout.tsx#badgeOf`); their own sentence is the mobile parity lane's row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  OhmailEngine,
  mutationEffects,
  type EngineMessage,
  type EngineMutation,
  type MirrorStore,
  type SyncChange,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import type { MailboxFacts } from "../app/shell/mail-state";

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-04T09:00:00.000Z");
let roots: Root[] = [];
let seq = 0;

beforeEach(() => {
  window.location.hash = "";
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] { return []; }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  seq = 0;
});

afterEach(async () => {
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

const address = (id: string): string => `p${id}@example.invalid`;

const msg = (id: string, unread: boolean): EngineMessage => ({
  id, accountId: "a1", mailboxId: "mb1", threadId: `t-${id}`, folder: "INBOX",
  subject: `Subject ${id}`, from: { address: address(id), name: `Person ${id}` },
  to: [], date: "2026-09-03T09:00:00.000Z", unread,
  updatedAt: "2026-09-03T09:00:00.000Z",
} as unknown as EngineMessage);

/** Two unread, one read — the sentence's number is 2 exactly when it means "Ohbox unread". */
async function storeWith(): Promise<MirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  for (const [id, unread] of [["m1", true], ["m2", true], ["m3", false]] as const) {
    const m = msg(id, unread);
    await store.applyChanges([
      { type: "message", op: "create", id, seq: ++seq, updatedAt: m.updatedAt, entity: m },
      {
        type: "rule", op: "create", id: `r-${id}`, seq: ++seq, updatedAt: m.updatedAt,
        entity: {
          id: `r-${id}`, kind: "sender", match: address(id),
          destination: "INBOX", enabled: true, createdAt: "2026-09-01T00:00:00.000Z",
        },
      },
    ] as SyncChange[]);
  }
  return store;
}

function engineOver(store: MirrorStore): OhmailEngine {
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async (m: EngineMutation) => {
        const changes = mutationEffects(store, m, { now: () => NOW, uuid: () => `id-${++seq}` })
          .map((e) => ({
            type: e.type,
            op: e.entity === null ? "delete" : e.move ? "move" : "update",
            id: e.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: e.entity,
            ...(e.move ? { move: e.move } : {}),
          })) as SyncChange[];
        await store.applyChanges(changes);
        return { changes, seq: changes[changes.length - 1]?.seq ?? null };
      },
      fetchBody: async () => ({
        text: "body", html: null, loadedRemoteContent: false,
        unsubscribe: "no_header", unsubscribeUrl: null,
      }),
    },
  } as never);
}

const ROSTER: MailboxFacts[] = [{
  id: "mb1", address: "me@example.invalid", status: "connected", errorCode: null,
  disabledReason: null, syncBlockedReason: null, syncBlockedSince: null,
  lastSyncAt: "2026-09-04T08:59:00.000Z", createdAt: "2026-09-01T00:00:00.000Z",
  organizerRole: "organizer" as const,
  organizedBy: null, organizeConsentedAt: "2026-09-01T00:00:00.000Z",
}];

async function shell(
  onUnread: (n: number) => void, engine?: OhmailEngine,
): Promise<HTMLElement> {
  const { AppShell } = await import("../app/shell/AppShell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  engine ??= engineOver(await storeWith());
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, {
        children: h(ToastHost, {
          children: h(AppShell as never, {
            demo: false,
            engine,
            onUnread,
            mailboxFacts: async () => ROSTER,
          } as never),
        }),
      }),
    }));
  });
  await waitFor(() => container.querySelectorAll(".row[data-id]").length > 0, "rows in the Ohbox");
  return container;
}

async function waitFor(predicate: () => boolean, what: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  }
  throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
}

describe("the badge rule", () => {
  it("the app-icon sink and the rail's Ohbox count both read OHBOX UNREAD — the stated number", async () => {
    const calls: number[] = [];
    const container = await shell((n) => calls.push(n));
    await waitFor(() => calls.length > 0, "the unread sink to be fed");
    // Two unread of three listed: unread, not list length — the claim's first half.
    expect(calls[calls.length - 1]).toBe(2);
    const ohboxItem = [...container.querySelectorAll(".rail .ritem")]
      .find((b) => (b.textContent ?? "").includes("Ohbox"));
    expect(ohboxItem, "the rail's Ohbox item").toBeTruthy();
    expect(ohboxItem!.querySelector(".cnt")?.textContent).toBe("2");
  });

  it("a letter brought back by Resurface > Now counts on the rail as in the header, after a reload too", async () => {
    const store = await storeWith();
    const engine = engineOver(store);
    const calls: number[] = [];
    let container = await shell((n) => calls.push(n), engine);
    await act(async () => {
      await engine.mutate({ kind: "triage_set", messageId: "m1", state: "bubbled_up", bubbleUpAt: "2026-09-05T09:00:00.000Z" });
      await engine.mutate({ kind: "triage_set", messageId: "m1", state: "resurfaced" });
    });
    const counts = () => {
      const rail = [...container.querySelectorAll(".rail .ritem")].find((b) => (b.textContent ?? "").includes("Ohbox"));
      return {
        rail: rail?.querySelector(".cnt")?.textContent,
        header: container.querySelector(".vhead .meta")?.textContent,
        markAll: container.querySelector(".mark-all-read")?.getAttribute("aria-label"),
        sink: calls[calls.length - 1],
      };
    };
    const want = { rail: "2", header: "2 unread", markAll: "Mark all 2 unread messages read", sink: 2 };
    await waitFor(() => container.querySelector(".row[data-id=\"m1\"]") !== null, "the resurfaced row listed");
    expect(counts()).toEqual(want);
    // A reload: a fresh engine and shell over the same mirror.
    await act(async () => { roots.pop()!.unmount(); });
    document.body.innerHTML = "";
    container = await shell((n) => calls.push(n), engineOver(store));
    await waitFor(() => counts().header === "2 unread", "the header after the reload");
    expect(counts()).toEqual(want);
  });

  it("the sentence is on the notifications pane, stating the rule", async () => {
    const container = await shell(() => {});
    window.location.hash = "#/settings/notifications";
    await act(async () => { window.dispatchEvent(new HashChangeEvent("hashchange")); });
    await waitFor(
      () => (container.textContent ?? "").includes("The numbers mean the same thing on every device"),
      "the badge-rule sentence to render",
    );
    expect(container.textContent).toContain("unread mail in your Ohbox");
    expect(container.textContent).toContain("first-time senders waiting");
  });
});
