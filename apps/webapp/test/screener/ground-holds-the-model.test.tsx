/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryMirrorStore, OhmailEngine, type EngineMessage, type SyncChange } from "@ohmail/client-engine";
import { EngineContext } from "@ohmail/app-logic/engine";
import { COMMIT_MS, useScreenerLive, type ScreenerLiveInput, type ScreenerText } from "@ohmail/app-logic/screener";
import { SYNC_SETTLED } from "@ohmail/app-logic/session/sync-scheduler";
import type { Translator } from "@ohmail/app-logic/text/translator";
import { Frame, useFrame, usePress, type PlaceEntry } from "@ohmail/app/frame";
import type { ConsentWire, HostCapabilities, HostWires, JunkWire, SuggestWire } from "@ohmail/app/host";
import { KeymapProvider } from "@ohmail/app/keys";
import { MailGround } from "@ohmail/app/mail";
import { ConsentMount, MailStateMount, PresentedMount } from "@ohmail/app/mail/ground";
import { useScreener, useScreenerBeside } from "@ohmail/app/screener";
import { TextProvider, type Messages } from "@ohmail/app/text";
import { fakeHost } from "../../../../packages/app/test/support/fake-host.js";
import { fakeAddress, fakeWindow } from "../../../../packages/app/test/support/fake-window.js";
import en from "../../messages/en.json";

/**
 * THE SCREENER'S ONE MODEL STANDS IN THE MAIL GROUND, FOR THE FRAME'S LIFE. Over a real mirror and an engine whose
 * server records every change it is sent, with the mail ground above the panes and two places that are not the
 * Screener: a decision about a sender pressed at one place is still in its window after a walk to the other, is taken
 * back there with `z`, and where it is not taken back it is filed once when its window closes, and never again. A
 * model made by a place would end with the place: the decision would be lost or filed at the walk.
 *
 * AND BESIDE THE MODEL, THE JUNK WINDOW AND THE SUGGESTION RUN, each over its host's own wire or none. Over none the
 * mail server's Junk folder is read by nobody and no suggestion is listed, priced or bought, though the account files
 * into folders and lets suggestions be bought without a press. Over a wire each is one instance for the frame's life:
 * the Junk folder is read at the mount and not again by a walk, and the batch nobody presses for is bought once.
 *
 * AND WHAT EACH ANSWER OF THE HOST DECIDES: the model is made once for the frame and never again by a walk; a decision
 * pressed under one account is filed by that account's engine alone when the account changes inside its window; an
 * account that did not opt in buys nothing without a press; a host that says nobody sends an unsubscribe offers no
 * press; a suggestion wire with no server behind it draws, lists, prices and buys nothing.
 */

/** The Screener's model, counted where it is made: the real hook runs, and each mount is counted while it stands. */
const models = vi.hoisted(() => ({ mounts: 0, live: 0 }));
vi.mock("@ohmail/app-logic/screener/screener-state", async (load) => {
  const real = await load<typeof import("@ohmail/app-logic/screener/screener-state")>();
  const { useEffect } = await import("react");
  return {
    ...real,
    useScreenerState: (...args: Parameters<typeof real.useScreenerState>) => {
      const model = real.useScreenerState(...args);
      useEffect(() => {
        models.mounts += 1;
        models.live += 1;
        return () => {
          models.live -= 1;
        };
      }, []);
      return model;
    },
  };
});

const NOW = new Date();
/* The web's catalogue, as the web shell hands the frame its words. */
const WORDS = en as unknown as Messages;

beforeEach(() => {
  models.mounts = 0;
  models.live = 0;
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function held(id: string, from: string, hoursAgo: number): EngineMessage {
  const at = new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [], date: at,
    folder: "ohmail/Screener", snippet: "hello", unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: at,
  } as unknown as EngineMessage;
}

/** The server: it records each change it is sent, by kind, and answers as a server that took it. */
async function world() {
  const sent: string[] = [];
  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  await store.applyChanges(
    ["ada@one.example", "ben@two.example"].map((from, i): SyncChange => ({
      type: "message", op: "create", id: `m${i}`, seq: ++seq, updatedAt: NOW.toISOString(), entity: held(`m${i}`, from, 2 + i),
    })),
  );
  const engine = new OhmailEngine({
    store,
    now: () => new Date(),
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
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
 * A place of the test's own (the Screener's id among them, never its panes): it reads the frame's one model, says
 * who waits and what stands beside the model, and lets the first in.
 */
function Elsewhere() {
  const model = useScreener();
  const { junk, suggest, unsubscribe } = useScreenerBeside();
  const { route, commands } = useFrame();
  return (
    <div>
      <p>{`at ${route.place}: ${model.waitingCount} waiting`}</p>
      <p>{junk === "none" ? "junk: none" : `junk: ${junk.phase}, ${junk.items.length} listed`}</p>
      <p>
        {suggest === "none"
          ? "suggest: none"
          : `suggest: ${suggest.priced ? "priced" : "unpriced"}, ${suggest.control.available} to ask about`}
      </p>
      <p>{unsubscribe === "none" ? "unsubscribe: none" : "unsubscribe: offered"}</p>
      {unsubscribe === "none" ? null : (
        <button type="button" onClick={() => void unsubscribe("m0")}>
          Unsubscribe from the letter m0
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          const first = model.waiting[0];
          if (first) model.decide(first, "ohbox", { read: false, scope: "sender" });
        }}
      >
        Let the first in
      </button>
      <button type="button" onClick={() => commands.go({ place: route.place === "news" ? "receipts" : "news" })}>
        Walk on
      </button>
      <button type="button" onClick={() => commands.go({ place: "screener" })}>
        To the Screener
      </button>
      <button type="button" onClick={() => commands.go({ place: "screener", sub: "spam" })}>
        To its third section
      </button>
    </div>
  );
}
const place = (id: "news" | "receipts" | "screener"): PlaceEntry => ({
  id, body: id, rail: null,
  panes: { kind: "wide", Wide: Elsewhere },
});

/** A host of the given account over the given engine, the mail ground above the three places, standing at `first`. */
function hostOf(engine: OhmailEngine, scope: string, first: string, wires: Partial<HostWires> = {}, can: Partial<HostCapabilities> = {}) {
  const { host } = fakeHost({
    engine, service: "self", scope,
    places: { news: place("news"), receipts: place("receipts"), screener: place("screener") },
    above: MailGround,
    wires,
    address: fakeAddress(first),
    window: fakeWindow("desktop"),
  });
  return { ...host, capabilities: { ...host.capabilities, ...can } };
}
const ui = (host: ReturnType<typeof hostOf>) => (
  <TextProvider locale="en" messages={WORDS} timeZone="UTC">
    <KeymapProvider>
      <Frame host={host} />
    </KeymapProvider>
  </TextProvider>
);

/** What a case's host answers beside the fake host's own: its wires, and what it says it can do. */
interface Over {
  readonly wires?: Partial<HostWires>;
  readonly can?: Partial<HostCapabilities>;
}

const settle = async () => {
  for (let i = 0; i < 12; i++)
    await act(async () => {
      await Promise.resolve();
    });
};
/** Long enough for a read at the mount, the stored answers' read and the batch nobody presses for. */
const rest = async () => {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 25));
    });
    await settle();
  }
};
async function mount(over: Over = {}) {
  const { engine, sent } = await world();
  render(ui(hostOf(engine, "acct-1", "#/reads", over.wires, over.can)));
  /* The queue's first derivation waits for the page to be idle (a timer): a case reads the queue once it stands. */
  await rest();
  return { sent };
}
const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
  await settle();
};
const windowCloses = async () => {
  await act(async () => {
    vi.advanceTimersByTime(COMMIT_MS + 1_000);
  });
  await settle();
};

describe("the Screener's one model in the mail ground", () => {
  it("a decision pressed at one place is filed once, after a walk to another, when its window closes there", async () => {
    const { sent } = await mount();
    /* The decision's window is a timer of the model's: from here the clock is the case's. */
    vi.useFakeTimers();
    expect(screen.getByText("at news: 2 waiting")).toBeTruthy();
    await click("Let the first in");
    expect(screen.getByText("at news: 1 waiting")).toBeTruthy();
    await click("Walk on");
    expect(screen.getByText("at receipts: 1 waiting"), "the walk lost the decision").toBeTruthy();
    expect(sent, "the decision was filed by the walk").toEqual([]);
    await windowCloses();
    expect(sent).toEqual(["screener_decide"]);
    await click("Walk on");
    await windowCloses();
    expect(sent, "the decision was filed a second time").toEqual(["screener_decide"]);
  });

  it("the Undo of a decision pressed at one place is taken at another with z, and nothing is filed", async () => {
    const { sent } = await mount();
    /* The decision's window is a timer of the model's: from here the clock is the case's. */
    vi.useFakeTimers();
    await click("Let the first in");
    await click("Walk on");
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "z" });
    });
    await settle();
    expect(screen.getByText("at receipts: 2 waiting")).toBeTruthy();
    await windowCloses();
    expect(sent).toEqual([]);
  });

  it("the model is made once for the frame and stands once over a walk to every place and the Screener's third section", async () => {
    await mount();
    expect({ ...models }, "as the frame mounted").toEqual({ mounts: 1, live: 1 });
    await click("Walk on");
    await click("To the Screener");
    await click("To its third section");
    await click("Walk on");
    expect(screen.getByText("at news: 2 waiting")).toBeTruthy();
    expect({ ...models }, "a walk made the model again").toEqual({ mounts: 1, live: 1 });
  });
});

describe("the account changes inside a decision's window", () => {
  it("A to B: the decision is filed once, by A's engine, and B's engine is told nothing", async () => {
    const a = await world();
    const b = await world();
    const hostA = hostOf(a.engine, "acct-1", "#/reads");
    const hostB = hostOf(b.engine, "acct-2", "#/reads");
    const view = render(ui(hostA));
    await rest();
    vi.useFakeTimers();
    expect(screen.getByText("at news: 2 waiting")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Let the first in" }));
    });
    await settle();
    expect(a.sent, "filed at the press").toEqual([]);
    view.rerender(ui(hostB));
    await settle();
    await act(async () => {
      vi.advanceTimersByTime(COMMIT_MS + 1_000);
    });
    await settle();
    expect(b.sent, "A's decision was sent through B's engine").toEqual([]);
    expect(a.sent, "A's decision was not filed once by A's engine").toEqual(["screener_decide"]);
  });

  it("A to B and back to A inside the window: filed once", async () => {
    const a = await world();
    const b = await world();
    const hostA = hostOf(a.engine, "acct-1", "#/reads");
    const hostB = hostOf(b.engine, "acct-2", "#/reads");
    const view = render(ui(hostA));
    await rest();
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Let the first in" }));
    });
    await settle();
    view.rerender(ui(hostB));
    await settle();
    view.rerender(ui(hostA));
    await settle();
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        vi.advanceTimersByTime(COMMIT_MS + 1_000);
      });
      await settle();
    }
    expect(b.sent).toEqual([]);
    expect(a.sent, "the decision was filed twice").toEqual(["screener_decide"]);
  });
});

/** The account's own row: it files into folders, and it lets suggestions be bought without a press. */
const consent = {
  state: async () => ({
    seedConfirmedAt: null, dormancyDays: 45, blockRemoteImagesAt: null, loadTrackingPixelsAt: null,
    foldersEnabledAt: NOW.toISOString(), autoSuggestAt: NOW.toISOString(),
  }),
} as unknown as ConsentWire;
/** A host that can store the folders' switch and draws the shared suggestion control. */
const CAN: Partial<HostCapabilities> = { foldersStorable: true, suggest: "priced" };
/** The account's own row as the cases above answer it, with the opt-in to buying without a press OFF. */
const consentNoAuto = {
  state: async () => ({
    seedConfirmedAt: null, dormancyDays: 45, blockRemoteImagesAt: null, loadTrackingPixelsAt: null,
    foldersEnabledAt: NOW.toISOString(), autoSuggestAt: null,
  }),
} as unknown as ConsentWire;

/** A Junk wire that records each call it is made, and answers one letter in one mailbox's Junk folder. */
function junkWire() {
  const asked: string[] = [];
  const say = <T,>(call: string, answer: T) => async (): Promise<T> => {
    asked.push(call);
    return answer;
  };
  const wire: JunkWire = {
    list: say("list", {
      mailboxes: [{ id: "mb", address: "me@own.example", window: "ok" }],
      items: [{
        mailboxId: "mb", uid: 7, uidValidity: "1", subject: "You won", from: { name: null, address: "win@junk.example" },
        date: NOW.toISOString(), messageIdHeader: null, seen: false, origin: "provider",
      }],
      nextCursor: null,
    }),
    body: say("body", { subject: "You won", text: "" }),
    rescue: say("rescue", { status: "queued", rescueId: "r1" }),
    dismissRescue: say("dismissRescue", {}),
    search: say("search", { mailboxes: [], items: [], truncated: false }),
    sweepPreview: say("sweepPreview", { mailboxes: [], movable: 0, pending: false }),
    sweepRequest: say("sweepRequest", { mailboxes: [], movable: 0, pending: false }),
    isGone: () => false,
    codeOf: () => null,
  };
  return { wire, asked };
}

/**
 * A suggestion wire that records what it is asked: what was bought already, a price, a purchase. `configured` false
 * is a wire that says no server stands behind it.
 */
function suggestWire(configured = true) {
  const asked: string[] = [];
  const wire: SuggestWire = {
    configured: () => configured,
    list: async () => {
      asked.push("list");
      return { items: [], nextCursor: null, suggestable: { senders: [], maxPerRequest: 25 } };
    },
    suggest: async (senders, opts) => {
      const priced = opts?.dryRun === true;
      asked.push(`${priced ? "price" : opts?.automatic === true ? "buy unpressed" : "buy"} ${senders.length}`);
      return {
        dryRun: priced, requested: senders.length, quoted: senders.length, quotedCredits: senders.length,
        charged: priced ? 0 : senders.length,
        suggestions: priced
          ? []
          : senders.map((sender, i) => ({ sender, messageId: `m${i}`, decision: "yes", confidence: 0.9, rationale: "known" })),
        skipped: [],
      };
    },
    messageFor: (_err, fallback) => fallback,
  };
  return { wire, asked };
}

describe("the Junk window and the suggestion run in the mail ground", () => {
  /** Every request this page sent by itself: over the fake host, whose engine and wires are the case's, none. */
  let dialled: string[] = [];
  let fetchWas: typeof globalThis.fetch;
  beforeEach(() => {
    dialled = [];
    fetchWas = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      dialled.push(String(input));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = fetchWas;
  });
  const count = (asked: readonly string[], call: string) => asked.filter((line) => line === call).length;

  it("over a Junk wire of none the Junk folder is read by nobody, at the mount, at the Screener or at its third section", async () => {
    const suggest = suggestWire();
    await mount({ wires: { consent, junk: "none", suggest: suggest.wire }, can: CAN });
    await rest();
    await click("To the Screener");
    await click("To its third section");
    await rest();
    expect(screen.getByText("at screener: 2 waiting")).toBeTruthy();
    expect(screen.getByText("junk: none"), "a Junk window stood over a host that named no wire").toBeTruthy();
    expect(dialled, "the page dialled by itself for a host that named no Junk wire").toEqual([]);
  });

  it("over a suggestion wire of none nothing is listed, priced or bought, though the account lets suggestions be bought without a press", async () => {
    const junk = junkWire();
    await mount({ wires: { consent, junk: junk.wire, suggest: "none" }, can: CAN });
    await rest();
    await click("To the Screener");
    await rest();
    expect(screen.getByText("at screener: 2 waiting")).toBeTruthy();
    expect(screen.getByText("suggest: none"), "a suggestion control stood over a host that named no wire").toBeTruthy();
    expect(dialled, "the page dialled by itself for a host that named no suggestion wire").toEqual([]);
  });

  it("the Junk folder is read once at the mount and not again by a walk: one window for the frame's life", async () => {
    const junk = junkWire();
    await mount({ wires: { consent, junk: junk.wire, suggest: "none" }, can: CAN });
    await rest();
    expect(count(junk.asked, "list"), "the Junk folder was not read when the frame came up").toBe(1);
    expect(screen.getByText("junk: ready, 1 listed")).toBeTruthy();
    await click("Walk on");
    await click("To the Screener");
    await click("To its third section");
    await click("Walk on");
    await rest();
    expect(screen.getByText("junk: ready, 1 listed")).toBeTruthy();
    expect(junk.asked, "a walk read the Junk folder again: a second window was mounted").toEqual(["list", "sweepPreview"]);
    expect(dialled).toEqual([]);
  });

  it("what was bought is listed once and the batch nobody presses for is bought once, whatever the walk: one run for the frame's life", async () => {
    const suggest = suggestWire();
    await mount({ wires: { consent, junk: "none", suggest: suggest.wire }, can: CAN });
    await rest();
    expect(suggest.asked, "a suggestion was asked for before the Screener was on screen").toEqual([]);
    expect(screen.getByText("suggest: unpriced, 2 to ask about")).toBeTruthy();
    await click("To the Screener");
    await rest();
    expect(suggest.asked).toEqual(["list", "buy unpressed 2"]);
    expect(screen.getByText("suggest: unpriced, 0 to ask about")).toBeTruthy();
    await click("Walk on");
    await click("To the Screener");
    await rest();
    expect(suggest.asked, "the walk bought or listed again: a second run was mounted").toEqual(["list", "buy unpressed 2"]);
    expect(dialled).toEqual([]);
  });

  it("where the host draws no suggestion control nothing is bought, with a wire and an account that lets suggestions be bought without a press", async () => {
    const suggest = suggestWire();
    await mount({ wires: { consent, junk: "none", suggest: suggest.wire }, can: { ...CAN, suggest: "none" } });
    await rest();
    await click("To the Screener");
    await rest();
    expect(screen.getByText("suggest: none")).toBeTruthy();
    expect(suggest.asked, "a suggestion was priced or bought where the host draws no control").toEqual(["list"]);
  });

  it("a price in credits is said where the host is the managed service, and nowhere else", async () => {
    const suggest = suggestWire();
    await mount({ wires: { consent, junk: "none", suggest: suggest.wire }, can: { ...CAN, service: "managed" } });
    await rest();
    expect(screen.getByText("suggest: priced, 2 to ask about")).toBeTruthy();
  });

  it("an account that files into no folders has no Junk window, and its host's wire is not asked", async () => {
    const junk = junkWire();
    const noFolders = { state: async () => ({ seedConfirmedAt: null, dormancyDays: 45, foldersEnabledAt: null }) } as unknown as ConsentWire;
    await mount({ wires: { consent: noFolders, junk: junk.wire, suggest: "none" }, can: CAN });
    await rest();
    await click("To its third section");
    await rest();
    expect(screen.getByText("junk: none")).toBeTruthy();
    expect(junk.asked, "the Junk folder was read for an account that files into no folders").toEqual([]);
  });
});

describe("three answers of the host, each read by the ground", () => {
  it("an account that did not opt in buys nothing without a press, at the Screener, over a wire and a priced host", async () => {
    const { engine } = await world();
    const s = suggestWire();
    render(ui(hostOf(engine, "acct-1", "#/screener", { consent: consentNoAuto, suggest: s.wire }, { foldersStorable: true, suggest: "priced" })));
    await rest();
    expect(screen.getByText("at screener: 2 waiting")).toBeTruthy();
    expect(screen.getByText("suggest: unpriced, 2 to ask about")).toBeTruthy();
    expect(s.asked, "a batch was bought without a press for an account that did not opt in").toEqual(["list"]);
  });

  it("over a host that says nobody sends an unsubscribe, no unsubscribe press is offered", async () => {
    const { engine } = await world();
    render(ui(hostOf(engine, "acct-1", "#/reads")));
    await rest();
    expect(screen.getByText("unsubscribe: none")).toBeTruthy();
  });

  it("over a suggestion wire that says no server stands behind it, nothing is drawn, listed, priced or bought", async () => {
    const { engine } = await world();
    const s = suggestWire(false);
    render(ui(hostOf(engine, "acct-1", "#/screener", { consent, suggest: s.wire }, { foldersStorable: true, suggest: "priced" })));
    await rest();
    expect(screen.getByText("suggest: none")).toBeTruthy();
    expect(s.asked).toEqual([]);
  });
});

describe("the one-press unsubscribe in the mail ground", () => {
  it("is sent through the engine, once, with the letter's id, where the host says the service sends it; where it says nobody does, none is offered", async () => {
    const { engine } = await world();
    const sent = vi.spyOn(engine, "unsubscribe");
    render(ui(hostOf(engine, "acct-1", "#/reads", {}, { unsubscribeFrom: "service" })));
    await settle();
    expect(screen.getByText("unsubscribe: offered"), "no unsubscribe press where the host says the service sends it").toBeTruthy();
    await click("Unsubscribe from the letter m0");
    expect(sent.mock.calls).toEqual([["m0"]]);
    cleanup();
    const other = await world();
    const otherSent = vi.spyOn(other.engine, "unsubscribe");
    render(ui(hostOf(other.engine, "acct-1", "#/reads", {}, { unsubscribeFrom: "none" })));
    await settle();
    expect(screen.getByText("unsubscribe: none")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Unsubscribe from the letter m0" })).toBeNull();
    expect(otherSent).not.toHaveBeenCalled();
  });
});

/** The words a seat of the test's own hands the live hook: each key says itself. */
const sayKey: Translator = (key) => key;
const SEAT_WORDS: ScreenerText = {
  screener: sayKey, screening: sayKey, ohbox: sayKey, session: sayKey,
  piles: { ohbox: "Ohbox", reads: "Reads", receipts: "Receipts", screened: "Screened out", spam: "Spam" },
  places: {}, locale: "en", zone: () => "UTC",
};
const AWAY = { screener: false, third: false } as const;

/**
 * A SEAT OF THE TEST'S OWN, standing where the ground's Screener mount stands: it makes the frame's one call of the
 * live hook (no Screener mount stands in its ground, so its run is the frame's only one) and reads what that run hands
 * on, the opt-in's quote, as Settings' row reads it: the senders the batch would take, whether there is a server to
 * ask, and the price once asked.
 */
function OptInSeat({ wire, children }: { readonly wire: SuggestWire | "none"; readonly children: ReactNode }) {
  const { autoOptIn } = useScreenerLive({
    press: usePress(), scope: "acct-1", text: SEAT_WORDS, aiRefusal: sayKey, at: AWAY,
    junkWire: "none", suggestWire: wire as unknown as ScreenerLiveInput["suggestWire"], suggestControl: true,
  });
  return (
    <>
      <p>
        {autoOptIn === null
          ? "opt-in: none"
          : `opt-in: ${autoOptIn.available} waiting, ${autoOptIn.supported ? "a server to ask" : "no server"}`}
      </p>
      <p>{autoOptIn?.quote ? `quote: ${autoOptIn.quote.senders} senders for ${autoOptIn.quote.credits} credits` : "quote: none"}</p>
      <button type="button" onClick={() => autoOptIn?.open()}>
        Price the batch
      </button>
      {children}
    </>
  );
}
/** The mail ground's first three pieces, and the test's seat above them where the Screener's mount stands. */
const seatedOver = (wire: SuggestWire | "none") =>
  function SeatedGround({ children }: { readonly children: ReactNode }) {
    return (
      <MailStateMount>
        <ConsentMount>
          <PresentedMount>
            <OptInSeat wire={wire}>{children}</OptInSeat>
          </PresentedMount>
        </ConsentMount>
      </MailStateMount>
    );
  };
const Away = () => <p>at news</p>;

describe("what the ground's one suggestion run hands a seat", () => {
  async function seated(wire: SuggestWire | "none") {
    const { engine } = await world();
    const { host } = fakeHost({
      engine, service: "self", scope: "acct-1",
      places: { news: { id: "news", body: "news", rail: null, panes: { kind: "wide", Wide: Away } } },
      above: seatedOver(wire),
      address: fakeAddress("#/reads"),
      window: fakeWindow("desktop"),
    });
    render(
      <TextProvider locale="en" messages={WORDS} timeZone="UTC">
        <KeymapProvider>
          <Frame host={host} />
        </KeymapProvider>
      </TextProvider>,
    );
    /* The queue's first derivation waits for the page to be idle (a timer): the quote is read once it stands. */
    await rest();
  }

  it("the opt-in's quote is bound to the senders waiting: a seat reads it off the one call and prices the batch with it; over a suggestion wire of none it is null", async () => {
    const suggest = suggestWire();
    await seated(suggest.wire);
    expect(screen.getByText("opt-in: 2 waiting, a server to ask"), "the one run handed no opt-in's quote").toBeTruthy();
    expect(suggest.asked, "the opt-in's quote asked the wire before its press").toEqual([]);
    await click("Price the batch");
    expect(suggest.asked).toEqual(["price 2"]);
    expect(screen.getByText("quote: 2 senders for 2 credits")).toBeTruthy();
    cleanup();
    await seated("none");
    expect(screen.getByText("opt-in: none"), "an opt-in's quote stood over a host that named no suggestion wire").toBeTruthy();
  });
});

describe("a page the server drew as the live product, opened in the browser as the invented mailbox", () => {
  it("draws at hydration what the server drew, then the invented mailbox's own answer, and asks no wire", async () => {
    const { renderToString } = await import("react-dom/server");
    const { hydrateRoot } = await import("react-dom/client");
    const { engine } = await world();
    const s = suggestWire();
    const host = hostOf(engine, "acct-1", "#/reads", { suggest: s.wire }, { suggest: "priced" });
    /* A prerendered page cannot read the address the browser opens it at: its server says the live product, and the
       browser's own answer (`demo`) is the invented mailbox. */
    const page = (demo: boolean) => (
      <TextProvider locale="en" messages={WORDS} timeZone="UTC">
        <KeymapProvider>
          <EngineContext.Provider value={{ engine, demo, serverDemo: false, sync: SYNC_SETTLED }}>
            <Frame host={host} />
          </EngineContext.Provider>
        </KeymapProvider>
      </TextProvider>
    );
    const served = document.createElement("div");
    served.innerHTML = renderToString(page(false));
    document.body.appendChild(served);
    expect(served.textContent, "the server drew no suggestion control").toContain("suggest: unpriced");
    const recovered: unknown[] = [];
    let root: Root | null = null;
    await act(async () => {
      root = hydrateRoot(served, page(true), { onRecoverableError: (error) => void recovered.push(error) });
    });
    await rest();
    expect(recovered, "the hydration render drew otherwise than the server").toEqual([]);
    expect(within(served).getByText("suggest: none"), "the invented mailbox drew a suggestion control").toBeTruthy();
    expect(s.asked, "the invented mailbox asked the suggestion wire").toEqual([]);
    await act(async () => {
      root?.unmount();
    });
    served.remove();
  });
});
