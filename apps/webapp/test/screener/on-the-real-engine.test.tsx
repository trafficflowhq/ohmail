/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect, useMemo, useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryMirrorStore, OhmailEngine, type SyncChange } from "@ohmail/client-engine";
import { createUndoDoor } from "@ohmail/app-logic/press/undo-door";
import { useScreenerModel, type ScreenerText, type SuggestionOverlay } from "@ohmail/app-logic/screener";
import type { Translator } from "@ohmail/app-logic/text/translator";
import { Frame } from "@ohmail/app/frame";
import { KeymapProvider } from "../../../../test/support/keymap-provider";
import { NONE } from "@ohmail/app/host";
import { ScreenerAbove, screenerPlace, type ScreenerBeside } from "@ohmail/app/screener";
import { TextProvider, useTextLookup, type Messages } from "@ohmail/app/text";
import { TestConsent } from "../../../../packages/app/test/screener/screener-world.js";
import { fakeHost } from "../../../../packages/app/test/support/fake-host.js";
import { fakeAddress, fakeWindow } from "../../../../packages/app/test/support/fake-window.js";
import en from "../../messages/en.json";

/**
 * THE SCREENER'S PLACE OVER THE REAL ENGINE: the one model the seating step makes (`useScreenerModel`) over a real
 * mirror and an engine whose server records every change it is sent, the frame's one undo door, `ScreenerAbove` and
 * the place in the real frame. A decision sends one change when its window closes (here: the list leaves its
 * section, which commits at once); a decision taken back with `z` inside the window sends none; opening and walking
 * the queue send nothing; a row's accept pressed again while its decision waits files it once (the model's guard).
 */

const NOW = new Date("2026-08-02T12:00:00.000Z");
/* The web's catalogue, as the web shell hands the frame its words. */
const WORDS = en as unknown as Messages;

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
});
afterEach(cleanup);

function held(id: string, from: string, hour: number): EngineMessage {
  return {
    id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: `Subject ${id}`,
    from: { name: null, address: from },
    to: [],
    cc: [],
    date: `2026-08-02T${String(hour).padStart(2, "0")}:00:00.000Z`,
    folder: "ohmail/Screener",
    snippet: `snippet ${id}`,
    unread: true,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: {
      sensitive: false,
      category: null,
      no_ai: false,
      no_forward: false,
      no_kb: false,
      priority: false,
    },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

/** The server: it records each change it is sent, by kind, and answers as a server that took it. */
async function world() {
  const sent: string[] = [];
  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  await store.applyChanges(
    ["ada@one.example", "ben@two.example", "cleo@three.example"].map((from, i): SyncChange => ({
      type: "message",
      op: "create",
      id: `m${i}`,
      seq: ++seq,
      updatedAt: "2026-08-02T09:00:00.000Z",
      entity: held(`m${i}`, from, 9 + i),
    })),
  );
  const engine = new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(),
        hasMore: false,
        serverTime: NOW.toISOString(),
      }),
      mutate: async (m: { kind?: string }) => {
        sent.push(m.kind ?? "?");
        return { changes: [], seq: null };
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => null,
    } as never,
  });
  return { engine, sent };
}

/**
 * The seating step's own work, done here: one model over the engine, the frame's undo door beside it. `said` records
 * each sentence the door raises; `suggestions` is the session's bought advice, by sender.
 */
function Seated({
  engine,
  said,
  suggestions,
}: {
  engine: OhmailEngine;
  said: string[];
  suggestions: SuggestionOverlay | null;
}) {
  const lookup = useTextLookup();
  const [version, setVersion] = useState(0);
  useEffect(() => engine.subscribe(() => setVersion((v) => v + 1)), [engine]);
  const door = useMemo(() => createUndoDoor((line) => void said.push(line)), [said]);
  const text = useMemo(
    (): ScreenerText => ({
      screener: lookup("screener") as unknown as Translator,
      screening: lookup("screening") as unknown as Translator,
      ohbox: lookup("ohbox") as unknown as Translator,
      session: lookup("session") as unknown as Translator,
      piles: { ohbox: "Ohbox", reads: "News", receipts: "Receipts", screened: "Screened out", spam: "Spam" },
      places: {},
      locale: "en",
      zone: () => "UTC",
    }),
    [lookup],
  );
  const model = useScreenerModel({
    engine,
    scope: "acct-1",
    version,
    toast: door.toast,
    text,
    suggestions,
    presented: null,
    autoUnsubscribe: false,
    role: { mode: "organizer", name: null, reason: null, oauthOnly: false, pressRefusal: null },
    outstanding: [],
    ownAddresses: [],
    shownAt: () => [],
    decisionVerdict: null,
    releaseWindow: null,
  });
  const { host } = useMemo(
    () =>
      fakeHost({
        engine,
        service: "self",
        scope: "acct-1",
        places: { screener: screenerPlace },
        address: fakeAddress("#/screener"),
        window: fakeWindow("desktop"),
      }),
    [engine],
  );
  const beside = useMemo(
    (): ScreenerBeside => ({
      letters: NONE,
      junk: NONE,
      unsubscribe: NONE,
      mailboxWord: () => null,
      suggest: NONE,
      invitation: NONE,
      facts: { settled: true, owed: false, storeImportOpen: false, notOrganizingYet: null },
      undo: door.press,
    }),
    [door],
  );
  return (
    <ScreenerAbove model={model} beside={beside}>
      <Frame host={host} />
    </ScreenerAbove>
  );
}

async function mount(suggestions: SuggestionOverlay | null = null) {
  const { engine, sent } = await world();
  const said: string[] = [];
  render(
    <TextProvider locale="en" messages={WORDS} timeZone="UTC">
      <KeymapProvider>
        <TestConsent scope="acct-1" transport="none">
          <Seated engine={engine} said={said} suggestions={suggestions} />
        </TestConsent>
      </KeymapProvider>
    </TextProvider>,
  );
  await settle();
  return { sent, said };
}

const settle = async () => {
  for (let i = 0; i < 12; i++)
    await act(async () => {
      await Promise.resolve();
    });
};
const press = async (key: string) => {
  await act(async () => {
    fireEvent.keyDown(document.body, { key });
  });
  await settle();
};
const leaveForScreenedOut = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^Screened out/ }));
  });
  await settle();
};

describe("the Screener over the real engine", () => {
  it("opening and walking the queue sends nothing", async () => {
    const { sent } = await mount();
    expect(screen.getAllByRole("option")).toHaveLength(3);
    await press("j");
    await press("k");
    await leaveForScreenedOut();
    expect(sent).toEqual([]);
  });

  it("a decision sends one change when its window closes", async () => {
    const { sent } = await mount();
    await press("o");
    expect(sent).toEqual([]);
    await leaveForScreenedOut();
    expect(sent).toEqual(["screener_decide"]);
  });

  it("a row's accept pressed again while its decision waits files it once", async () => {
    const news = new Map([["ben@two.example", { dest: "reads", confidence: 0.9, rationale: "" }]]);
    const { sent, said } = await mount(news as unknown as SuggestionOverlay);
    const accept = within(screen.getByRole("listbox", { name: "Screener" })).getByRole("button", {
      name: "News",
    });
    await act(async () => {
      fireEvent.click(accept);
      fireEvent.click(accept);
    });
    await settle();
    expect(said).toHaveLength(1);
    await leaveForScreenedOut();
    expect(sent).toEqual(["screener_decide"]);
  });

  it("a decision taken back with z inside its window sends none", async () => {
    const { sent } = await mount();
    await press("o");
    await press("z");
    await leaveForScreenedOut();
    expect(sent).toEqual([]);
    expect(screen.getByRole("button", { name: /^Screened out/ })).toBeTruthy();
  });
});
