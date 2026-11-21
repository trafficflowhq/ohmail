/** @vitest-environment jsdom */
import type { EngineMessage, EngineMutation, Folder, RuleEntity } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, within } from "@testing-library/react";
import { TextProvider } from "@ohmail/app/text";
import { useScreenerWords } from "../../../packages/app/src/screener/words.js";
import {
  OhmailEngine,
  MemoryMirrorStore,
  type MirrorStore,
} from "@ohmail/client-engine";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { settleFirstPaint } from "./_first-paint.js";
import {
  screenerMode, type ScreenerRole,
} from "@ohmail/app-logic/mail-state/mail-state";
import { postureRefusal, rulesPostureOf } from "@ohmail/app-logic/press/rules-posture";
import { act, answerSyncWith, installShellEnv, mailbox, mountShell, teardownShellEnv, tick } from "./fixtures/live-walk-shell.js";
import type { ScreenerState } from "@ohmail/app-logic/screener/screener-state";

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
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-02T12:00:00.000Z");
const HOLDER = "Studio laptop";
const LIVE_ROW = {
  id: "mb_1", address: "me@example.test", status: "connected", disabledReason: null,
  organizerRole: "reader" as const,
  organizerChecked: true,
  organizedBy: { kind: "local", name: HOLDER, since: "2026-09-01T09:00:00.000Z" },
  organizerState: "held" as const,
  organizeConsentedAt: "2026-09-01T09:00:00.000Z",
};
/** The same claim, left by a machine that stopped renewing it. */
const STOPPED_ROW = { ...LIVE_ROW, organizerState: "stopped" as const };

/** The model role from mailbox facts: the roster's mode, and the refusal a press would meet. */
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
    id, accountId: "acct_live_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: "Terrace Review", address: from }, to: [], cc: [],
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

async function freshStore(list: EngineMessage[] = [HELD], allowSender = false): Promise<MirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(list.map((m) => ({
    type: "message" as const, op: "create" as const, id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })));
  if (allowSender) {
    const rule: RuleEntity = {
      id: "allow", kind: "sender", match: HELD.from.address, destination: "INBOX", priority: 0,
      provenance: "manual", enabled: true, subjectContains: null, bodyContains: null,
      stats: { hits: 0, lastHitAt: null, demotions: 0 },
      createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      retro: { requestedAt: null, doneAt: null },
    };
    await store.applyChanges([{ type: "rule", op: "create", id: rule.id, seq: ++seq, updatedAt: rule.updatedAt, entity: rule }]);
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
    root!.render(h(TextProvider, {
      locale, messages: locale === "de" ? de : en, timeZone: "UTC", now: NOW, children: node,
    }));
  });
  await settleFirstPaint();
  return host;
}

/** The real Screener state over the real catalogue, read through a getter. */
async function screenerState(role: ScreenerRole, locale: "en" | "de" = "en"): Promise<() => ScreenerState> {
  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  const engine = engineOver(await freshStore());
  let latest: ScreenerState | null = null;
  function Probe(): null {
    latest = useScreenerState(
      engine, null, 0, ((m: string) => { toasts.push(m); }) as never, useScreenerWords(), undefined, undefined, true, role,
    );
    return null;
  }
  await render(h(Probe), locale);
  return () => latest!;
}

beforeEach(() => {
  installShellEnv();
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
  await teardownShellEnv();
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
      expect(await previewNote("screened", STOPPED_ROW, locale)).toContain(cat.screener.readerBarNoneTitle);
      expect(sent).toEqual([]);
    });
  }

  it("CONTROL: a holder that still renews is named", async () => {
    const s = await screenerState(roleOf([LIVE_ROW]));
    await act(async () => { s().allowScreened(s().waiting[0]!, "ohbox"); });
    expect(toasts).toEqual([named(en.screener.readerMoveRefused)]);
    expect(await previewNote("screened", LIVE_ROW)).toContain(named(en.screener.place.decides));
    expect(sent).toEqual([]);
  });
});

describe("the Screener's decision refusal, from the role alone", () => {
  /* `screenerMode`'s role without the press refusal beside it: the decider's answer rides the role
     itself, so a caller that passes only the role cannot name a machine that stopped. */
  it("a holder that stopped: nothing organizes it", async () => {
    const s = await screenerState(screenerMode([STOPPED_ROW]));
    await act(async () => { s().decide(s().waiting[0]!, "ohbox", { read: false, scope: "sender" }); });
    expect(sent).toEqual([]);
    const refusal = `${en.screener.notFiled} ${en.ohbox.whyRefused.nobody}`;
    expect(toasts).toEqual([refusal]);
    await pressWaitingDecision(STOPPED_ROW, refusal);
  });

  it("CONTROL: a holder that still renews is named", async () => {
    const s = await screenerState(screenerMode([LIVE_ROW]));
    await act(async () => { s().decide(s().waiting[0]!, "ohbox", { read: false, scope: "sender" }); });
    const refusal = named(en.screener.readerRefused);
    expect(toasts).toEqual([refusal]);
    await pressWaitingDecision(LIVE_ROW, refusal);
  });
});

async function mountReader(
  letter: EngineMessage,
  row: typeof LIVE_ROW | typeof STOPPED_ROW,
  locale: "en" | "de",
  route: string,
) {
  window.location.hash = route;
  const webContactScreening = route === "#/ohbox";
  const store = await freshStore([letter], webContactScreening);
  if (webContactScreening) {
    answerSyncWith(() => Response.json({
      changes: { creates: [
        { type: "message", op: "create", id: letter.id, seq: 1, updatedAt: letter.updatedAt, entity: letter },
        ...store.list<RuleEntity>("rule").map((rule) => ({
          type: "rule", op: "create", id: rule.id, seq: 2, updatedAt: rule.updatedAt, entity: rule,
        })),
      ], updates: [], moves: [], deletes: [] },
      cursor: "c2", hasMore: false, serverTime: NOW.toISOString(),
    }));
  }
  const shell = await mountShell([mailbox({ ...row, lastSyncAt: NOW.toISOString() })], {
    ...(webContactScreening ? { webContactScreening } : { engine: engineOver(store) }),
    locale, junkWire: "none", suggestWire: "none",
  });
  await tick(50);
  return within(shell);
}

async function pressWaitingDecision(row: typeof LIVE_ROW | typeof STOPPED_ROW, refusal: string) {
  const shell = await mountReader(HELD, row, "en", "#/screener");
  const sender = shell.getByRole("option", { name: /Terrace Review/ });
  await act(async () => { sender.click(); });
  await tick(0);
  expect(shell.getByRole("option", { name: /Terrace Review/, selected: true })).toBe(sender);
  await act(async () => { fireEvent.keyDown(sender, { key: "o", code: "KeyO" }); });
  await tick(0);
  expect(within(document.body).queryAllByRole("status").map((status) => status.textContent?.trim())).toContain(refusal);
  expect(sent).toEqual([]);
}

async function previewNote(
  segment: "screened" | "spam",
  row: typeof LIVE_ROW | typeof STOPPED_ROW,
  locale: "en" | "de" = "en",
) {
  const folder = segment === "screened" ? "ohmail/Screened" : "ohmail/Quarantine";
  const shell = await mountReader({ ...HELD, folder }, row, locale, `#/screener/${segment}`);
  const sender = shell.getByRole("option", { name: /Terrace Review/ });
  await act(async () => { sender.click(); });
  await tick(0);
  const copy = (locale === "de" ? de : en).screener;
  const toolbar = shell.getByRole("toolbar", { name: copy.place.panel });
  const panel = within(toolbar);
  expect(panel.getAllByRole("button")).toEqual([panel.getByRole("button", { name: copy.readerBarOpenMailboxes })]);
  return toolbar.textContent ?? "";
}

describe("the screened and spam previews' reader note", () => {
  for (const segment of ["screened", "spam"] as const) {
    it(`${segment}: a holder that stopped reads as nothing organizing it`, async () => {
      const text = await previewNote(segment, STOPPED_ROW);
      expect(text).toContain(en.screener.readerBarNoneTitle);
      expect(text, "a machine that stopped was called the organizer").not.toContain(HOLDER);
      expect(text).not.toContain(en.screener.place.decidesUnknown);
    });

    it(`${segment}: in German too`, async () => {
      const text = await previewNote(segment, STOPPED_ROW, "de");
      expect(text).toContain(de.screener.readerBarNoneTitle);
      expect(text).not.toContain(HOLDER);
    });

    it(`${segment}: CONTROL — a holder that still renews is named`, async () => {
      const text = await previewNote(segment, LIVE_ROW);
      expect(text).toContain(named(en.screener.place.decides));
    });
  }
});

describe("the sender sheet's organizer line", () => {
  async function senderSheet(row: typeof LIVE_ROW | typeof STOPPED_ROW, locale: "en" | "de" = "en") {
    const letter = { ...HELD, folder: "INBOX" as const, unread: false };
    const shell = await mountReader(letter, row, locale, "#/ohbox");
    const option = shell.getByRole("option", { name: /Subject h1/ });
    await act(async () => { option.click(); });
    await tick(50);
    const copy = (locale === "de" ? de : en).screening;
    const sender = within(option).getByRole("button", { name: copy.openFor.replace("{sender}", letter.from.name!) });
    await act(async () => { sender.click(); });
    await tick(0);
    return within(within(document.body).getByRole("dialog", {
      name: copy.aria.replace("{sender}", letter.from.address),
    }));
  }

  async function subjectSheet(sheet: ReturnType<typeof within>, copy: typeof en) {
    await act(async () => { sheet.getByRole("menuitem", { name: copy.screening.cardSubject }).click(); });
    return within(document.body).getByRole("dialog", {
      name: copy.screening.subjectAria.replace("{who}", HELD.from.address),
    });
  }

  it("a holder that stopped: nothing organizes it, en and de", async () => {
    const english = await senderSheet(STOPPED_ROW);
    expect(english.getByText(en.screening.orgNobody)).toBeTruthy();
    expect(within(await subjectSheet(english, en)).getByText(en.screening.subjectOrgNobody)).toBeTruthy();
    await teardownShellEnv();
    installShellEnv();
    const german = await senderSheet(STOPPED_ROW, "de");
    expect(german.getByText(de.screening.orgNobody)).toBeTruthy();
    expect(within(await subjectSheet(german, de)).getByText(de.screening.subjectOrgNobody)).toBeTruthy();
  });

  it("CONTROL: a holder that still renews is named", async () => {
    const card = await senderSheet(LIVE_ROW);
    expect(card.getByText(named(en.screening.orgPending))).toBeTruthy();
    const subject = within(await subjectSheet(card, en));
    expect(subject.queryByText(en.screening.subjectOrgNobody)).toBeNull();
    const mutations = () => vi.mocked(globalThis.fetch).mock.calls.filter(([url, init]) =>
      init?.method === "POST" && /\/(?:rules|messages\/[^/]+\/move)$/.test(String(url)));
    const before = mutations().length;
    await act(async () => { subject.getByRole("option", { name: /^News/ }).click(); });
    await act(async () => {
      subject.getByRole("button", { name: en.screening.subjectConfirmGo.replace("{dest}", "News") }).click();
    });
    await tick(0);
    expect(within(document.body).queryAllByRole("status").map((status) => status.textContent?.trim()))
      .toContain(named(en.ohbox.whyRefused.outdated));
    expect(mutations()).toHaveLength(before);
  });
});
