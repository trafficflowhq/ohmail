/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine,
  MemoryMirrorStore,
  mutationEffects,
  type EngineMessage,
  type EngineMutation,
  type Folder,
  type MirrorStore,
  type SyncChange,
} from "@ohmail/client-engine";
import en from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";
import de from "../messages/de.json";
import { screenerMode, type ScreenerRole } from "@ohmail/app-logic/mail-state/mail-state";
import type { ScreenerState } from "../app/shell/screener-state";

/**
 * A DECISION DURING A TAKEOVER THIS INSTALL ASKED FOR REACHES THE DOOR (as reported, and the
 * self-host note). The Screener walls every deciding verb for a `blocked` reader, and a reader
 * whose holder stopped — or that no holder ever claimed — is `blocked`; so the setup's first
 * decision was refused here, before any door, with "another ohmail organizer has this mailbox"
 * even when there was none. A standing takeover stamp now lets the decision through (the door
 * keeps it as a rule until the claim lands), and a no-holder refusal names nobody.
 * HOW TO WATCH IT FAIL: drop `role.takeoverAsked !== true` from `guard` in `screener-state.ts`.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-02T12:00:00.000Z");
const HOLDER: ScreenerRole =
  { mode: "blocked", name: "ohmail Cloud", reason: "organizer_outdated", oauthOnly: false };
/** This install organizes it — every verb works, which is what these cases contrast with. */
const ORGANIZES: ScreenerRole = { mode: "organizer", name: null, reason: null, oauthOnly: false };
/** A reader whose holder takes decisions: the bar STAYS and the press is real. */
const PENDING: ScreenerRole =
  { mode: "pending", name: "ohmail Cloud", reason: null, oauthOnly: false };
let seq = 0;
let sent: EngineMutation[] = [];
/** Every sentence the state raised, in order — the refusal is the only thing that may appear. */
let toasts: string[] = [];

function msg(id: string, from: string, folder: Folder): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: "2026-09-02T09:00:00.000Z", folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: {
      sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false,
      priority: false,
    },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-02T09:00:00.000Z",
  };
}

/** One stranger waiting, and one already quarantined — the two segments that carry verbs. */
const HELD = msg("h1", "editors@terracereview.invalid", "ohmail/Screener");
const JUNK = msg("q1", "blast@bulk.invalid", "ohmail/Quarantine");

async function freshStore(): Promise<MirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  for (const m of [HELD, JUNK]) {
    await store.applyChanges([{
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    }]);
  }
  return store;
}

/** An engine over `store` whose every dispatched verb is recorded in `sent`. */
function engineOver(store: MirrorStore): OhmailEngine {
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async (m) => {
        sent.push(m);
        const changes: SyncChange[] = mutationEffects(store, m, {
          now: () => NOW, uuid: () => `id-${++seq}`,
        }).map((e) => ({
          type: e.type, op: e.move ? "move" : "update", id: e.id, seq: ++seq,
          updatedAt: NOW.toISOString(), entity: e.entity, ...(e.move ? { move: e.move } : {}),
        }));
        await store.applyChanges(changes);
        return { changes, seq: changes[changes.length - 1]?.seq ?? null };
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => ({
        text: "body", html: null, loadedRemoteContent: false,
        unsubscribe: "no_header", unsubscribeUrl: null,
      }),
    },
  });
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** Mount the real hook, with the real catalogue behind it. */
async function mountState(
  engine: OhmailEngine,
  role: ScreenerRole,
  locale: "en" | "de" = "en",
): Promise<{ get: () => ScreenerState; bump: () => Promise<void> }> {
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  let latest: ScreenerState | null = null;
  let force: (() => void) | null = null;

  function Probe(): null {
    const [v, setV] = React.useState(0);
    force = () => setV((x) => x + 1);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    latest = useScreenerState(
      engine,
      v,
      ((message: string) => { toasts.push(message); }) as never,
      undefined,
      undefined,
      true,
      role,
    );
    return null;
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale, messages: (locale === "de" ? de : en) as never, timeZone: "UTC", now: NOW,
      children: h(Probe),
    }));
  });
  await settleFirstPaint();
  return {
    get: () => latest!,
    bump: async () => { await act(async () => { force?.(); }); },
  };
}

async function unmount(): Promise<void> {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  seq = 0;
  sent = [];
  toasts = [];
  window.localStorage.clear();
});

afterEach(async () => {
  await unmount();
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = "";
});


const STAMP = "2026-09-02T11:59:00.000Z";
const READER = {
  status: "connected", organizerRole: "reader" as const, organizeConsentedAt: STAMP,
  organizedBy: { kind: "local", name: "W-old", since: "2026-08-20T09:00:00.000Z" },
  organizerState: "stopped" as const, organizerAcceptsRequests: false,
};

describe("screenerMode says when a takeover was asked for", () => {
  it("a stopped holder, the stamp standing: blocked, and the takeover asked", () => {
    const role = screenerMode([{ ...READER, takeoverAuthorizedAt: STAMP }]);
    expect(role.mode).toBe("blocked");
    expect(role.takeoverAsked).toBe(true);
  });
  it("no holder ever, the stamp standing: blocked on nobody, and the takeover asked", () => {
    const role = screenerMode([{ ...READER, organizedBy: null, organizerState: null, takeoverAuthorizedAt: STAMP }]);
    expect(role.reason).toBe("no_organizer");
    expect(role.takeoverAsked).toBe(true);
  });
  it("CONTROL: no stamp, no takeover asked", () => {
    expect(screenerMode([{ ...READER, takeoverAuthorizedAt: null }]).takeoverAsked).toBeUndefined();
  });
});

describe("the Screener's wall lets a requested takeover's decision reach the door", () => {
  it("a decision on a blocked reader with the takeover asked is dispatched", async () => {
    const store = await freshStore();
    const role = screenerMode([{ ...READER, takeoverAuthorizedAt: STAMP }]);
    const s = await mountState(engineOver(store), role);
    await act(async () => {
      s.get().decide(s.get().waiting[0]!, "ohbox", { read: false, scope: "sender" });
    });
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(sent.map((m) => m.kind), "the decision never left this install").toContain("screener_decide");
    expect(toasts.join(" "), "the refusal was raised over a requested takeover").not.toContain(en.screener.readerRefusedUnknown);
  });

  it("CONTROL: the same reader with no takeover asked is still walled", async () => {
    const store = await freshStore();
    const s = await mountState(engineOver(store), screenerMode([{ ...READER, takeoverAuthorizedAt: null }]));
    await act(async () => {
      s.get().decide(s.get().waiting[0]!, "ohbox", { read: false, scope: "sender" });
    });
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(sent).toHaveLength(0);
  });

  it("walled over NOBODY: the sentence names no other organizer", async () => {
    const store = await freshStore();
    const s = await mountState(engineOver(store),
      screenerMode([{ ...READER, organizedBy: null, organizerState: null, takeoverAuthorizedAt: null }]));
    await act(async () => {
      s.get().decide(s.get().waiting[0]!, "ohbox", { read: false, scope: "sender" });
    });
    // The shell's one nobody sentence (`whyRefused.nobody`), which a holder nothing names reads.
    expect(toasts).toEqual([`${en.screener.notFiled} ${en.ohbox.whyRefused.nobody}`]);
    expect(toasts[0]).not.toContain("another ohmail organizer");
    expect(de.ohbox.whyRefused.nobody).toBeTruthy();
  });
});
