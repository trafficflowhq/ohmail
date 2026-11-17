/**
 * THE SCREENER'S TEST WORLD: its words, a model double that records what the panes ask of it, and the place mounted
 * alone in the real frame over the fake host.
 */
import { render, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ScreenerState } from "@ohmail/app-logic/screener";
import type { FrameStages } from "../../src/frame/contract.js";
import { Frame } from "../../src/frame/Frame.js";
import { KeymapProvider } from "../../src/keys/index.js";
import { NONE } from "../../src/host/index.js";
import { ScreenerAbove, screenerPlace, type ScreenerBeside } from "../../src/screener/index.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import type { OhmailEngine } from "@ohmail/client-engine";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, fakeWindow, type FakeAddress } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";
import screenerEn from "../../messages/screener.en.json" with { type: "json" };
import screenerDe from "../../messages/screener.de.json" with { type: "json" };
import sharedEn from "../../messages/shared.en.json" with { type: "json" };
import sharedDe from "../../messages/shared.de.json" with { type: "json" };

export const WORDS: Record<"en" | "de", Messages> = {
  en: { ...FRAME_WORDS.en, ...screenerEn, ...sharedEn } as Messages,
  de: { ...FRAME_WORDS.de, ...screenerDe, ...sharedDe } as Messages,
};

/** What the panes asked of the model. */
export interface Asked {
  flushes: number;
  decided?: { id: string; dest: string; read: boolean; scope?: string }[];
  loads?: number;
  rereads?: number;
  filedFailed?: [string, string][];
}

/** A model double: the settled, empty queue unless `over` says otherwise; `flush` is counted in `asked`. */
export function modelOf(asked: Asked, over: Partial<ScreenerState> = {}): ScreenerState {
  return {
    waiting: [],
    waitingCount: 0,
    waitingSource: "store",
    queueSettled: true,
    storeSettled: true,
    screenedOut: [],
    spam: [],
    pending: [],
    decided: [],
    notApplied: [],
    failedAtGate: [],
    suggestedCount: 0,
    suggestedDests: [],
    applying: null,
    copyBehind: false,
    queueAnswered: true,
    role: { mode: "organizer", name: null, reason: null, oauthOnly: false },
    waitingMore: {
      available: false,
      loading: false,
      failed: false,
      load: () => (asked.loads = (asked.loads ?? 0) + 1),
    },
    rereadWaiting: () => (asked.rereads = (asked.rereads ?? 0) + 1),
    isExiting: () => false,
    refused: () => false,
    decide: (s: { id: string }, dest: string, opts: { read: boolean; scope: string }) =>
      (asked.decided ??= []).push({ id: s.id, dest, read: opts.read, scope: opts.scope }),
    reachOf: () => ({ others: [], inboxIds: [] }),
    unsubClaimOf: () => "none",
    fileFailed: (id: string, to: string) => (asked.filedFailed ??= []).push([id, to]),
    flush: () => {
      asked.flushes += 1;
    },
    ...over,
  } as unknown as ScreenerState;
}

/** What the engine was asked: the body requests, and every change (none, from this folder). */
export interface EngineAsked {
  bodies: string[];
  mutations: unknown[];
}

/**
 * A recording engine: it answers the bodies it is given (`message_body` rows) and records what it is asked. The
 * Screener's folder asks it for bodies only; a change through it would be a second press seam. `land` writes a body
 * later and tells whoever listens, as a sync's write does.
 */
export function screenerEngine(bodies: Record<string, unknown> = {}): {
  engine: OhmailEngine;
  asked: EngineAsked;
  land: (id: string, body: unknown) => void;
} {
  const asked: EngineAsked = { bodies: [], mutations: [] };
  const listeners = new Set<() => void>();
  const reader = {
    get: (type: string, id: string) => (type === "message_body" ? bodies[id] : undefined),
    list: () => [],
    entries: () => [],
    version: () => 1,
  };
  const engine = {
    read: () => reader,
    verbRead: () => reader,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    mutate: async (m: unknown) => {
      asked.mutations.push(m);
      return { status: "confirmed" };
    },
    hydrateBodies: async (ids: string[], opts?: { urgent?: boolean }) => {
      asked.bodies.push(`${ids.join(",")}${opts?.urgent ? " urgent" : ""}`);
    },
    hydrateBody: async (id: string, opts?: { retry?: boolean }) => {
      asked.bodies.push(`${id}${opts?.retry ? " retry" : ""}`);
    },
  } as unknown as OhmailEngine;
  const land = (id: string, body: unknown) => {
    bodies[id] = body;
    for (const listener of listeners) listener();
  };
  return { engine, asked, land };
}

export const BESIDE: ScreenerBeside = {
  letters: NONE,
  junk: NONE,
  unsubscribe: NONE,
  mailboxWord: () => null,
  suggest: NONE,
  invitation: NONE,
  facts: { settled: true, owed: false, storeImportOpen: false, notOrganizingYet: null },
  undo: () => false,
};

export function inWords(children: ReactNode, lang: "en" | "de" = "en"): ReactNode {
  return (
    <TextProvider locale={lang} messages={WORDS[lang]} timeZone="UTC">
      {children}
    </TextProvider>
  );
}

export interface PlaceWorld {
  view: RenderResult;
  address: FakeAddress;
  /** Draw again with another model (a new answer of the hook). */
  again(model: ScreenerState): void;
}

/** A waiting sender with one held letter. */
export function sender(id: string, name: string, over: Record<string, unknown> = {}) {
  return {
    id,
    segment: "waiting",
    from: { name, address: `${id}@${id}.example` },
    initial: name[0],
    time: "09:00",
    scope: "sender",
    derived: true,
    ai: null,
    held: [
      {
        id: `${id}-1`,
        subject: `A letter from ${name}`,
        time: "09:00",
        body: "",
        snippet: "The first words",
      },
    ],
    ...over,
  } as never;
}

/** The Screener's place in the real frame, `ScreenerAbove` standing over it as the seating step stands it. */
export function mountPlace(
  model: ScreenerState,
  opts: {
    at?: string;
    beside?: ScreenerBeside;
    room?: "desktop" | "phone";
    lang?: "en" | "de";
    engine?: OhmailEngine;
    /** The stages the host hands (the first run's, for a press that opens it). */
    stages?: Partial<FrameStages>;
  } = {},
): PlaceWorld {
  const address = fakeAddress(opts.at ?? "#/screener");
  const { host } = fakeHost({
    engine: opts.engine ?? screenerEngine().engine,
    service: "self",
    scope: "acct-1",
    places: { screener: screenerPlace },
    stages: opts.stages,
    address,
    window: fakeWindow(opts.room ?? "desktop"),
  });
  const tree = (m: ScreenerState) =>
    inWords(
      <KeymapProvider>
        <ScreenerAbove model={m} beside={opts.beside ?? BESIDE}>
          <Frame host={host} />
        </ScreenerAbove>
      </KeymapProvider>,
      opts.lang,
    );
  const view = render(tree(model));
  return { view, address, again: (m) => view.rerender(tree(m)) };
}
