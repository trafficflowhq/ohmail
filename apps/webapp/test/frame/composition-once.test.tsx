/** @vitest-environment jsdom */
/**
 * THE COMPOSITION STANDS ONCE PER FRAME, ABOVE EVERY PANE. The shell as the tests' door mounts it: the frame over the
 * mail ground with the places the mail entry hands. A walk between two places mounts nothing of the composition a
 * second time and asks the consent wire nothing again; a send pressed before the walk is answered on the machine
 * that sent it; and at the Ohbox the app is whole: the rail, the notices, the palette, the key sheet and the way to
 * the composer. The same counts over the web's real entry, `CloudShell` itself, are `composition-once-entry.test.tsx`.
 *
 * Each part is counted live through a wrapper of its own module: the real hook or provider runs, the wrapper counts
 * its mounts.
 *
 * AND WHAT A PLACE READS OF THE MAIL GROUND, OVER TWO HOSTS, the same cases and the same expectations: over a host
 * that hands the mail ground and these two places alone, and over what the mail entry hands every browser host (its
 * ground, its stages, its reader and every place it seats) with those two places at two of its ids. The mail state,
 * the consent row and the partition stand once for the frame's life over a walk between the two, the consent wire is
 * asked once, the engine is told one cutline, and a place reads the very row and the very record the one call and
 * the one derivation answered. A place that called for the row itself would be seen: the wire is asked a second time.
 *
 * AND THE TWO DOORS OF A LETTER, read by a place as `useDoors()`: one file door and one picture door for the frame's
 * life, the very same two at every place; no letter loads a picture by itself before the account's own answer has
 * come; over a host that names no picture wire no picture door stands; an address the file door minted for a
 * letter is revoked once nobody holds that letter; and a place that holds a letter draws its list and its file as
 * they land, while the door keeps the letter for it.
 */
import type { EngineDraft, EngineMutation } from "@ohmail/wire";
import { createElement as h, useEffect, useMemo, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OhmailEngine } from "@ohmail/client-engine";
import { useConsent, usePartition } from "@ohmail/app-logic/consent";
import { useConsentRow } from "@ohmail/app-logic/consent/consent-row";
import type { ConsentTransport } from "@ohmail/app-logic/consent/consent-state";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { letterPictures, useDoors, type Doors } from "@ohmail/app-logic/reader";
import { usePresentedMirror } from "@ohmail/app-logic/reading";
import { Frame, PLACE_IDS, useFrame, type FramePlaces, type PlaceEntry } from "@ohmail/app/frame";
import { NONE, type ImageWire, type None } from "@ohmail/app/host";
import { MailGround, mailReader, NO_PANE_PARTS, NO_STAGE_PARTS, useMailSupplies, useThemeLook, type MailHostParts } from "@ohmail/app/mail";
import { letterBody } from "@ohmail/app/reader/body";
/* The ground's mounts one by one, by path: the ground stands them inside `MailGround`; the second entry
   `@ohmail/app/mail/ground` leaves with the switch. */
import { ConsentMount } from "../../../../packages/app/src/mail/ground/ConsentMount.js";
import { MailStateMount } from "../../../../packages/app/src/mail/ground/MailStateMount.js";
import { PresentedMount } from "../../../../packages/app/src/mail/ground/PresentedMount.js";
import { ScreenerMount } from "../../../../packages/app/src/mail/ground/ScreenerMount.js";
import { WritingMount } from "../../../../packages/app/src/mail/ground/WritingMount.js";
import { TextProvider } from "@ohmail/app/text";
import en from "../../messages/en.json";
import type { DraftReplyWire } from "@ohmail/app-logic/writing/draft-reply";
import { useComposer } from "@ohmail/app-logic/writing/composer-record";
import { act, message, mountShell, press, stubDom, unmountAll, waitFor, type DraftShell } from "../_draft-shell.js";
import { settleEditor } from "../_first-paint.js";
import { hostFromTodaysInputs } from "../_mail-shell";
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
  /** The press seam: its mounts, and how many stand now. */
  seam: { mounts: 0, live: 0 },
  /** The restart hold's relay over the one send machine: its mounts, and how many stand now. */
  relay: { mounts: 0, live: 0 },
  records: new WeakSet<object>(),
  /** Every row the consent row's one call answered. */
  rows: new WeakSet<object>(),
}));

vi.mock("@ohmail/app-logic/press/shell-dispatch", async (load) => {
  const real = await load<typeof import("@ohmail/app-logic/press/shell-dispatch")>();
  const { useEffect } = await import("react");
  return {
    ...real,
    useShellDispatch: (...args: Parameters<typeof real.useShellDispatch>) => {
      const seam = real.useShellDispatch(...args);
      useEffect(() => {
        seen.seam.mounts += 1;
        seen.seam.live += 1;
        return () => {
          seen.seam.live -= 1;
        };
      }, []);
      return seam;
    },
  };
});

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

vi.mock("../../../../packages/app/src/mail/ground/SendWaitsRelay.js", async (load) => {
  const real = await load<typeof import("../../../../packages/app/src/mail/ground/SendWaitsRelay.js")>();
  const { useEffect } = await import("react");
  return {
    ...real,
    SendWaitsHold: () => {
      useEffect(() => {
        seen.relay.mounts += 1;
        seen.relay.live += 1;
        return () => {
          seen.relay.live -= 1;
        };
      }, []);
      return real.SendWaitsHold();
    },
  };
});

vi.mock("@ohmail/app-logic/reader/attachments", async (load) => {
  const real = await load<typeof import("@ohmail/app-logic/reader/attachments")>();
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

vi.mock("@ohmail/app-logic/reader/remote-images", async (load) => {
  const real = await load<typeof import("@ohmail/app-logic/reader/remote-images")>();
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
const atTheOhbox = (): boolean => screen.queryByRole("heading", { name: "Ohbox" }) !== null;
const HISTORY_ADDRESS = "#/history";
const railEntries = (): number => within(screen.getByRole("navigation", { name: "Places" })).getAllByRole("button").length;
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
  const open = () => within(s.el).queryByRole("option", { name: /Plans for Friday/ });
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
  seen.relay.mounts = 0;
  seen.relay.live = 0;
  seen.partition.mounts = 0;
  seen.partition.live = 0;
  seen.seam.mounts = 0;
  seen.seam.live = 0;
  read.length = 0;
});
afterEach(async () => {
  await unmountAll();
});

/**
 * AS IT READS ONCE THE WEB'S ENTRY HANDS THE MAIL GROUND, through the tests' door of the new shell: the frame over the
 * mail ground and the mail places, nothing of today's shell above the panes. Every part of the composition stands
 * once for the frame's life over a walk between the seated places, the consent wire is asked once, the press seam is
 * the one the frame's room mounts, and the rail is the registrations', not a rail today's views feed.
 */
describe("the mail ground's composition over the web's entry, over a walk between the seated places", () => {
  const ALL_ONCE = { ...ONCE, partition: 1, seam: 1 };
  const live = () => ({ ...seen.live, partition: seen.partition.live, seam: seen.seam.live });
  const mounts = () => ({ ...seen.mounts, partition: seen.partition.mounts, seam: seen.seam.mounts });

  it("mounts the press seam, the mail state, the consent row, the partition, the composer and the two doors once, and asks the consent wire once", async () => {
    const s = await mountShell("#/ohbox", [message("m1")], []);
    await waitFor(() => atTheOhbox() && within(s.el).queryAllByRole("option").length > 0, "the Ohbox on the mail ground, with its letter");
    await rounds(8);
    expect({ mounts: mounts(), live: live(), asks: seen.asks }, "as the frame mounted").toEqual({
      mounts: ALL_ONCE, live: ALL_ONCE, asks: 1,
    });
    expect(screen.queryByRole("navigation", { name: "Places" }), "the rail of the registrations").not.toBeNull();
    expect(fedRailEntries(), "a rail today's views feed").toBe(0);

    await visit("#/compose");
    await waitFor(() => subject() !== null, "the place that writes");
    await rounds(8);
    expect(live(), "at the place that writes every part still stands, once").toEqual(ALL_ONCE);

    await visit("#/ohbox");
    await waitFor(() => atTheOhbox() && within(s.el).queryAllByRole("option").length > 0, "the Ohbox again");
    await rounds(8);
    expect({ mounts: mounts(), live: live(), asks: seen.asks }, "after the walk").toEqual({
      mounts: ALL_ONCE, live: ALL_ONCE, asks: 1,
    });
  }, 60_000);

  it("the door stands the frame over the ground with nothing of today's shell: one press seam, the room's own, and no rail a view feeds", async () => {
    await mountShell("#/ohbox", [message("m1")], []);
    await waitFor(() => screen.queryByRole("navigation", { name: "Places" }) !== null, "the frame's own rail");
    await rounds(8);
    expect(fedRailEntries(), "a rail today's views feed").toBe(0);
    expect({ seam: seen.seam.live, mailState: seen.live.mailState, consentRow: seen.live.consentRow, partition: seen.partition.live })
      .toEqual({ seam: 1, mailState: 1, consentRow: 1, partition: 1 });
    expect(seen.asks, "the asks one frame made of its consent wire").toBe(1);
  }, 60_000);
});

/**
 * THE HOST'S DRAFT WIRE REACHES THE COMPOSER, through the shell the tests' door mounts. Two hosts that differ only in
 * the draft wire they hand: one that counts what it is asked, and none. A letter opened and its More menu: over the
 * wire Draft reply opens the reply with the drafter's control, and the wire is asked to draft on that control's press
 * only; over none no Draft reply is offered and nothing is asked.
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
    const s = await mountShell(HISTORY_ADDRESS, [message("m1")], [], hands ? { draftReplyWire: wire } : {});
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
      /* The reply opens on the letter with the drafter's control at its foot, its price said on it before its press
         (Write's reply drafts in one press, where today's sheet asked first): the wire is asked on that press only. */
      const control = (): HTMLElement | null =>
        within(s.el).queryAllByRole("button", { name: en.write.draft.verb }).find((b) => b.closest('[role="menu"]') === null) ?? null;
      await waitFor(() => control() !== null, "the drafter's control at the reply's foot");
      expect(asked.create, "the wire asked to draft before the control's press").toEqual([]);
      await press(control(), "Draft reply at the reply's foot");
      await waitFor(() => asked.create.length > 0, "the wire asked to draft");
    }
    expect(asked.create, "what the wire was asked to draft").toEqual(drafted);
  }, 60_000);
});

describe("at the seated Ohbox the app is whole", () => {
  it("the fed rail, a notice of today's feeds, the palette, the key sheet and the way to the composer stand; today's reader sheet does not", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [letter], { handOff: true });
    const release = await sendTheLetter(s);
    await visit("#/history");
    await waitFor(() => screen.queryByRole("heading", { name: "History" }) !== null, "the mounted History list");
    await waitFor(saysSending, "the notice says the send is on its way");
    const entries = railEntries();
    expect(entries, "History stands beside the registered rail").toBeGreaterThan(0);

    await visit("#/ohbox");
    await waitFor(() => atTheOhbox() && within(s.el).queryAllByRole("option").length > 0, "the seated Ohbox");
    await rounds(8);
    expect({ rail: railEntries(), notice: saysSending() }, "the rail and the notice at the seated Ohbox").toEqual({
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
  return { ThemeProvider, ToastHost, EngineProvider };
}
/** What a browser host hands of its own, as an entry names it once: the letter's renderer, and no door of its own. */
const OWN_PARTS: MailHostParts = {
  reader: mailReader({ body: letterBody, look: NONE }),
  stageParts: NO_STAGE_PARTS,
  paneParts: NO_PANE_PARTS,
};
let parts: Awaited<ReturnType<typeof loaded>> | null = null;

/**
 * THE TWO HOSTS, one each over the same inputs (the window and the address as every shell hands them, the same wire,
 * the same facts), and in both the ground's own mounts make every call. `ground`: these places and no other,
 * `MailGround` above them. `entry`: everything the mail entry hands a browser host (`useMailSupplies`: its ground,
 * its stages, its reader, every place it seats), with these standing at two of its ids.
 */
type Caller = "ground" | "entry";
function Stood({ caller, engine, places, consent, images }: {
  caller: Caller; engine: OhmailEngine; places: Places; consent: ConsentTransport; images?: ImageWire | None;
}) {
  const frame = useMailSupplies(window, useThemeLook(), NONE, OWN_PARTS);
  const host = useMemo(() => {
    /* The picture wire only where a case hands one (or says none): every other case mounts as it always did. */
    const inputs = {
      demo: false, engine, consentTransport: consent, mailboxFacts: ownFacts, ...(images === undefined ? {} : { imageWire: images }),
    };
    if (caller === "entry") {
      /* What the mail entry hands is handed on whole (its stages, its reader, the ground above), as the tests' door
         and every entry hand it, with the case's two places at two of its ids. */
      const seated = { ...frame.places, ...places } as FramePlaces;
      const made = hostFromTodaysInputs(inputs, engine, { ...frame, places: seated }, NONE);
      return { ...made, features: { ...made.features, places: seated, stages: frame.stages, reader: frame.reader, above: frame.above } };
    }
    const only = { ...Object.fromEntries(PLACE_IDS.map((id) => [id, NONE])), ...places } as unknown as FramePlaces;
    const made = hostFromTodaysInputs(inputs, engine, { ...frame, places: only }, NONE);
    return { ...made, features: { ...made.features, places: only, above: MailGround } };
  }, [caller, engine, frame, places, consent, images]);
  return h(Frame, { host });
}
async function stand(
  caller: Caller, engine: OhmailEngine, places: Places,
  hands: { consent?: ConsentTransport; images?: ImageWire | None } = {},
): Promise<void> {
  parts ??= await loaded();
  const { ThemeProvider, ToastHost, EngineProvider } = parts;
  window.location.hash = FIRST;
  const tree = h(NextIntlClientProvider, { locale: "en", messages: en, timeZone: "UTC", now: NOW } as never,
    h(TextProvider, { locale: "en", messages: en as never, timeZone: "UTC" } as never,
      h(ThemeProvider as never, null, h(ToastHost as never, null,
        h(EngineProvider, { demo: false, engine } as never,
          h(Stood, { caller, engine, places, consent: hands.consent ?? answering(), images: hands.images }))))));
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
  ["what the mail entry hands a browser host", "entry"],
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
    /* A reader is handed the same row while nothing of it moved. */
    expect(second.row, "another place reads another row").toBe(first.row);

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
    /* Two rows stand in the one frame, and the wire heard more than the one ask a frame owes. */
    expect(seen.live.consentRow, "the rows that stand in one frame").toBe(2);
    expect(seen.asks, "the asks one frame made of its consent wire").toBeGreaterThan(1);
  }, 60_000);
});

/** What a place reads of the two doors, kept per render, as a seat reads them. */
const doorsRead: Array<{ at: string; doors: Doors }> = [];
const doorsAt = (name: string): Doors => [...doorsRead].reverse().find((r) => r.at === name)!.doors;
function readingTheDoorsAt(name: string, holding?: string) {
  return function ReadsTheDoors() {
    const doors = useDoors();
    doorsRead.push({ at: name, doors });
    /* As the reader's files do: the letter's list is held while this place draws it, and let go when it leaves. */
    const hold = holding === undefined ? undefined : doors.files?.hold;
    useEffect(() => hold?.(holding!), [hold]);
    return h("section", { "aria-label": name });
  };
}
const doorPlaces = (holding?: string): Places => ({
  news: { id: "news", body: "reads-the-doors-1", rail: null, panes: { kind: "wide", Wide: readingTheDoorsAt("the first place", holding) } },
  receipts: { id: "receipts", body: "reads-the-doors-2", rail: null, panes: { kind: "wide", Wide: readingTheDoorsAt("the second place") } },
});

/** A host's picture wire that counts what it is asked. */
const PIPE = { fetch: vi.fn(async () => null), record: vi.fn(async () => undefined) };
/** The account's answer on pictures, held until the case lets it go. */
function heldAnswer(): { consent: ConsentTransport; answer: () => void } {
  let answer!: () => void;
  const held = new Promise<unknown>((r) => {
    answer = () => r({ seedConfirmedAt: "2026-09-01T00:00:00.000Z", dormancyDays: 45, blockRemoteImagesAt: null });
  });
  return { consent: { foldersStorable: false, state: () => held } as unknown as ConsentTransport, answer };
}
const loadsByItself = (doors: Doors): boolean =>
  letterPictures({ id: "m1" }, false, doors.pictures ?? "none", "none", true, true).remoteLoaded;

/** One file on the letter, as an engine that opens files lists and fetches it. */
const FILE = { id: "a1", filename: "report.pdf", contentType: "application/pdf", sizeBytes: 4, inline: false, messageId: "m1" };
function opensFiles(engine: OhmailEngine): OhmailEngine {
  Object.assign((engine as unknown as { adapter: object }).adapter, {
    listAttachments: async () => [FILE],
    fetchAttachment: async () => new Blob(["file"], { type: "application/pdf" }),
  });
  return engine;
}

/** A place that does what the reader's files do: hold the letter while it draws it, and draw its list as it stands. */
function DrawsTheFiles() {
  const doors = useDoors();
  doorsRead.push({ at: "the files", doors });
  const hold = doors.files?.hold;
  useEffect(() => hold?.("m1"), [hold]);
  const list = doors.files?.itemsOf("m1", { includeInlineParts: true });
  const said =
    list === undefined
      ? "no file door"
      : list.state === "ready"
        ? `drawn: ${list.items.map((i) => `${i.filename} ${i.state}`).join(", ")}`
        : `drawn: ${list.state}`;
  return h("section", { "aria-label": "the files" }, said);
}
const drawsPlaces: Places = {
  news: { id: "news", body: "draws-the-files", rail: null, panes: { kind: "wide", Wide: DrawsTheFiles } },
  receipts: { id: "receipts", body: "reads-the-doors-2", rail: null, panes: { kind: "wide", Wide: readingTheDoorsAt("the second place") } },
};
const drawn = (): string => screen.queryByRole("region", { name: "the files" })?.textContent ?? "(no region)";

describe.each([
  ["a host that hands the mail ground", "ground"],
  ["what the mail entry hands a browser host", "entry"],
] as const)("the two doors of a letter over %s", (_, caller) => {
  const minted: string[] = [];
  const revoked: string[] = [];
  const browsers = { mint: URL.createObjectURL, revoke: URL.revokeObjectURL };
  beforeEach(() => {
    setup();
    doorsRead.length = 0;
    PIPE.fetch.mockClear();
    PIPE.record.mockClear();
    minted.length = 0;
    revoked.length = 0;
    URL.createObjectURL = () => `blob:the-file-door/${minted.push("")}`;
    URL.revokeObjectURL = (address: string) => void revoked.push(address);
  });
  afterEach(async () => {
    if (stood) await act(async () => { stood!.unmount(); });
    stood = null;
    URL.createObjectURL = browsers.mint;
    URL.revokeObjectURL = browsers.revoke;
    await teardown();
  });

  it("one file door and one picture door stand for the frame's life, and every place reads the very same two", async () => {
    const engine = opensFiles(engineOver(await storeWith([msg("m1")])));
    await stand(caller, engine, doorPlaces(), { images: PIPE });
    await waitFor(() => at("the first place") && seen.asks > 0, "the first place, the account's answer asked for");
    await rounds(8);
    const stands = () => ({ fileDoor: seen.live.fileDoor, pictureDoor: seen.live.pictureDoor });
    expect(stands(), "as the frame mounted").toEqual({ fileDoor: 1, pictureDoor: 1 });
    const first = doorsAt("the first place");
    expect(first.files, "no file door over an engine that opens files").toBeDefined();
    expect(first.pictures, "no picture door over a host that named a wire").toBeDefined();

    await visit(SECOND);
    await waitFor(() => at("the second place"), "the second place");
    await rounds(8);
    const second = doorsAt("the second place");
    expect(second.files, "another place reads another file door").toBe(first.files);
    expect(second.pictures, "another place reads another picture door").toBe(first.pictures);

    await visit(FIRST);
    await waitFor(() => at("the first place"), "the first place again");
    await rounds(8);
    expect(stands(), "after the walk").toEqual({ fileDoor: 1, pictureDoor: 1 });
    expect({ fileDoor: seen.mounts.fileDoor, pictureDoor: seen.mounts.pictureDoor }, "mounted over the walk").toEqual({ fileDoor: 1, pictureDoor: 1 });
  }, 60_000);

  it("no letter loads a picture by itself before the account's own answer has come, and the wire is asked nothing", async () => {
    const engine = engineOver(await storeWith([msg("m1")]));
    const { consent, answer } = heldAnswer();
    await stand(caller, engine, doorPlaces(), { images: PIPE, consent });
    await waitFor(() => at("the first place"), "the first place");
    await rounds(8);
    const before = doorsAt("the first place");
    expect(before.pictures, "the picture door over a host that named a wire").toBeDefined();
    expect(loadsByItself(before), "a letter loaded its pictures before the account had answered").toBe(false);
    expect(PIPE.fetch, "a picture was fetched before the account had answered").not.toHaveBeenCalled();
    expect(PIPE.record, "a press was recorded that nobody made").not.toHaveBeenCalled();

    await act(async () => { answer(); });
    await waitFor(() => loadsByItself(doorsAt("the first place")), "pictures load by the account's own answer");
    expect(PIPE.record, "a press was recorded that nobody made").not.toHaveBeenCalled();
  }, 60_000);

  it("over a host that names no picture wire no picture door stands, whatever the account answers", async () => {
    const engine = engineOver(await storeWith([msg("m1")]));
    const { consent, answer } = heldAnswer();
    await stand(caller, engine, doorPlaces(), { images: NONE, consent });
    await waitFor(() => at("the first place"), "the first place");
    await act(async () => { answer(); });
    await rounds(8);
    expect(doorsAt("the first place").pictures, "a picture door stood over a host that named no wire").toBeUndefined();
    expect(loadsByItself(doorsAt("the first place"))).toBe(false);
    await visit(SECOND);
    await waitFor(() => at("the second place"), "the second place");
    expect(doorsAt("the second place").pictures).toBeUndefined();
  }, 60_000);

  it("an address the file door minted for a letter is revoked once nobody holds that letter", async () => {
    const engine = opensFiles(engineOver(await storeWith([msg("m1")])));
    await stand(caller, engine, doorPlaces("m1"));
    await waitFor(() => at("the first place"), "the first place");
    const files = () => doorsAt("the first place").files!;
    const file = () => {
      const list = files().itemsOf("m1");
      return list.state === "ready" ? list.items[0] : undefined;
    };
    await waitFor(() => file()?.state === "idle", "the held letter's list");
    await act(async () => { files().ensure("m1", "a1"); });
    await waitFor(() => file()?.state === "ready", "the file's bytes, held by the door");
    const address = file()!.objectUrl;
    expect(address, "the door minted no address for the bytes it holds").toBe("blob:the-file-door/1");
    expect(revoked, "revoked while the letter is still held").toEqual([]);

    await visit(SECOND);
    await waitFor(() => at("the second place"), "the second place");
    await waitFor(() => revoked.includes(address!), "the address is revoked once the letter is let go");
  }, 60_000);

  it("a place that holds a letter draws its list once the list lands, and its file once the bytes land", async () => {
    const engine = opensFiles(engineOver(await storeWith([msg("m1")])));
    await stand(caller, engine, drawsPlaces);
    await waitFor(() => at("the files"), "the place that draws the files");
    const files = () => doorsAt("the files").files!;
    const engineSays = () => {
      const list = files().itemsOf("m1", { includeInlineParts: true });
      return list.state === "ready" ? `drawn: ${list.items.map((i) => `${i.filename} ${i.state}`).join(", ")}` : `drawn: ${list.state}`;
    };
    await waitFor(() => engineSays() === "drawn: report.pdf idle", "the engine holds the letter's list");
    await rounds(8);
    const afterList = { engine: engineSays(), page: drawn() };
    await act(async () => { files().ensure("m1", "a1"); });
    await waitFor(() => engineSays() === "drawn: report.pdf ready", "the engine holds the file's bytes");
    await rounds(8);
    const afterBytes = { engine: engineSays(), page: drawn() };
    expect({ afterList, afterBytes }, "what the page draws beside what the door holds").toEqual({
      afterList: { engine: "drawn: report.pdf idle", page: "drawn: report.pdf idle" },
      afterBytes: { engine: "drawn: report.pdf ready", page: "drawn: report.pdf ready" },
    });
  }, 60_000);

  it("while a place draws a letter's list and its file, the door keeps the letter: nothing is let go and asked for again", async () => {
    const engine = opensFiles(engineOver(await storeWith([msg("m1")])));
    const letGo: string[] = [];
    const release = engine.releaseAttachments.bind(engine);
    engine.releaseAttachments = (messageId, opts) => {
      letGo.push(messageId);
      release(messageId, opts);
    };
    await stand(caller, engine, drawsPlaces);
    await waitFor(() => at("the files"), "the place that draws the files");
    const files = () => doorsAt("the files").files!;
    const file = () => {
      const list = files().itemsOf("m1");
      return list.state === "ready" ? list.items[0]?.state : list.state;
    };
    await waitFor(() => file() === "idle", "the held letter's list");
    letGo.length = 0;
    await act(async () => { files().ensure("m1", "a1"); });
    await waitFor(() => file() === "ready", "the file's bytes, held by the door");
    await rounds(8);
    expect({ letGo, revoked }, "the letter was let go while a place still drew it").toEqual({ letGo: [], revoked: [] });
  }, 60_000);
});

/**
 * ONE SEND MACHINE OVER A HOST THAT HANDS THE MAIL GROUND, and nothing of the old shell. The composer's own hook is
 * called once by the ground's own mount of it (`WritingMount`, which `MailGround` stands above every place), fed
 * from the ground's contexts and the frame's door alone. Two places of two bodies press and read through it, as a
 * part beside the composer does (`useComposer()`). A reply sent at the first place, the second place visited before
 * the answer: one `mail_send`, the answer applied on the machine that sent it, the sending state gone. And the fault
 * this guards is seen: the same mount stood with a place's own body leaves with that place, and the place walked to
 * stands another machine that knows no send.
 */
/** A place that writes through the composer above it: Reply, the words, Send, and what the reply's send says now. */
function writesAt(at: string, mount: "above every place" | "with this place's body") {
  function Writes() {
    const composer = useComposer();
    return h("section", { "aria-label": at },
      h("button", { type: "button", onClick: () => composer.openReply("m1") }, "Reply"),
      h("button", { type: "button", onClick: () => composer.onReplyBody({ text: "Noon works.", html: "" }) }, "Write"),
      h("button", { type: "button", onClick: () => composer.sendReply("m1") }, "Send"),
      h("output", null, `the reply's send: ${composer.replySendState("m1").phase}`),
      h("output", null, composer.draftReplyChrome === null ? "no draft control" : "a draft control"));
  }
  return mount === "above every place" ? Writes : () => h(WritingMount, null, h(Writes));
}
const writingPlaces = (mount: "above every place" | "with this place's body"): Places => ({
  news: { id: "news", body: "writes-1", rail: null, panes: { kind: "wide", Wide: writesAt("the first place", mount) } },
  receipts: { id: "receipts", body: "writes-2", rail: null, panes: { kind: "wide", Wide: writesAt("the second place", mount) } },
});
/**
 * The ground's pieces under the composer, and no composer: a place of the plant stands the mount with its own body.
 * The Screener's model stands above it, as `MailGround` has it: the composer's price reads the Screener's standing.
 */
function GroundWithNoComposer({ children }: { readonly children: ReactNode }): ReactNode {
  return h(MailStateMount, null, h(ConsentMount, null, h(PresentedMount, null, h(ScreenerMount, null, children))));
}
function StoodOverTheGround({ engine, places, above }: {
  engine: OhmailEngine; places: Places; above: (props: { readonly children: ReactNode }) => ReactNode;
}) {
  const frame = useMailSupplies(window, useThemeLook(), NONE, OWN_PARTS);
  const consent = useMemo(answering, []);
  const host = useMemo(() => {
    const only = { ...Object.fromEntries(PLACE_IDS.map((id) => [id, NONE])), ...places } as unknown as FramePlaces;
    const made = hostFromTodaysInputs(
      { demo: false, engine, consentTransport: consent, mailboxFacts: ownFacts }, engine, { ...frame, places: only }, NONE,
    );
    return { ...made, features: { ...made.features, places: only, above } };
  }, [engine, frame, places, consent, above]);
  return h(Frame, { host });
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
    await standOverTheGround(engine, writingPlaces("above every place"), MailGround);
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
    expect({ ...seen.relay }, "the restart hold's relay over the walk, beside the one machine").toEqual({ mounts: 1, live: 1 });

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
    await standOverTheGround(engine, writingPlaces("with this place's body"), GroundWithNoComposer);
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
