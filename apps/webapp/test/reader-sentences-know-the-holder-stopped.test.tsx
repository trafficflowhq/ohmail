/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine,
  MemoryMirrorStore,
  consentPartition,
  type EngineMessage,
  type EngineMutation,
  type Folder,
  type MirrorStore,
} from "@ohmail/client-engine";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { settleFirstPaint } from "./_first-paint.js";
import {
  otherOrganizerOf, readerMoveRefusal, screenerMode, type ScreenerRole,
} from "@ohmail/app-logic/mail-state/mail-state";
import { postureRefusal, rulesPostureOf } from "@ohmail/app-logic/press/rules-posture";
import { ScreenerView } from "../app/views/ScreenerView";
import { SenderMenu } from "../app/shell/SenderMenu";
import { senderScreening } from "@ohmail/app-logic/press/sender-screening";
import { KeymapProvider } from "../app/shell/keymap";
import type { ScreenerState } from "../app/shell/screener-state";

/**
 * A MACHINE THAT STOPPED ORGANIZING IS NOT CALLED THE ORGANIZER by the web's reader sentences: the
 * Screener's move refusal, its screened and spam preview notes, the message verbs' refusal and the
 * sender sheet. Each named the first recorded holder whether or not its lease had lapsed; each now
 * asks the refusal's decider and says nothing organizes the mailbox, pointing to Organize here. The
 * rows are real roster facts through `screenerMode`, the text is what renders, en and de, and a
 * holder that still renews is the control on every site.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-02T12:00:00.000Z");
const HOLDER = "Studio laptop";
const LIVE_ROW = {
  id: "mb", address: "me@example.test", status: "connected", disabledReason: null,
  organizerRole: "reader" as const,
  organizedBy: { kind: "local", name: HOLDER, since: "2026-09-01T09:00:00.000Z" },
  organizerState: "held" as const,
  organizeConsentedAt: "2026-09-01T09:00:00.000Z",
};
/** The same claim, left by a machine that stopped renewing it. */
const STOPPED_ROW = { ...LIVE_ROW, organizerState: "stopped" as const };

/** The role as `AppShell` composes it: the roster's mode, and the refusal a press would meet. */
const roleOf = (rows: readonly (typeof LIVE_ROW | typeof STOPPED_ROW)[]) =>
  ({ ...screenerMode(rows), pressRefusal: postureRefusal(rulesPostureOf(rows)) });
const named = (s: string) => s.replace("{name}", HOLDER);

let seq = 0;
let sent: EngineMutation[] = [];
let toasts: string[] = [];
let root: Root | null = null;
let host: HTMLDivElement | null = null;

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

const HELD = msg("h1", "editors@terracereview.invalid", "ohmail/Screener");

async function freshStore(list: EngineMessage[] = [HELD]): Promise<MirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(list.map((m) => ({
    type: "message" as const, op: "create" as const, id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })));
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
      mutate: async (m) => { sent.push(m); return { changes: [], seq: null }; },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => ({
        text: "body", html: null, loadedRemoteContent: false,
        unsubscribe: "no_header", unsubscribeUrl: null,
      }),
    },
  });
}

async function render(node: React.ReactElement, locale: "en" | "de" = "en"): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale, messages: (locale === "de" ? de : en) as never, timeZone: "UTC", now: NOW, children: node,
    }));
  });
  await settleFirstPaint();
  return host;
}

/** The real Screener state over the real catalogue, read through a getter. */
async function screenerState(role: ScreenerRole, locale: "en" | "de" = "en"): Promise<() => ScreenerState> {
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  const engine = engineOver(await freshStore());
  let latest: ScreenerState | null = null;
  function Probe(): null {
    latest = useScreenerState(
      engine, 0, ((m: string) => { toasts.push(m); }) as never, undefined, undefined, true, role,
    );
    return null;
  }
  await render(h(Probe), locale);
  return () => latest!;
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
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("the role a reader's Screener is built from", () => {
  it("names no machine that stopped, and says nobody organizes (the decider's no_organizer)", () => {
    expect(screenerMode([STOPPED_ROW])).toMatchObject({ mode: "blocked", name: null, reason: "no_organizer" });
    expect(screenerMode([LIVE_ROW]), "CONTROL").toMatchObject({ mode: "blocked", name: HOLDER, reason: "organizer_outdated" });
  });
});

describe("the Screener's move refusal", () => {
  for (const locale of ["en", "de"] as const) {
    const cat = locale === "de" ? de : en;
    it(`a holder that stopped: nothing organizes it (${locale})`, async () => {
      const s = await screenerState(roleOf([STOPPED_ROW]), locale);
      await act(async () => { s().allowScreened(s().waiting[0]!, "ohbox"); });
      expect(sent, "a move reached the wire from a reader").toEqual([]);
      expect(toasts).toEqual([cat.screener.readerMoveRefusedNobody]);
    });
  }

  it("CONTROL: a holder that still renews is named", async () => {
    const s = await screenerState(roleOf([LIVE_ROW]));
    await act(async () => { s().allowScreened(s().waiting[0]!, "ohbox"); });
    expect(toasts).toEqual([named(en.screener.readerMoveRefused)]);
  });
});

describe("the Screener's decision refusal, from the role alone", () => {
  /* `screenerMode`'s role without the press refusal beside it: the decider's answer rides the role
     itself, so a caller that passes only the role cannot name a machine that stopped. */
  it("a holder that stopped: nothing organizes it", async () => {
    const s = await screenerState(screenerMode([STOPPED_ROW]));
    await act(async () => { s().decide(s().waiting[0]!, "ohbox", { read: false, scope: "sender" }); });
    expect(sent).toEqual([]);
    expect(toasts).toEqual([`${en.screener.notFiled} ${en.ohbox.whyRefused.nobody}`]);
  });

  it("CONTROL: a holder that still renews is named", async () => {
    const s = await screenerState(screenerMode([LIVE_ROW]));
    await act(async () => { s().decide(s().waiting[0]!, "ohbox", { read: false, scope: "sender" }); });
    expect(toasts).toEqual([named(en.screener.readerRefused)]);
  });
});

/** A `ScreenerState` double for the screened and spam previews: one sender in each. */
function previewState(role: ScreenerRole): ScreenerState {
  const sender = {
    id: "s1",
    from: { name: "Terrace Review", address: "editors@terracereview.invalid" },
    initial: "T", derived: true, scope: "sender" as const, ai: null,
    held: [{
      id: "h1", subject: "Spring issue", time: "09:00", body: "body", html: null,
      bodyState: "ready" as const, unsubscribe: "no_header" as const, unsubscribeUrl: null,
      trackerNote: null,
    }],
  };
  return {
    waiting: [], waitingCount: 0, suggestedCount: 0, suggestedDests: [],
    unsuggestedSenders: [], suggestedSenders: [], applying: null,
    screenedOut: [sender], spam: [{ sender, pinned: false }],
    isExiting: () => false, refused: () => false, bodyStall: () => null,
    flush: () => {}, role, pending: [], decided: [], notApplied: [],
    waitingSource: "store", waitingMore: { available: false, loading: false, failed: false, load: () => {} }, rereadWaiting: () => {},
  } as unknown as ScreenerState;
}

async function previewNote(segment: "screened" | "spam", role: ScreenerRole, locale: "en" | "de" = "en") {
  const el = await render(h(KeymapProvider, {
    children: h(ScreenerView, {
      state: previewState(role), segment, selection: { waiting: null, screened: "s1", spam: "s1" },
      settled: true, owed: false, onSelect: () => {}, hydrateBody: () => {}, hydrateBodies: () => {}, full: false, onFull: () => {},
    } as never),
  }), locale);
  const note = el.querySelector(".scn-reader");
  expect(note, `no reader note on the ${segment} preview`).not.toBeNull();
  return note!.textContent ?? "";
}

describe("the screened and spam previews' reader note", () => {
  for (const segment of ["screened", "spam"] as const) {
    it(`${segment}: a holder that stopped reads as nothing organizing it`, async () => {
      const text = await previewNote(segment, roleOf([STOPPED_ROW]));
      expect(text).toContain(en.screener.moveBarWhyNobody);
      expect(text, "a machine that stopped was called the organizer").not.toContain(HOLDER);
      expect(text).not.toContain(en.screener.moveBarWhyUnknown);
    });

    it(`${segment}: in German too`, async () => {
      const text = await previewNote(segment, roleOf([STOPPED_ROW]), "de");
      expect(text).toContain(de.screener.moveBarWhyNobody);
      expect(text).not.toContain(HOLDER);
    });

    it(`${segment}: CONTROL — a holder that still renews is named`, async () => {
      const text = await previewNote(segment, roleOf([LIVE_ROW]));
      expect(text).toContain(named(en.screener.moveBarWhy));
    });
  }
});

describe("the message verbs' refusal (readerMoveRefusal)", () => {
  const say = (cat: typeof en) => ({
    named: (name: string) => cat.screener.readerMoveRefused.replace("{name}", name),
    unknown: () => cat.screener.readerMoveRefusedUnknown,
    nobody: () => cat.screener.readerMoveRefusedNobody,
  });

  it("a holder that stopped: nothing organizes it, en and de", () => {
    const roster = { kind: "known" as const, rows: [STOPPED_ROW] };
    expect(readerMoveRefusal(roster, ["mb"], say(en))).toBe(en.screener.readerMoveRefusedNobody);
    expect(readerMoveRefusal(roster, ["mb"], say(de as typeof en))).toBe(de.screener.readerMoveRefusedNobody);
  });

  it("CONTROL: a holder that still renews is named, and a pending roster names nobody", () => {
    expect(readerMoveRefusal({ kind: "known", rows: [LIVE_ROW] }, ["mb"], say(en)))
      .toBe(named(en.screener.readerMoveRefused));
    expect(readerMoveRefusal({ kind: "pending" }, ["mb"], say(en))).toBe(en.screener.readerMoveRefusedUnknown);
  });
});

describe("the sender sheet's organizer line", () => {
  async function sheetLine(
    rows: readonly (typeof LIVE_ROW | typeof STOPPED_ROW)[], locale: "en" | "de" = "en",
  ): Promise<string> {
    const store = await freshStore([msg("m1", "lena@atelier.example", "INBOX")]);
    const placeOf = consentPartition(store, { now: NOW }).placeOf;
    const sender = senderScreening(store, "m1", undefined, placeOf)!;
    const el = await render(h(SenderMenu, {
      state: { messageId: "m1", x: 0, y: 0 }, sender, onChoose: () => {}, onOpenDetail: () => {},
      onClose: () => {}, organizer: otherOrganizerOf(rows, new Set(["mb"])),
    } as never), locale);
    return el.querySelector(".sm-org")?.textContent ?? "";
  }

  it("a holder that stopped: nothing organizes it, en and de", async () => {
    expect(await sheetLine([STOPPED_ROW])).toBe(en.screening.orgNobody);
    await act(async () => root!.unmount());
    root = null;
    expect(await sheetLine([STOPPED_ROW], "de")).toBe(de.screening.orgNobody);
  });

  it("CONTROL: a holder that still renews is named", async () => {
    expect(await sheetLine([LIVE_ROW])).toBe(named(en.screening.orgPending));
  });
});
