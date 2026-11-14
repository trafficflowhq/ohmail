/** @vitest-environment jsdom */
/**
 * THE OLD SHELL'S COMPOSITION STANDS ONCE PER FRAME, ABOVE EVERY PANE. The real shell as the tests' door mounts it,
 * with the places every host hands: the Ohbox seated (a place of its own body), every other one of today's views. A
 * walk between the seated Ohbox and a view of today's mounts nothing of the composition a second time and asks the
 * consent wire nothing again; a send pressed before the walk is answered on the machine that sent it; and at the
 * seated Ohbox the app is whole: the rail, the notices, the palette, the key sheet and the way to the composer.
 *
 * Each part is counted live through a wrapper of its own module: the real hook or provider runs, the wrapper counts
 * its mounts.
 *
 * AND WHAT A PLACE READS OF THE MAIL GROUND, OVER BOTH CALLERS, the same cases and the same expectations: over a
 * tests' host that hands the mail ground (two places that read it as a seat does, nothing of the old shell), and
 * over the old shell with those two places at two of its ids, where the shell makes every call and fills the
 * ground's contexts. The mail state, the consent row and the partition stand once for the frame's life over a walk
 * between the two, the consent wire is asked once, the engine is told one cutline, and a place reads the very row
 * and the very record the one call and the one derivation answered. A place that called for the row itself would be
 * seen: the wire is asked a second time.
 */
import { createContext, createElement as h, useContext, useMemo, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { screen, within } from "@testing-library/react";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineDraft, EngineMutation, OhmailEngine } from "@ohmail/client-engine";
import { useConsent, usePartition } from "@ohmail/app-logic/consent";
import { useConsentRow } from "@ohmail/app-logic/consent/consent-row";
import type { ConsentTransport } from "@ohmail/app-logic/consent/consent-state";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { useDerivedVersion, useEngine } from "@ohmail/app-logic/engine";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { usePresentedMirror } from "@ohmail/app-logic/reading";
import { PLACE_IDS, useFrame, usePress, useReport, type FramePlaces, type PlaceEntry } from "@ohmail/app/frame";
import { NONE } from "@ohmail/app/host";
import { MailGround } from "@ohmail/app/mail";
import { TextProvider } from "@ohmail/app/text";
import en from "../../messages/en.json";
import type { DraftReplyWire } from "@ohmail/app-logic/writing/draft-reply";
import { TODAYS_COMPOSER_WORDS } from "../../app/shell/mail-send-text";
import { useShellCompose, type ShellCompose } from "@ohmail/app-logic/writing/shell-compose";
import { act, message, mountShell, press, stubDom, unmountAll, waitFor, type DraftShell } from "../_draft-shell.js";
import { settleEditor } from "../_first-paint.js";
import { hostFromTodaysInputs } from "../_todays-shell";
import { engineOver, msg, NOW, setup, storeWith, teardown } from "../_view-shell";

type Part = "mailState" | "consentRow" | "composer" | "fileDoor" | "pictureDoor";
const seen = vi.hoisted(() => ({
  mounts: { mailState: 0, consentRow: 0, composer: 0, fileDoor: 0, pictureDoor: 0 },
  live: { mailState: 0, consentRow: 0, composer: 0, fileDoor: 0, pictureDoor: 0 },
  /** How often the consent wire's `state` was asked, on whichever wire object the row was handed. */
  asks: 0,
  wires: new WeakSet<object>(),
  /** The partition's one derivation: its mounts, how many stand now, and every record it answered. */
  partition: { mounts: 0, live: 0 },
  records: new WeakSet<object>(),
  /** Every row the consent row's one call answered. */
  rows: new WeakSet<object>(),
}));

vi.mock("@ohmail/app/mail-state", async (load) => {
  const real = await load<typeof import("@ohmail/app/mail-state")>();
  const { createElement, useEffect } = await import("react");
  function Counted(props: Parameters<typeof real.MailStateProvider>[0]) {
    useEffect(() => {
      seen.mounts.mailState += 1;
      seen.live.mailState += 1;
      return () => {
        seen.live.mailState -= 1;
      };
    }, []);
    return createElement(real.MailStateProvider, props);
  }
  return { ...real, MailStateProvider: Counted };
});

vi.mock("@ohmail/app-logic/consent/consent-state", async (load) => {
  const real = await load<typeof import("@ohmail/app-logic/consent/consent-state")>();
  const { useEffect } = await import("react");
  return {
    ...real,
    useConsentState: (...args: Parameters<typeof real.useConsentState>) => {
      /* The wire the row is handed, counted where it is asked: its `state` is wrapped once per wire object. */
      const wire = args[2] as unknown as { state?: (...a: unknown[]) => unknown } | string;
      if (typeof wire === "object" && typeof wire.state === "function" && !seen.wires.has(wire)) {
        seen.wires.add(wire);
        const asked = wire.state;
        wire.state = (...a: unknown[]) => {
          seen.asks += 1;
          return asked.apply(wire, a);
        };
      }
      const row = real.useConsentState(...args);
      seen.rows.add(row);
      useEffect(() => {
        seen.mounts.consentRow += 1;
        seen.live.consentRow += 1;
        return () => {
          seen.live.consentRow -= 1;
        };
      }, []);
      return row;
    },
  };
});

vi.mock("@ohmail/app-logic/consent/partition", async (load) => {
  const real = await load<typeof import("@ohmail/app-logic/consent/partition")>();
  const { useEffect } = await import("react");
  return {
    ...real,
    usePartitionOf: (...args: Parameters<typeof real.usePartitionOf>) => {
      const record = real.usePartitionOf(...args);
      seen.records.add(record);
      useEffect(() => {
        seen.partition.mounts += 1;
        seen.partition.live += 1;
        return () => {
          seen.partition.live -= 1;
        };
      }, []);
      return record;
    },
  };
});

vi.mock("@ohmail/app-logic/writing/shell-compose", async (load) => {
  const real = await load<typeof import("@ohmail/app-logic/writing/shell-compose")>();
  const { useEffect } = await import("react");
  return {
    ...real,
    useShellCompose: (...args: Parameters<typeof real.useShellCompose>) => {
      const composer = real.useShellCompose(...args);
      useEffect(() => {
        seen.mounts.composer += 1;
        seen.live.composer += 1;
        return () => {
          seen.live.composer -= 1;
        };
      }, []);
      return composer;
    },
  };
});

vi.mock("../../app/shell/attachments", async (load) => {
  const real = await load<typeof import("../../app/shell/attachments")>();
  const { useEffect } = await import("react");
  return {
    ...real,
    useMessageAttachments: (...args: Parameters<typeof real.useMessageAttachments>) => {
      const door = real.useMessageAttachments(...args);
      useEffect(() => {
        seen.mounts.fileDoor += 1;
        seen.live.fileDoor += 1;
        return () => {
          seen.live.fileDoor -= 1;
        };
      }, []);
      return door;
    },
  };
});

vi.mock("../../app/shell/remote-images", async (load) => {
  const real = await load<typeof import("../../app/shell/remote-images")>();
  const { useEffect } = await import("react");
  return {
    ...real,
    useRemoteImages: (...args: Parameters<typeof real.useRemoteImages>) => {
      const door = real.useRemoteImages(...args);
      useEffect(() => {
        seen.mounts.pictureDoor += 1;
        seen.live.pictureDoor += 1;
        return () => {
          seen.live.pictureDoor -= 1;
        };
      }, []);
      return door;
    },
  };
});

const ONCE: Record<Part, number> = { mailState: 1, consentRow: 1, composer: 1, fileDoor: 1, pictureDoor: 1 };

const letter = {
  id: "d-letter", mailboxId: "mb1", threadId: null, inReplyToMessageId: null,
  subject: "Plans for Friday", body: "Shall we meet at noon?",
  to: [{ name: "Mila", address: "mila@example.invalid" }], cc: [], bcc: [],
  rationale: null, status: "draft",
  createdAt: "2026-09-27T08:40:00.000Z", updatedAt: "2026-09-27T08:40:00.000Z",
} as unknown as EngineDraft;

const SENDING = en.sendingLine.sending.replace("{name}", "Mila");
const sends = (s: DraftShell): EngineMutation[] => s.sent.filter((m) => m.kind === "mail_send");
/** What the one notice slot says in full now: the notice in front, its words and its answers. */
const said = (): string => screen.queryAllByRole("status").map((notice) => notice.textContent ?? "").join(" | ");
const saysSending = (): boolean => said().includes(SENDING);
const saysOfMila = (): boolean => said().includes("Mila");
/** The seated Ohbox is on screen: the frame draws its reading column. A view of today's stands in the wide pane. */
const atTheOhbox = (): boolean => screen.queryByRole("region", { name: "Reading" }) !== null;
const TODAYS_ADDRESS = "#/history";
const subject = (): HTMLElement | null => screen.queryByRole("textbox", { name: en.compose.subject });
/** How many entries the rail today's views feed holds; none where no fed rail stands. */
const fedRailEntries = (): number => {
  const rail = screen.queryByRole("navigation", { name: "Main" });
  return rail === null ? 0 : within(rail).queryAllByRole("button").length;
};

async function visit(hash: string): Promise<void> {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}
async function key(k: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
  await settleEditor();
}
async function rounds(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
}
/** Hold the next send on the wire; the answer leaves when the returned function is called. */
function holdTheSend(s: DraftShell): () => void {
  let release!: () => void;
  s.sendGate.wait = new Promise<void>((r) => { release = r; });
  return () => {
    s.sendGate.wait = null;
    release();
  };
}
/** The letter from Drafts into the composer, Send pressed, the composer handed off with the send still on the wire. */
async function sendTheLetter(s: DraftShell): Promise<() => void> {
  const open = () => within(s.el).queryByRole("button", { name: /Plans for Friday/ });
  await waitFor(() => open() !== null, "the letter in Drafts");
  await press(open(), "open the letter");
  await waitFor(() => (subject() as HTMLInputElement | null)?.value === "Plans for Friday", "the composer on the letter");
  const release = holdTheSend(s);
  const send = within(s.el).getAllByRole("button").find((b) => /^Send(?! later)/.test((b.textContent ?? "").trim()));
  await press(send ?? null, "Send");
  await waitFor(() => sends(s).length === 1, "the send on the wire");
  await waitFor(() => subject() === null, "the composer handed off");
  return release;
}

beforeEach(() => {
  try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
  for (const part of Object.keys(ONCE) as Part[]) {
    seen.mounts[part] = 0;
    seen.live[part] = 0;
  }
  seen.asks = 0;
  seen.partition.mounts = 0;
  seen.partition.live = 0;
  read.length = 0;
});
afterEach(async () => {
  await unmountAll();
});

describe("the old shell's composition over a walk from the seated Ohbox to a view of today's and back", () => {
  it("mounts the mail state, the consent row, the composer and the two doors once, and asks the consent wire once", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await waitFor(() => atTheOhbox() && within(s.el).queryAllByRole("option").length > 0, "the seated Ohbox with its letter");
    await rounds(8);
    expect({ mounts: { ...seen.mounts }, live: { ...seen.live }, asks: seen.asks }, "as the frame mounted").toEqual({
      mounts: ONCE, live: ONCE, asks: 1,
    });

    await visit(TODAYS_ADDRESS);
    await waitFor(() => !atTheOhbox(), "History, a view of today's");
    await rounds(8);
    expect({ ...seen.live }, "at a view of today's every part still stands, once").toEqual(ONCE);

    await visit("#/ohbox");
    await waitFor(() => atTheOhbox() && within(s.el).queryAllByRole("option").length > 0, "the seated Ohbox again");
    await rounds(8);
    expect({ mounts: { ...seen.mounts }, live: { ...seen.live }, asks: seen.asks }, "after the walk").toEqual({
      mounts: ONCE, live: ONCE, asks: 1,
    });
  }, 60_000);

  it("a send pressed before the walk is one send, answered on the machine that sent it, its notice gone", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [letter], { handOff: true });
    const release = await sendTheLetter(s);
    await waitFor(saysSending, "the notice says the send is on its way");

    await visit("#/ohbox");
    await waitFor(atTheOhbox, "the seated Ohbox");
    await rounds(8);
    expect(saysSending(), "at the seated Ohbox the notice still says the send is on its way").toBe(true);

    await act(async () => { release(); });
    await waitFor(() => !saysSending() && saysOfMila(), "the answer applied: the notice says it went");
    await waitFor(() => !saysOfMila(), "the notice settles away", 400);

    await visit(TODAYS_ADDRESS);
    await waitFor(() => !atTheOhbox(), "a view of today's again");
    await rounds(20);
    expect(sends(s), "one send left for one press").toHaveLength(1);
    expect({ ...seen.mounts }, "nothing of the composition was mounted again").toEqual(ONCE);
  }, 60_000);
});

/**
 * THE HOST'S DRAFT WIRE REACHES THE COMPOSER, through the shell the tests' door mounts. Two hosts that differ only in
 * the draft wire they hand: one that counts what it is asked, and none. A letter opened in a view of today's and its
 * More menu: over the wire Draft reply opens the offer, and the wire is asked to draft on Draft it only; over none
 * no Draft reply is offered and nothing is asked.
 */
describe.each([
  ["hands a draft wire", true, ["m1"]],
  ["names no drafter", false, []],
] as const)("a host that %s, under the shell the tests' door mounts", (_, hands, drafted) => {
  it("its letter's More offers Draft reply only over a wire, and the wire drafts on Draft it only", async () => {
    const asked = { create: [] as string[], read: [] as string[] };
    const wire: DraftReplyWire = {
      configured: () => true,
      create: async (messageId) => {
        asked.create.push(messageId);
        return { draftId: "d-drafted" };
      },
      read: async (draftId) => {
        asked.read.push(draftId);
        return { body: "Noon works.", html: null };
      },
      /* This host has no door for a draft made of the person's own words. */
      fromText: "none",
    };
    const s = await mountShell(TODAYS_ADDRESS, [message("m1")], [], hands ? { draftReplyWire: wire } : {});
    const row = () => within(s.el).queryByRole("option", { name: /Subject m1$/ });
    await waitFor(() => row() !== null, "the letter in History");
    await press(row(), "open the letter");
    const more = () => within(s.el).queryAllByRole("button", { name: en.ohbox.actionMore })
      .find((b) => b.getAttribute("aria-haspopup") === "menu") ?? null;
    await waitFor(() => more() !== null, "the letter's More");
    await press(more(), "More");
    await waitFor(() => screen.queryByRole("menu", { name: en.ohbox.actionMore }) !== null, "the More menu");
    const draftReply = screen.queryByRole("menuitem", { name: en.ohbox.actionDraftReply });
    expect(draftReply !== null, "Draft reply in the letter's More").toBe(hands);
    if (draftReply !== null) {
      await press(draftReply, "Draft reply");
      await waitFor(() => screen.queryByRole("group", { name: en.draftReply.offerTitle }) !== null, "the offer");
      expect(asked.create, "the offer asked the wire to draft before Draft it").toEqual([]);
      await press(screen.getByRole("button", { name: en.draftReply.confirm }), "Draft it");
      await waitFor(() => asked.create.length > 0, "the wire asked to draft");
    }
    expect(asked.create, "what the wire was asked to draft").toEqual(drafted);
  }, 60_000);
});

describe("at the seated Ohbox the app is whole", () => {
  it("the fed rail, a notice of today's feeds, the palette, the key sheet and the way to the composer stand; today's reader sheet does not", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [letter], { handOff: true });
    const release = await sendTheLetter(s);
    await visit(TODAYS_ADDRESS);
    await waitFor(() => !atTheOhbox() && fedRailEntries() > 0, "History beside its fed rail");
    await waitFor(saysSending, "the notice says the send is on its way");
    const entries = fedRailEntries();
    expect(entries, "a view of today's stands beside a fed rail").toBeGreaterThan(0);

    await visit("#/ohbox");
    await waitFor(() => atTheOhbox() && within(s.el).queryAllByRole("option").length > 0, "the seated Ohbox");
    await rounds(8);
    expect({ rail: fedRailEntries(), notice: saysSending() }, "the rail and the notice at the seated Ohbox").toEqual({
      rail: entries, notice: true,
    });
    expect(screen.queryByRole("dialog", { name: en.reader.pane, hidden: true }), "today's reader sheet").toBeNull();

    await key("k", { ctrlKey: true });
    await waitFor(() => screen.queryByRole("dialog", { name: en.palette.ariaLabel }) !== null, "the palette's key opens it");
    await key("Escape");
    await waitFor(() => screen.queryByRole("dialog", { name: en.palette.ariaLabel }) === null, "the palette closed");

    await key("?");
    await waitFor(() => screen.queryByRole("dialog", { name: en.shortcuts.title }) !== null, "? opens the key sheet");
    await key("Escape");
    await waitFor(() => screen.queryByRole("dialog", { name: en.shortcuts.title }) === null, "the key sheet closed");

    await key("c");
    await waitFor(() => subject() !== null, "c reaches the composer");
    expect(atTheOhbox(), "the composer stands in place of the seated Ohbox").toBe(false);

    await act(async () => { release(); });
    await waitFor(() => !saysOfMila(), "the send's notice settles away", 400);
  }, 60_000);
});

/**
 * WHAT A PLACE READS OF THE GROUND, kept per render: the consent row, the partition's record and the presented
 * mirror, as a seat written after the first one reads them, with nothing of a shell.
 */
const read: Array<{ at: string; row: object; partition: object; presented: object | null }> = [];
function readingAt(at: string, alsoCalling: "nothing" | "the row's own hook" = "nothing") {
  return function Reading() {
    const row = useConsent();
    const partition = usePartition();
    const presented = usePresentedMirror();
    read.push({ at, row, partition, presented });
    return h("section", { "aria-label": at }, alsoCalling === "nothing" ? null : h(CallsForTheRow));
  };
}
/** A SECOND CALLER of the row's hook under the same frame: what no place may be. */
function CallsForTheRow() {
  const { host } = useFrame();
  const wire = host.wires.consent;
  const transport = useMemo(
    () => (wire === NONE ? NONE : ({ ...wire, foldersStorable: false } as unknown as ConsentTransport)),
    [wire],
  );
  useConsentRow({ engine: host.engine, derived: 0, facts: null, active: true, scope: host.session.scope, transport });
  return null;
}
const reads = (at: string, alsoCalling?: "the row's own hook"): PlaceEntry["panes"] => ({
  kind: "wide", Wide: readingAt(at, alsoCalling),
});
type Places = Partial<Record<(typeof PLACE_IDS)[number], PlaceEntry>>;
/** Two places of two bodies that read the ground, at News's and Receipts' addresses. */
const FIRST = "#/reads";
const SECOND = "#/receipts";
const TWO_PLACES: Places = {
  news: { id: "news", body: "reads-the-ground-1", rail: null, panes: reads("the first place") },
  receipts: { id: "receipts", body: "reads-the-ground-2", rail: null, panes: reads("the second place") },
};
const WITH_A_SECOND_CALLER: Places = {
  news: { id: "news", body: "calls-again", rail: null, panes: reads("the first place", "the row's own hook") },
};

const OWN: MailboxFacts[] = [{
  id: "mb1", address: "me@example.invalid", status: "connected", errorCode: null,
  disabledReason: null, syncBlockedReason: null, syncBlockedSince: null,
  lastSyncAt: "2026-09-16T08:59:00.000Z", createdAt: "2026-09-01T00:00:00.000Z",
  organizerRole: "organizer" as const, organizedBy: null, organizeConsentedAt: "2026-09-01T00:00:00.000Z",
}];
const ownFacts = async (): Promise<MailboxFacts[]> => OWN;
const answering = (): ConsentTransport => ({
  foldersStorable: false,
  state: async () => ({ seedConfirmedAt: "2026-09-01T00:00:00.000Z", dormancyDays: 45 }),
}) as unknown as ConsentTransport;

let stood: Root | null = null;
async function loaded() {
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const { EngineProvider } = await import("../../app/shell/engine");
  const { TodaysFrame } = await import("../../app/shell/TodaysFrame");
  const { NO_TODAYS } = await import("../../app/shell/todays-inputs");
  const { useTodaysSupplies } = await import("../../app/shell/todays-supplies");
  return { ThemeProvider, ToastHost, EngineProvider, TodaysFrame, NO_TODAYS, useTodaysSupplies };
}
let parts: Awaited<ReturnType<typeof loaded>> | null = null;

/**
 * THE TWO CALLERS, one host each over the same inputs (the window and the address as every shell hands them, the
 * same wire, the same facts). `ground`: these places and no other, `MailGround` above them: the ground's own mounts
 * make every call. `shell`: the places every host hands with these standing at two of their ids, the old shell's
 * composition above them: the old shell makes every call and fills the ground's contexts.
 */
type Caller = "ground" | "shell";
function Stood({ caller, engine, places, consent }: { caller: Caller; engine: OhmailEngine; places: Places; consent: ConsentTransport }) {
  const { TodaysFrame, NO_TODAYS, useTodaysSupplies } = parts!;
  const frame = useTodaysSupplies(NONE);
  const host = useMemo(() => {
    const inputs = { demo: false, engine, consentTransport: consent, mailboxFacts: ownFacts };
    if (caller === "shell") {
      return hostFromTodaysInputs(inputs, engine, { ...frame, places: { ...frame.places, ...places } as FramePlaces }, NONE);
    }
    const only = { ...Object.fromEntries(PLACE_IDS.map((id) => [id, NONE])), ...places } as unknown as FramePlaces;
    const made = hostFromTodaysInputs(inputs, engine, { ...frame, places: only }, NONE);
    return { ...made, features: { ...made.features, places: only, above: MailGround } };
  }, [caller, engine, frame, places, consent]);
  return h(TodaysFrame, { host, todays: NO_TODAYS });
}
async function stand(caller: Caller, engine: OhmailEngine, places: Places): Promise<void> {
  parts ??= await loaded();
  const { ThemeProvider, ToastHost, EngineProvider } = parts;
  window.location.hash = FIRST;
  const tree = h(NextIntlClientProvider, { locale: "en", messages: en, timeZone: "UTC", now: NOW } as never,
    h(TextProvider, { locale: "en", messages: en as never, timeZone: "UTC" } as never,
      h(ThemeProvider as never, null, h(ToastHost as never, null,
        h(EngineProvider, { demo: false, engine } as never, h(Stood, { caller, engine, places, consent: answering() }))))));
  const container = document.createElement("div");
  document.body.appendChild(container);
  stood = createRoot(container);
  await act(async () => { stood!.render(tree); });
}
const at = (name: string): boolean => screen.queryByRole("region", { name }) !== null;
const lastAt = (name: string) => [...read].reverse().find((r) => r.at === name)!;
const ONE_EACH = { mailState: 1, consentRow: 1, partition: 1 };

describe.each([
  ["a host that hands the mail ground", "ground"],
  ["the old shell, filling the ground's contexts", "shell"],
] as const)("what a place reads of the ground over %s", (_, caller) => {
  beforeEach(() => {
    setup();
  });
  afterEach(async () => {
    if (stood) await act(async () => { stood!.unmount(); });
    stood = null;
    await teardown();
  });

  it("the mail state, the consent row and the partition stand once over a walk, the wire is asked once, and a place reads the very row and record", async () => {
    const engine = engineOver(await storeWith([msg("m1")]));
    const cutlines: unknown[] = [];
    const tell = engine.setCutline.bind(engine);
    engine.setCutline = (cutline) => {
      cutlines.push(cutline);
      tell(cutline);
    };
    await stand(caller, engine, TWO_PLACES);
    await waitFor(() => at("the first place") && seen.asks > 0, "the first place, its row asked for");
    await rounds(8);
    const stands = () => ({
      mailState: seen.live.mailState, consentRow: seen.live.consentRow, partition: seen.partition.live,
    });
    expect(stands(), "as the frame mounted").toEqual(ONE_EACH);
    const first = lastAt("the first place");
    expect(seen.rows.has(first.row), "the place read a row the one call did not answer").toBe(true);
    expect(seen.records.has(first.partition), "the place read a record the one derivation did not answer").toBe(true);
    expect(first.presented, "the place was handed no presented mirror").not.toBeNull();

    await visit(SECOND);
    await waitFor(() => at("the second place"), "the second place");
    await rounds(8);
    expect(stands(), "at the second place").toEqual(ONE_EACH);
    const second = lastAt("the second place");
    expect(seen.rows.has(second.row), "the second place read a row the one call did not answer").toBe(true);
    expect(second.partition, "another place reads another record").toBe(first.partition);
    /* Over the ground a reader is handed the same row while nothing of it moved; the old shell's row is a new
       object at each of its renders, until it is gone. */
    if (caller === "ground") expect(second.row, "another place reads another row").toBe(first.row);

    await visit(FIRST);
    await waitFor(() => at("the first place"), "the first place again");
    await rounds(8);
    expect(
      { mounts: { mailState: seen.mounts.mailState, consentRow: seen.mounts.consentRow, partition: seen.partition.mounts }, asks: seen.asks },
      "after the walk",
    ).toEqual({ mounts: ONE_EACH, asks: 1 });
    expect(cutlines, "the engine was told the cutline once, as the row answered it").toEqual([{ dormancyDays: 45, scope: "window" }]);
  }, 60_000);

  it("a place that calls for the row itself is seen: a second row stands and the wire is asked a second time", async () => {
    const engine = engineOver(await storeWith([msg("m1")]));
    await stand(caller, engine, WITH_A_SECOND_CALLER);
    await waitFor(() => at("the first place") && seen.asks > 1, "the second caller's own ask");
    await rounds(8);
    /* Two rows stand in the one frame, and the wire heard more than the one ask a frame owes (the old shell draws a
       place's pane twice at its mount, so its second caller asks twice). */
    expect(seen.live.consentRow, "the rows that stand in one frame").toBe(2);
    expect(seen.asks, "the asks one frame made of its consent wire").toBeGreaterThan(1);
  }, 60_000);
});

/**
 * ONE SEND MACHINE OVER A HOST THAT HANDS THE MAIL GROUND, and nothing of the old shell. The composer's own hook is
 * called once by THE STUB MOUNT below, which feeds it from the ground's contexts and the frame's door alone, as the
 * ground's own mount of the composer will once the composer stands where a package can call it; until then this
 * stub is that mount's stand-in, in this file only. Two places of two bodies press and read through it. A reply
 * sent at the first place, the second place visited before the answer: one `mail_send`, the answer applied on the
 * machine that sent it, the sending state gone. And the fault this guards is seen: a composer mounted with a
 * place's own body leaves with that place, and the place walked to stands another machine that knows no send.
 */
const Composer = createContext<ShellCompose | null>(null);
const NOTHING = (): void => {};
const NO_MAILBOX_ROWS: never[] = [];
function StubWritingMount({ children }: { readonly children?: ReactNode }): ReactNode {
  const { host, route } = useFrame();
  const engine = useEngine();
  const derived = useDerivedVersion();
  const reader = engine.read();
  const press = usePress();
  const consent = useConsent();
  const { ownAddresses } = usePartition();
  const { mailboxes: facts } = useMailState();
  const presented = usePresentedMirror();
  if (presented === null) throw new Error("the stub mount stands under no presented mirror");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  /* The drafts as the mirror holds them now: read again when what is derived from the mirror moved. */
  const drafts = useMemo(() => engine.read().list<EngineDraft>("draft"), [engine, derived]);
  const own = useMemo(() => [...ownAddresses], [ownAddresses]);
  const composer = useShellCompose({
    engine, reader, t: useTranslations(), words: TODAYS_COMPOSER_WORDS, toast: useReport(),
    /* As the host says it: `none` on this host, so the composer offers no drafted reply and asks nothing. */
    draftReplyWire: host.wires.draftReply as DraftReplyWire | typeof NONE,
    route: { view: route.place }, go: NOTHING,
    consent, facts, mailboxes: NO_MAILBOX_ROWS, drafts, ownAddresses: own, fallbackMailboxId: "mb1",
    replyTo, setReplyTo, setReaderFor: NOTHING, fr: null, setFr: NOTHING, setFrDone: NOTHING, setFrValues: NOTHING,
    setOhboxSel: NOTHING, mailtoDraft: null, onMailtoDraftSeeded: undefined, presented,
    mutateAndReport: press.mutateAndReport, toastWithUndo: press.toastWithUndo, scope: host.session.scope,
  });
  return h(Composer.Provider, { value: composer }, children);
}
/** A place that writes through the composer above it: Reply, the words, Send, and what the reply's send says now. */
function writesAt(at: string, mount: "above every place" | "with this place's body") {
  function Writes() {
    const composer = useContext(Composer);
    if (composer === null) throw new Error(`no composer stands above ${at}`);
    return h("section", { "aria-label": at },
      h("button", { type: "button", onClick: () => composer.openReply("m1") }, "Reply"),
      h("button", { type: "button", onClick: () => composer.onReplyBody({ text: "Noon works.", html: "" }) }, "Write"),
      h("button", { type: "button", onClick: () => composer.sendReply("m1") }, "Send"),
      h("output", null, `the reply's send: ${composer.replySendState("m1").phase}`),
      h("output", null, composer.draftReplyChrome === null ? "no draft control" : "a draft control"));
  }
  return mount === "above every place" ? Writes : () => h(StubWritingMount, null, h(Writes));
}
const writingPlaces = (mount: "above every place" | "with this place's body"): Places => ({
  news: { id: "news", body: "writes-1", rail: null, panes: { kind: "wide", Wide: writesAt("the first place", mount) } },
  receipts: { id: "receipts", body: "writes-2", rail: null, panes: { kind: "wide", Wide: writesAt("the second place", mount) } },
});
/** The ground, and above every place the composer's one mount. */
function GroundWithTheComposer({ children }: { readonly children: ReactNode }): ReactNode {
  return h(MailGround, null, h(StubWritingMount, null, children));
}
function StoodOverTheGround({ engine, places, above }: {
  engine: OhmailEngine; places: Places; above: (props: { readonly children: ReactNode }) => ReactNode;
}) {
  const { TodaysFrame, NO_TODAYS, useTodaysSupplies } = parts!;
  const frame = useTodaysSupplies(NONE);
  const consent = useMemo(answering, []);
  const host = useMemo(() => {
    const only = { ...Object.fromEntries(PLACE_IDS.map((id) => [id, NONE])), ...places } as unknown as FramePlaces;
    const made = hostFromTodaysInputs(
      { demo: false, engine, consentTransport: consent, mailboxFacts: ownFacts }, engine, { ...frame, places: only }, NONE,
    );
    return { ...made, features: { ...made.features, places: only, above } };
  }, [engine, frame, places, consent, above]);
  return h(TodaysFrame, { host, todays: NO_TODAYS });
}
async function standOverTheGround(engine: OhmailEngine, places: Places, above: (props: { readonly children: ReactNode }) => ReactNode) {
  parts ??= await loaded();
  const { ThemeProvider, ToastHost, EngineProvider } = parts;
  window.location.hash = FIRST;
  const tree = h(NextIntlClientProvider, { locale: "en", messages: en, timeZone: "UTC", now: NOW } as never,
    h(TextProvider, { locale: "en", messages: en as never, timeZone: "UTC" } as never,
      h(ThemeProvider as never, null, h(ToastHost as never, null,
        h(EngineProvider, { demo: false, engine } as never, h(StoodOverTheGround, { engine, places, above }))))));
  const container = document.createElement("div");
  document.body.appendChild(container);
  stood = createRoot(container);
  await act(async () => { stood!.render(tree); });
}
/** Every `mail_send` the engine is asked for, each held on the wire until `release` is called. */
function holdingSends(engine: OhmailEngine): { sent: EngineMutation[]; release: () => void } {
  const sent: EngineMutation[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const mutate = engine.mutate.bind(engine);
  engine.mutate = (async (m: EngineMutation) => {
    if (m.kind === "mail_send") {
      sent.push(m);
      await gate;
    }
    return mutate(m);
  }) as typeof engine.mutate;
  return { sent, release };
}
const sendSays = (place: string): string =>
  within(screen.getByRole("region", { name: place })).getByText(/^the reply's send: /).textContent ?? "";
async function replyAndSendAt(place: string): Promise<void> {
  const here = within(screen.getByRole("region", { name: place }));
  for (const verb of ["Reply", "Write", "Send"]) await press(here.getByRole("button", { name: verb }), verb);
}

describe("one send machine over a host that hands the mail ground", () => {
  beforeEach(() => {
    setup();
  });
  afterEach(async () => {
    if (stood) await act(async () => { stood!.unmount(); });
    stood = null;
    await teardown();
  });

  it("a reply sent at one place, another place visited before the answer: one mail_send, the answer applied, the sending state gone", async () => {
    const engine = engineOver(await storeWith([msg("m1")]));
    const wire = holdingSends(engine);
    await standOverTheGround(engine, writingPlaces("above every place"), GroundWithTheComposer);
    await waitFor(() => at("the first place") && seen.asks > 0, "the first place over the ground");
    await rounds(8);
    expect(within(screen.getByRole("region", { name: "the first place" })).queryByText("no draft control"),
      "this host hands no draft wire, and the composer says no control").not.toBeNull();

    await replyAndSendAt("the first place");
    await waitFor(() => wire.sent.length === 1, "the send on the wire");
    expect(sendSays("the first place")).toBe("the reply's send: sending");

    await visit(SECOND);
    await waitFor(() => at("the second place"), "the second place");
    await rounds(8);
    expect(sendSays("the second place"), "the place walked to reads the machine that sent").toBe("the reply's send: sending");
    expect({ mounts: seen.mounts.composer, live: seen.live.composer }, "the composer over the walk").toEqual({ mounts: 1, live: 1 });

    await act(async () => { wire.release(); });
    await waitFor(() => sendSays("the second place") !== "the reply's send: sending", "the answer applied on the machine that sent it");
    await rounds(20);
    expect(wire.sent, "one send left for one press").toHaveLength(1);
    expect(sendSays("the second place"), "the answer is applied: it went, and the sending state is gone").toBe("the reply's send: sent");
    expect(seen.mounts.composer, "nothing mounted the composer again").toBe(1);
  }, 60_000);

  it("a composer mounted with a place's own body is seen: the place walked to stands another machine, which knows no send", async () => {
    const engine = engineOver(await storeWith([msg("m1")]));
    const wire = holdingSends(engine);
    await standOverTheGround(engine, writingPlaces("with this place's body"), MailGround);
    await waitFor(() => at("the first place") && seen.asks > 0, "the first place over the ground");
    await rounds(8);
    await replyAndSendAt("the first place");
    await waitFor(() => wire.sent.length === 1, "the send on the wire");

    await visit(SECOND);
    await waitFor(() => at("the second place"), "the second place");
    await rounds(8);
    /* The machine that sent left with its place; this one is another, and says nothing of a send still on the wire. */
    expect(seen.mounts.composer, "the composers mounted over one walk").toBe(2);
    expect(sendSays("the second place")).toBe("the reply's send: idle");
    await act(async () => { wire.release(); });
    await rounds(8);
  }, 60_000);
});
