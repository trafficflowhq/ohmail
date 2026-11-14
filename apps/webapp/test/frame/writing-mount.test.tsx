/** @vitest-environment jsdom */
/**
 * THE COMPOSER'S ONE MOUNT UNDER THE MAIL GROUND, over a real engine: the frame over a tests' host that hands
 * `MailGround`, places that read the composer above them (as a part beside it does, `useComposer()`, and as the
 * screen does, `useWriting()`), and the web's own catalogue. Nothing of the old shell stands here.
 *
 * WHOSE WORDS. A reply's and a letter's words written under one account are never offered under another after the
 * scope changes under a mounted frame, are written under no key of another account, and are there again under the
 * first. A page that stays on its account changes no key of another's. A person who leaves the place `write`, or
 * whose scope ends, has their letter saved to a draft; nothing is written after the scope has gone.
 *
 * WHAT A HOST HANDS. Over a host that names no draft wire there is no control and nothing is asked; over one that
 * hands a wire the control stands and the wire is asked once for one press. A letter handed in is taken once and
 * seeded once.
 *
 * THE REPLY'S OPEN LETTER is the mount's own: a change of place closes it and keeps its words; a reply draft opened
 * from a place with no reading column rides the walk to its letter; on one column an opened reply shows its letter.
 */
import type { EngineDraft, EngineMessage, EngineMutation } from "@ohmail/wire";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OhmailEngine } from "@ohmail/client-engine";
import { useComposer } from "@ohmail/app-logic/writing/composer-record";
import { resetComposerForTest } from "@ohmail/app-logic/writing/compose";
import type { DraftReplyWire } from "@ohmail/app-logic/writing/draft-reply";
import { announceUpdate, resetUpdateStoreForTests, restartHold, type UpdateOffer } from "@ohmail/app-logic/doors/app-update";
import { readReplyMeta } from "@ohmail/app-logic/writing/mail-send";
import type { ShellCompose } from "@ohmail/app-logic/writing/shell-compose";
import {
  Frame,
  useFrame,
  type FrameCommands,
  type FrameHost,
  type FramePlaces,
  type PlaceEntry,
  type PlaceId,
  type Route,
} from "@ohmail/app/frame";
import { NONE, type LinkIn, type LinkedDraft, type ReaderEntry } from "@ohmail/app/host";
import { MailGround } from "@ohmail/app/mail";
/* The ground's mounts one by one, by path: the ground stands them inside `MailGround`; the second entry
   `@ohmail/app/mail/ground` leaves with the switch. */
import { ConsentMount } from "../../../../packages/app/src/mail/ground/ConsentMount.js";
import { MailStateMount } from "../../../../packages/app/src/mail/ground/MailStateMount.js";
import { PresentedMount } from "../../../../packages/app/src/mail/ground/PresentedMount.js";
import { WritingMount } from "../../../../packages/app/src/mail/ground/WritingMount.js";
import { ScreenerAbove, type ScreenerBeside } from "@ohmail/app/screener";
import type { ScreenerState } from "@ohmail/app-logic/screener";
import { TextProvider, type Messages } from "@ohmail/app/text";
import { useWriting, type Writing } from "@ohmail/app/write";
import { fakeHost } from "../../../../packages/app/test/support/fake-host.js";
import { fakeAddress, fakeWindow, type FakeAddress } from "../../../../packages/app/test/support/fake-window.js";
import { useWritingInputs } from "../../../../packages/app/test/support/writing-inputs.js";
import en from "../../messages/en.json";
import { engineOver, message, replyDraft, ROSTER, storeWith, stubDom, waitFor } from "../_draft-shell.js";

/** Every input record the one composer was handed, in order: the real hook runs, its wrapper keeps what it was given. */
const handed = vi.hoisted(() => ({ inputs: [] as { mailtoDraft?: unknown }[] }));
vi.mock("@ohmail/app-logic/writing/shell-compose", async (load) => {
  const real = await load<typeof import("@ohmail/app-logic/writing/shell-compose")>();
  return {
    ...real,
    useShellCompose: (...args: Parameters<typeof real.useShellCompose>) => {
      handed.inputs.push(args[0]);
      return real.useShellCompose(...args);
    },
  };
});

/* The web's catalogue, as the web shell hands the frame its words. */
const WORDS = en as unknown as Messages;

interface Seen {
  readonly composer: ShellCompose;
  readonly writing: Writing;
  readonly route: Route;
  readonly commands: FrameCommands;
}
let seen: Seen | null = null;
/** What the place on screen read at its last render. */
const now = (): Seen => {
  if (seen === null) throw new Error("no place has read the composer yet");
  return seen;
};

/** A place that reads the one composer above it, as a part beside it does and as the screen does. */
function Reads(): ReactNode {
  const composer = useComposer();
  const writing = useWriting();
  const { route, commands } = useFrame();
  seen = { composer, writing, route, commands };
  return <output>{`at ${route.place}`}</output>;
}
const wide = (id: PlaceId): PlaceEntry => ({
  id,
  body: `reads-${id}`,
  rail: null,
  panes: { kind: "wide", Wide: Reads },
});
/** The reading column a host hands: a letter is read where a place names it. */
const READER: ReaderEntry = { Reading: () => <output>the reading column</output>, Actions: () => null };
const PLACES: Partial<FramePlaces> = {
  ohbox: { id: "ohbox", body: "ohbox", rail: null, panes: { kind: "columns", List: Reads, Reading: "reader" } },
  write: wide("write"),
  drafts: wide("drafts"),
  news: wide("news"),
};

interface Account {
  readonly host: FrameHost;
  readonly engine: OhmailEngine;
  readonly address: FakeAddress;
  /** Every change that reached this account's wire, in order. */
  readonly sent: EngineMutation[];
  readonly sendGate: { wait: Promise<void> | null };
  /** While set, a draft's save waits on it before the server answers: a save still in the air. */
  readonly saveGate: { wait: Promise<void> | null };
  /** Each row's version on the server, where the account keeps them (`versions`): set one to change it elsewhere. */
  readonly versions: Map<string, string> | null;
  /** While on, every change waits on the outbox (no signal); turned off, the signal is back. */
  readonly offline: { on: boolean };
}
async function account(
  scope: string,
  o: {
    at?: string;
    messages?: EngineMessage[];
    drafts?: EngineDraft[];
    draftReply?: DraftReplyWire;
    room?: "desktop" | "phone";
    linkIn?: LinkIn;
    /** No signal: every change waits on the outbox. */
    offline?: boolean;
    /** The account's server refuses every send for good, naming the row it used or made. */
    refusesSend?: boolean;
    /** Each row has a version on the server, and a save stating another one is refused. */
    versions?: boolean;
    /** What stands above the panes in place of the mail ground (a case that stands the Screener's model itself). */
    above?: FrameHost["features"]["above"];
  } = {},
): Promise<Account> {
  const sent: EngineMutation[] = [];
  const sendGate: Account["sendGate"] = { wait: null };
  const saveGate: Account["saveGate"] = { wait: null };
  const store = await storeWith(o.messages ?? [message("m1")], o.drafts ?? []);
  const versions = o.versions === true ? new Map<string, string>() : null;
  const offline = { on: o.offline === true };
  const engine = engineOver(
    store, sent, { on: o.refusesSend === true }, saveGate, [], offline, sendGate,
    undefined, undefined, undefined, undefined, undefined, versions,
  );
  const address = fakeAddress(o.at ?? "#/ohbox");
  const { host } = fakeHost({
    engine,
    service: "managed",
    scope,
    places: PLACES,
    reader: READER,
    above: o.above ?? MailGround,
    mailboxes: async () => ROSTER,
    window: fakeWindow(o.room ?? "desktop"),
    address,
    ...(o.draftReply !== undefined ? { wires: { draftReply: o.draftReply as never } } : {}),
  });
  return {
    host: o.linkIn !== undefined ? { ...host, signals: { ...host.signals, linkIn: o.linkIn } } : host,
    engine,
    address,
    sent,
    sendGate,
    saveGate,
    versions,
    offline,
  };
}

/** The frame over a host, under the web's words, as a shell stands it (the frame stands its own key map). */
function Stood({ host }: { readonly host: FrameHost }): ReactNode {
  return (
    <TextProvider locale="en" messages={WORDS} timeZone="UTC">
      <Frame host={host} />
    </TextProvider>
  );
}
/** Mounts the frame over `host` and waits until a place has read the composer. */
async function stand(host: FrameHost): Promise<ReturnType<typeof render>> {
  seen = null;
  let stood!: ReturnType<typeof render>;
  await act(async () => {
    stood = render(<Stood host={host} />);
  });
  await waitFor(() => seen !== null, "a place under the composer");
  return stood;
}
/** The same frame handed another host (another scope mounts everything again), or none on screen (`gone`). */
async function hand(stood: ReturnType<typeof render>, host: FrameHost, gone = false): Promise<void> {
  seen = null;
  await act(async () => {
    stood.rerender(<Stood host={host} />);
  });
  if (!gone) await waitFor(() => seen !== null, "a place under the composer");
}
const rounds = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i += 1) await act(async () => new Promise((r) => setTimeout(r, 5)));
};
const go = async (commands: () => void): Promise<void> => {
  await act(async () => commands());
  await rounds(4);
};

/** This browser's stored keys whose value holds `word`. */
const holding = (word: string): string[] =>
  Object.keys(localStorage)
    .filter((key) => (localStorage.getItem(key) ?? "").includes(word))
    .sort();
const naming = (who: string): string[] =>
  Object.keys(localStorage)
    .filter((key) => key.includes(who))
    .sort();
/** Every stored key with its value now: what changed is read by comparing two of these. */
const jar = (): Record<string, string> =>
  Object.fromEntries(Object.keys(localStorage).sort().map((key) => [key, localStorage.getItem(key) ?? ""]));

async function writeReply(words: string): Promise<void> {
  await act(async () => now().composer.openReply("m1"));
  await rounds(4);
  await act(async () => now().composer.onReplyBody({ text: words, html: "" }));
  await waitFor(() => holding(words).length > 0, "the reply's words in this browser's store");
}
async function writeLetter(subject: string, words: string): Promise<void> {
  await go(() => now().commands.go({ place: "write" }));
  await act(async () =>
    now().composer.onComposeFields({
      ...now().composer.compose,
      to: "mila@example.invalid",
      subject,
      body: words,
    }),
  );
  await waitFor(() => holding(words).length > 0, "the letter's words in this browser's store");
}
const saves = (a: Account): EngineMutation[] => a.sent.filter((m) => m.kind === "draft_save");
const sends = (a: Account): EngineMutation[] => a.sent.filter((m) => m.kind === "mail_send");

beforeEach(() => {
  localStorage.clear();
  stubDom();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
});
afterEach(() => {
  cleanup();
  resetComposerForTest();
  resetUpdateStoreForTests();
  vi.restoreAllMocks();
  seen = null;
  handed.inputs.length = 0;
});

describe("whose words the composer holds, under the mail ground", () => {
  it("a reply's and a letter's words under one account are not offered under another, are written under no key of it, and are there again under the first", async () => {
    const A = await account("acc-a");
    const B = await account("acc-b");
    const stood = await stand(A.host);
    await writeReply("AWORDS-REPLY half written");
    await writeLetter("AWORDS-SUBJECT", "AWORDS-LETTER half written");
    expect(holding("AWORDS").every((key) => key.includes("acc-a")), "A's words lie under A's keys alone").toBe(true);

    /* The scope changes under the mounted frame: everything mounts again, as another account. */
    await hand(stood, B.host);
    await act(async () => now().composer.openReply("m1"));
    await rounds(6);
    expect(now().writing.replyTo).toBe("m1");
    expect(now().composer.replyBody.text, "B's reply to a letter of the same id").toBe("");
    await go(() => now().commands.go({ place: "write" }));
    expect(now().composer.compose.subject).toBe("");
    expect(now().composer.compose.body).toBe("");
    /* Longer than the autosave's delay, twice: whatever B's composer would write has been written. */
    await rounds(400);
    expect(holding("AWORDS").filter((key) => !key.includes("acc-a")), "a key that is not A's holds A's words").toEqual([]);
    expect(naming("acc-b").filter((key) => (localStorage.getItem(key) ?? "").includes("AWORDS"))).toEqual([]);
    expect(Object.keys(localStorage).filter((key) => /[.:]local(?:[.:]|$)/.test(key)), "a key of no account").toEqual([]);
    expect(B.sent.filter((m) => JSON.stringify(m).includes("AWORDS")), "A's words on B's wire").toEqual([]);

    /* And back: A's words are A's again. */
    await hand(stood, A.host);
    await act(async () => now().composer.openReply("m1"));
    await rounds(6);
    expect(now().composer.replyBody.text).toBe("AWORDS-REPLY half written");
    await go(() => now().commands.go({ place: "write" }));
    await waitFor(() => now().composer.compose.body !== "", "A's letter back in the form");
    expect(now().composer.compose.subject).toBe("AWORDS-SUBJECT");
    expect(now().composer.compose.body).toBe("AWORDS-LETTER half written");
  }, 60_000);

  it("a page that stays on its account changes no key of another's, also while its send is held and when it is answered", async () => {
    const A = await account("acc-a");
    const slot = JSON.stringify({ to: "giulia@example.invalid", cc: "", bcc: "", subject: "BWORDS-SUBJECT", body: "BWORDS-HANDOFF" });
    localStorage.setItem("ohmail.ui.compose.acc-b", slot);
    await stand(A.host);
    let release!: () => void;
    A.sendGate.wait = new Promise<void>((r) => {
      release = r;
    });
    await writeReply("AWORDS-REPLY to send");
    await act(async () => now().composer.sendReply("m1"));
    await waitFor(() => now().composer.replySendState("m1").phase === "sending", "the reply's send on its way");
    await writeLetter("AWORDS-SUBJECT", "AWORDS-ONE");
    await rounds(400);
    expect(localStorage.getItem("ohmail.ui.compose.acc-b"), "B's letter, as a closed tab of B left it").toBe(slot);
    expect(naming("acc-b")).toEqual(["ohmail.ui.compose.acc-b"]);
    await act(async () => release());
    await waitFor(() => now().composer.replySendState("m1").phase !== "sending", "the answer applied");
    await rounds(40);
    expect(sends(A), "one send left for one press").toHaveLength(1);
    expect(naming("acc-b")).toEqual(["ohmail.ui.compose.acc-b"]);
    expect(localStorage.getItem("ohmail.ui.compose.acc-b")).toBe(slot);
  }, 60_000);

  it("a letter written at the place write is saved to a draft when the person leaves it", async () => {
    const A = await account("acc-a");
    await stand(A.host);
    await writeLetter("Plans for Friday", "AWORDS-LETTER kept for later");
    expect(now().route.place).toBe("write");
    const before = saves(A).length;
    await go(() => now().commands.go({ place: "ohbox" }));
    await waitFor(() => saves(A).length > before, "the letter's save on the wire");
    expect(JSON.stringify(saves(A).at(-1))).toContain("AWORDS-LETTER kept for later");
    expect(sends(A), "leaving a letter sends nothing").toEqual([]);
  }, 60_000);

  it("when the scope ends the letter is saved under its account, its answer after the sweep writes nothing, and the account's next letter is a row of its own", async () => {
    const A = await account("acc-a");
    const stood = await stand(A.host);
    await writeReply("AWORDS-REPLY half written");
    await writeLetter("AWORDS-SUBJECT", "AWORDS-LETTER half written");
    const before = saves(A).length;
    /* The leaving save's answer is held, as a slow network holds it, until the host has swept the account's keys. */
    let release!: () => void;
    A.saveGate.wait = new Promise<void>((r) => {
      release = r;
    });
    /* Signed out: the host's scope names nobody, and the frame mounts nothing under it. */
    await hand(stood, { ...A.host, session: { ...A.host.session, scope: null } }, true);
    await waitFor(() => saves(A).length > before, "the letter's save, as its composer left");
    expect(JSON.stringify(saves(A).at(-1))).toContain("AWORDS-LETTER half written");
    /* The host's sweep of the account's keys, as its sign-out makes it once the frame is gone; then the answer. */
    for (const key of naming("acc-a")) localStorage.removeItem(key);
    await act(async () => release());
    A.saveGate.wait = null;
    await rounds(80);
    /* Soft: what the account's next letter does is read too where a key was written. */
    expect.soft(holding("AWORDS"), "a key written after the sweep holds the account's words").toEqual([]);
    expect.soft(naming("acc-a"), "a key of the account written after the sweep").toEqual([]);
    expect(sends(A), "signing out sends nothing").toEqual([]);
    const kept = A.engine.read().list<EngineDraft>("draft").find((d) => d.body === "AWORDS-LETTER half written");
    expect(kept, "the letter saved as the scope ended is a draft of the account").toBeDefined();

    /* Signed in again as the same account, in the same tab: a new letter. */
    await hand(stood, A.host);
    const from = saves(A).length;
    await writeLetter("NEW-SUBJECT", "NEW-LETTER typed after signing in again");
    await waitFor(() => saves(A).length > from, "the new letter's save", 400);
    const later = saves(A).slice(from).map((m) => (m as { draftId?: string | null }).draftId ?? null);
    expect(later[0], "the new letter's save makes a row of its own").toBeNull();
    expect(later, "the new letter's saves name the row saved as the scope ended").not.toContain(kept!.id);
    expect(A.engine.read().get<EngineDraft>("draft", kept!.id)?.body, "the letter saved as the scope ended").toBe(
      "AWORDS-LETTER half written",
    );
  }, 60_000);

  it("a reply open as the scope ends saves its words to its row, and the answer after the sweep writes nothing", async () => {
    const A = await account("acc-a");
    const stood = await stand(A.host);
    await writeReply("AWORDS-REPLY first words");
    /* The reply's pause made its row, and the reply's own record of it stands. */
    const meta = (): string | undefined => naming("acc-a").find((key) => (localStorage.getItem(key) ?? "").includes('"row"'));
    await waitFor(() => meta() !== undefined, "the reply's row, as its first save made it", 400);
    await act(async () => now().composer.onReplyBody({ text: "AWORDS-REPLY first words, and more", html: "" }));
    await waitFor(() => holding("and more").length > 0, "the newer words in this browser's store");
    const before = saves(A).length;
    let release!: () => void;
    A.saveGate.wait = new Promise<void>((r) => {
      release = r;
    });
    await hand(stood, { ...A.host, session: { ...A.host.session, scope: null } }, true);
    await waitFor(() => saves(A).length > before, "the reply's save, as its composer left");
    expect(JSON.stringify(saves(A).at(-1))).toContain("and more");
    for (const key of naming("acc-a")) localStorage.removeItem(key);
    await act(async () => release());
    A.saveGate.wait = null;
    await rounds(80);
    expect(naming("acc-a"), "a key of the account written after the sweep").toEqual([]);
    expect(sends(A), "signing out sends nothing").toEqual([]);
    const row = A.engine.read().list<EngineDraft>("draft").find((d) => d.inReplyToMessageId === "m1");
    expect(row?.body, "the reply's row holds the words its composer left with").toBe("AWORDS-REPLY first words, and more");
  }, 60_000);

  /* A lane with something to save and no words of its own stored: its record of the row stands in its meta alone. */
  const NO_WORDS_STORED: readonly {
    readonly sequence: string;
    readonly lane: string;
    readonly isRow: (d: EngineDraft) => boolean;
    /** What stands before the last edit. */
    readonly before: () => Promise<void>;
    /** The last edit, after which the lane's save is made. */
    readonly edit: () => Promise<void>;
    /** The save is the pause's create, on the wire as the scope ends; else the save the composer makes as it leaves. */
    readonly inTheAir: boolean;
  }[] = [
    {
      sequence: "an emptied reply that has its row",
      lane: "m1",
      isRow: (d) => d.inReplyToMessageId === "m1",
      before: async () => {
        await writeReply("AWORDS-REPLY first words");
        await waitFor(() => readReplyMeta("m1", "acc-a").row?.rev !== undefined, "the reply's row, as its first save made it", 400);
      },
      edit: async () => {
        await act(async () => now().composer.onReplyBody({ text: "", html: "" }));
        await waitFor(() => holding("AWORDS-REPLY").length === 0, "the emptied reply's words gone from this browser's store");
      },
      inTheAir: false,
    },
    {
      sequence: "a reply with a retitled subject and no words",
      lane: "m1",
      isRow: (d) => d.inReplyToMessageId === "m1",
      before: async () => {
        await act(async () => now().composer.openReply("m1"));
        await rounds(4);
      },
      edit: async () => {
        await act(async () => now().composer.onReplySubject("Retitled, and nothing more"));
      },
      inTheAir: true,
    },
    {
      sequence: "a forward with recipients and no words",
      lane: "fwd:m1",
      isRow: (d) => d.forwardOfMessageId === "m1",
      before: async () => {
        await act(async () => now().composer.openForward("m1"));
        await rounds(6);
      },
      edit: async () => {
        await act(async () => now().composer.setReplyEnvelope({ to: "dora@example.invalid", cc: "", bcc: "" }));
      },
      inTheAir: true,
    },
  ];
  it.each(NO_WORDS_STORED)(
    "$sequence: after a switch of account, the lane's record names its row as its last save left it",
    async ({ lane, isRow, before, edit, inTheAir }) => {
      const A = await account("acc-a", { versions: true });
      const B = await account("acc-b");
      const stood = await stand(A.host);
      await before();
      const saved = saves(A).length;
      let release!: () => void;
      A.saveGate.wait = new Promise<void>((r) => {
        release = r;
      });
      await edit();
      if (inTheAir) await waitFor(() => saves(A).length > saved, "the lane's create on the wire", 400);
      /* Another account in the same tab, no sweep: the first account's composer is gone, and its save is answered after. */
      await hand(stood, B.host);
      await waitFor(() => saves(A).length > saved, "the lane's save, as its composer left");
      await act(async () => release());
      A.saveGate.wait = null;
      await rounds(80);
      const row = A.engine.read().list<EngineDraft>("draft").find(isRow);
      expect(row, "the lane's row on the account").toBeDefined();
      const record = readReplyMeta(lane, "acc-a").row;
      expect(record?.id, "the row the lane's record names").toBe(row!.id);
      expect(record?.rev, "the version of the row the lane's record names").toBe(row!.contentRevision);
      expect(sends(A), "a switch of account sends nothing").toEqual([]);
    },
    60_000,
  );

  it("a reply whose leaving update is refused as changed elsewhere after its account's keys were swept while the frame stood: its words reach a row of the account, and no key of that account is written again", async () => {
    const A = await account("acc-a", { versions: true });
    const stood = await stand(A.host);
    await writeReply("AWORDS-REPLY first words");
    await waitFor(() => readReplyMeta("m1", "acc-a").row?.rev !== undefined, "the reply's row, as its first save made it", 400);
    const first = readReplyMeta("m1", "acc-a").row!.id;
    await act(async () => now().composer.onReplyBody({ text: "AWORDS-REPLY first words, and more", html: "" }));
    await waitFor(() => holding("and more").length > 0, "the newer words in this browser's store");
    /* The row is changed on another device: the leaving update states a version the server no longer holds. */
    A.versions!.set(first, "changed-elsewhere");
    const before = saves(A).length;
    /* The host sweeps the account's keys while the frame stands, then ends the scope, with no render in between. */
    seen = null;
    await act(async () => {
      for (const key of naming("acc-a")) localStorage.removeItem(key);
      stood.rerender(<Stood host={{ ...A.host, session: { ...A.host.session, scope: null } }} />);
    });
    await waitFor(() => saves(A).length > before, "the reply's save, as its composer left");
    await rounds(80);
    const rows = A.engine.read().list<EngineDraft>("draft").filter((d) => d.inReplyToMessageId === "m1");
    expect(rows.some((d) => d.id !== first && d.body === "AWORDS-REPLY first words, and more"), "the fork's row on the account, with the words the composer left with").toBe(true);
    expect(naming("acc-a"), "a key of the account written after its sweep").toEqual([]);
    expect(sends(A), "signing out sends nothing").toEqual([]);
  }, 60_000);

  it("a letter whose account's keys were swept while the frame stood is saved as the scope ends, and no key of that account is written again", async () => {
    const A = await account("acc-a");
    const stood = await stand(A.host);
    await writeLetter("AWORDS-SUBJECT", "AWORDS-LETTER half written");
    const before = saves(A).length;
    /* The host sweeps the account's keys while the frame stands, then ends the scope, with no render in between. */
    seen = null;
    await act(async () => {
      for (const key of naming("acc-a")) localStorage.removeItem(key);
      stood.rerender(<Stood host={{ ...A.host, session: { ...A.host.session, scope: null } }} />);
    });
    await waitFor(() => saves(A).length > before, "the letter's save, as its composer left");
    expect(JSON.stringify(saves(A).at(-1))).toContain("AWORDS-LETTER half written");
    await rounds(80);
    expect(naming("acc-a"), "a key of the account written after its sweep").toEqual([]);
    expect(sends(A), "signing out sends nothing").toEqual([]);
  }, 60_000);
});

/**
 * The ground's pieces the composer reads, with the Screener's model stood by the case: its suggestion run says why
 * the last run could not buy (`standing`), as the Screener's own mount hands it beside the model.
 */
function groundWithStanding(standing: "no_budget" | "refused" | null): NonNullable<FrameHost["features"]["above"]> {
  const beside = {
    suggest: { priced: true, control: { standing } },
  } as unknown as ScreenerBeside;
  const model = { flush: () => undefined } as unknown as ScreenerState;
  return function Ground({ children }: { readonly children: ReactNode }) {
    return (
      <MailStateMount>
        <ConsentMount>
          <PresentedMount>
            <ScreenerAbove model={model} beside={beside}>
              <WritingMount>{children}</WritingMount>
            </ScreenerAbove>
          </PresentedMount>
        </ConsentMount>
      </MailStateMount>
    );
  };
}

/** A draft wire that counts what it is asked. */
function countingWire(): { wire: DraftReplyWire; asked: { create: string[]; read: string[] } } {
  const asked = { create: [] as string[], read: [] as string[] };
  return {
    asked,
    wire: {
      configured: () => true,
      create: async (messageId) => {
        asked.create.push(messageId);
        return { draftId: "d-drafted" };
      },
      read: async (draftId) => {
        asked.read.push(draftId);
        return { body: "Noon works.", html: null };
      },
      fromText: "none",
    },
  };
}

describe("the host's draft wire reaches the one composer, and none is never replaced", () => {
  it("a host that hands a draft wire: the control stands, and one press asks the wire once", async () => {
    const { wire, asked } = countingWire();
    const A = await account("acc-a", { draftReply: wire });
    await stand(A.host);
    expect(now().composer.draftReplyChrome, "the composer's control over a host with a drafter").not.toBeNull();
    expect(now().writing.draftReply.offered).toBe(true);
    expect(asked).toEqual({ create: [], read: [] });
    await act(async () => now().writing.draftReply.press("m1", { text: "", html: "" }));
    await waitFor(() => now().composer.replyBody.text !== "", "the draft in the reply");
    expect(asked).toEqual({ create: ["m1"], read: ["d-drafted"] });
    expect(now().composer.replyBody.text).toBe("Noon works.");
    expect(now().writing.replyTo).toBe("m1");
    expect(sends(A), "a drafted reply is not a sent one").toEqual([]);
  }, 60_000);

  it.each([
    ["the balance was last refused as empty", "no_budget", true],
    ["the last run was refused for another reason", "refused", false],
    ["no run has been refused", null, false],
  ] as const)("where the Screener's standing says %s, the draft says so instead of its price: %s", async (_, standing, empty) => {
    const { wire } = countingWire();
    const A = await account("acc-a", { draftReply: wire, above: groundWithStanding(standing) });
    await stand(A.host);
    expect(now().writing.draftReplyChrome.noCredits === true, "the draft's control told the balance is empty").toBe(empty);
  }, 60_000);

  it("a host that names no drafter: no control, and nothing is asked of any wire", async () => {
    const asks = vi.spyOn(globalThis, "fetch");
    const { asked } = countingWire();
    const A = await account("acc-a");
    expect(A.host.wires.draftReply).toBe(NONE);
    await stand(A.host);
    expect(now().composer.draftReply, "the composer's control over a host that named none").toBeNull();
    expect(now().composer.draftReplyChrome).toBeNull();
    expect(now().writing.draftReply.offered, "the screen draws no draft control").toBe(false);
    expect(now().writing.draftReply.fromText).toBe("none");
    /* The screen's doors lead nowhere: no hook stands behind them. */
    await act(async () => {
      now().writing.draftReply.open("m1");
      now().writing.draftReply.confirm();
      now().writing.draftReply.press("m1", { text: "", html: "" });
    });
    await rounds(40);
    expect(now().writing.replyTo, "nothing opened a reply").toBeNull();
    expect(asked).toEqual({ create: [], read: [] });
    expect(asks, "a request left for a host that named no drafter").not.toHaveBeenCalled();
    expect(A.sent).toEqual([]);
  }, 60_000);
});

/** A host's link door: `take()` hands each link over once. */
function links(first: LinkedDraft | null): { door: LinkIn; arrive: (link: LinkedDraft) => void; takes: () => number } {
  let waiting = first;
  let takes = 0;
  const told = new Set<() => void>();
  return {
    takes: () => takes,
    arrive: (link) => {
      waiting = link;
      for (const tell of [...told]) tell();
    },
    door: {
      take: () => {
        takes += 1;
        const link = waiting;
        waiting = null;
        return link;
      },
      subscribe: (arrived) => {
        told.add(arrived);
        return () => told.delete(arrived);
      },
    },
  };
}
const linked = (to: string, subject: string): LinkedDraft => ({ to: [to], cc: [], bcc: [], subject, body: "" });

describe("a letter handed in is taken once and seeded once", () => {
  it("the host's link at the mount, and a second one that arrives while the frame stands", async () => {
    const mail = links(linked("ben@example.invalid", "From a link"));
    const A = await account("acc-a", { linkIn: mail.door });
    await stand(A.host);
    await waitFor(() => A.address.read() === "#/compose", "the place write");
    await waitFor(() => now().composer.compose.subject === "From a link", "the link's letter in the form");
    expect(now().composer.compose.to).toContain("ben@example.invalid");
    const writesThen = A.address.writes.length;
    await rounds(60);
    expect(A.address.writes.length, "the link was seeded once: nothing walked again").toBe(writesThen);
    /* Handed to the composer, and let go once it was seeded. */
    expect(handed.inputs.some((input) => input.mailtoDraft != null)).toBe(true);
    expect(handed.inputs.at(-1)!.mailtoDraft, "the link is let go once it is seeded").toBeNull();
    /* The form is the person's now: what they write over the link's subject stays. */
    await act(async () => now().composer.onComposeFields({ ...now().composer.compose, subject: "Mine now" }));
    await rounds(60);
    expect(now().composer.compose.subject).toBe("Mine now");
    expect(mail.door.take(), "the door holds nothing: the mount took the link").toBeNull();

    /* A second link arrives while the frame stands: it is taken, the letter on screen is saved first, then replaced. */
    const taken = mail.takes();
    await act(async () => mail.arrive(linked("dora@example.invalid", "A second link")));
    await waitFor(() => now().composer.compose.subject === "A second link", "the second link's letter in the form", 400);
    expect(mail.takes()).toBeGreaterThan(taken);
    expect(mail.door.take()).toBeNull();
    expect(saves(A).some((m) => JSON.stringify(m).includes("Mine now")), "the letter it replaced was saved first").toBe(true);
    expect(sends(A), "a link sends nothing").toEqual([]);
  }, 60_000);

  /** The letters handed to the composer, in the order it was first handed each. */
  const handedLetters = (): unknown[] =>
    handed.inputs.map((input) => input.mailtoDraft).filter((d, i, all) => d != null && all.indexOf(d) === i);

  it("two of the host's links arriving together both reach the composer, in their order, the second in the form", async () => {
    const mail = links(null);
    const A = await account("acc-a", { linkIn: mail.door });
    await stand(A.host);
    const first = linked("ben@example.invalid", "The first link");
    const second = linked("dora@example.invalid", "The second link");
    await act(async () => {
      mail.arrive(first);
      mail.arrive(second);
    });
    await waitFor(() => now().composer.compose.subject === "The second link", "the second link's letter in the form", 400);
    expect(handedLetters(), "the letters the composer was handed").toEqual([first, second]);
    expect(now().composer.compose.to).toContain("dora@example.invalid");
    expect(mail.door.take(), "the door holds nothing: the mount took both links").toBeNull();
    expect(sends(A), "a letter handed in sends nothing").toEqual([]);
  }, 60_000);

  it("a host's link and a feature's letter arriving together both reach the composer, in their order, the feature's in the form", async () => {
    const mail = links(null);
    const A = await account("acc-a", { linkIn: mail.door });
    await stand(A.host);
    const link = linked("eli@example.invalid", "From a link");
    const letter = linked("cleo@example.invalid", "Handed by a feature");
    await act(async () => {
      mail.arrive(link);
      now().commands.write(letter);
    });
    await waitFor(() => now().composer.compose.subject === "Handed by a feature", "the feature's letter in the form", 400);
    expect(handedLetters(), "the letters the composer was handed").toEqual([link, letter]);
    expect(now().composer.compose.to).toContain("cleo@example.invalid");
    expect(sends(A), "a letter handed in sends nothing").toEqual([]);
  }, 60_000);

  it("a link handed in again, waiting or already seeded, is taken once, and the letters after it still reach the composer", async () => {
    const mail = links(null);
    const A = await account("acc-a", { linkIn: mail.door });
    await stand(A.host);
    const first = linked("ben@example.invalid", "The first link");
    const second = linked("dora@example.invalid", "The second link");
    const third = linked("eli@example.invalid", "The third link");
    /* The same link twice while it waits, then another. */
    await act(async () => {
      mail.arrive(first);
      mail.arrive(first);
      mail.arrive(second);
    });
    await waitFor(() => now().composer.compose.subject === "The second link", "the second link's letter in the form", 400);
    /* The first once more, long after it was seeded, then another. */
    await act(async () => {
      mail.arrive(first);
      mail.arrive(third);
    });
    await waitFor(() => now().composer.compose.subject === "The third link", "the third link's letter in the form", 400);
    /* Each letter handed to the composer in one stretch of renders: none of them twice. */
    const stretches = handed.inputs
      .map((input) => input.mailtoDraft)
      .filter((d) => d != null)
      .filter((d, i, all) => i === 0 || all[i - 1] !== d);
    expect(stretches, "the letters the composer was handed, each time it was handed one").toEqual([first, second, third]);
    expect(sends(A), "a letter handed in sends nothing").toEqual([]);
  }, 60_000);

  it("a letter a feature hands to write is seeded as the place stands", async () => {
    const A = await account("acc-a");
    await stand(A.host);
    await go(() => now().commands.write(linked("cleo@example.invalid", "Handed by a feature")));
    await waitFor(() => now().composer.compose.subject === "Handed by a feature", "the handed letter in the form");
    expect(now().route.place).toBe("write");
    expect(now().composer.compose.to).toContain("cleo@example.invalid");
    expect(sends(A)).toEqual([]);
  }, 60_000);
});

/** The ground's pieces under the composer, and no composer: the place below reads what the mount would hand it. */
function GroundWithNoComposer({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <MailStateMount>
      <ConsentMount>
        <PresentedMount>{children}</PresentedMount>
      </ConsentMount>
    </MailStateMount>
  );
}
const inputsSeen: ReturnType<typeof useWritingInputs>[] = [];
function ReadsTheInputs(): ReactNode {
  inputsSeen.push(useWritingInputs());
  const [, again] = useState(0);
  renderAgain = () => again((n) => n + 1);
  return <output>the inputs</output>;
}
let renderAgain: () => void = () => undefined;

describe("what the mount hands the composer of a letter handed in", () => {
  it("the host's link is taken once and held under one identity over every render until it is seeded, then let go", async () => {
    inputsSeen.length = 0;
    const mail = links(linked("ben@example.invalid", "From a link"));
    const A = await account("acc-a", { linkIn: mail.door });
    const host: FrameHost = {
      ...A.host,
      features: {
        ...A.host.features,
        above: GroundWithNoComposer,
        places: { ...A.host.features.places, ohbox: { id: "ohbox", body: "inputs", rail: null, panes: { kind: "wide", Wide: ReadsTheInputs } } },
      },
    };
    await act(async () => {
      render(<Stood host={host} />);
    });
    await waitFor(() => inputsSeen.some((i) => i.composer.mailtoDraft != null), "the link in the composer's inputs");
    for (let i = 0; i < 3; i += 1) await act(async () => renderAgain());
    const held = inputsSeen.map((i) => i.composer.mailtoDraft).filter((link) => link != null);
    expect(held.length, "renders that handed the link").toBeGreaterThan(2);
    expect(new Set(held).size, "the identities the one link was handed under").toBe(1);
    expect(held[0]).toEqual(linked("ben@example.invalid", "From a link"));
    expect(mail.door.take(), "the door was emptied by its one taker").toBeNull();
    /* The composer says it has seeded it: the mount lets it go. */
    await act(async () => inputsSeen.at(-1)!.composer.onMailtoDraftSeeded?.());
    expect(inputsSeen.at(-1)!.composer.mailtoDraft).toBeNull();
    /* The same door `go` names is one function for the frame's life: the composer keeps it in an effect's list. */
    expect(new Set(inputsSeen.map((i) => i.composer.go)).size).toBe(1);
  }, 60_000);
});

describe("the reply's open letter is the mount's own", () => {
  it("a change of place closes the reply and keeps its words; opened again, they are there", async () => {
    const A = await account("acc-a");
    await stand(A.host);
    await writeReply("AWORDS-REPLY kept");
    expect(now().writing.replyTo).toBe("m1");
    await go(() => now().commands.go({ place: "news" }));
    expect(now().route.place).toBe("news");
    expect(now().writing.replyTo, "the reply closed with the place it stood in").toBeNull();
    await go(() => now().commands.go({ place: "ohbox" }));
    expect(now().writing.replyTo, "coming back opens nothing by itself").toBeNull();
    await act(async () => now().composer.openReply("m1"));
    await rounds(6);
    expect(now().composer.replyBody.text).toBe("AWORDS-REPLY kept");
    expect(sends(A)).toEqual([]);
  }, 60_000);

  it("a reply draft opened where no letter is read walks to its letter, and its reply rides the walk", async () => {
    const draft = replyDraft("d-r", "m1", "Noon suits me.");
    const A = await account("acc-a", { at: "#/drafts", drafts: [draft] });
    await stand(A.host);
    expect(now().route.place).toBe("drafts");
    await act(async () => now().composer.openDraft(draft));
    await waitFor(() => A.address.read() === "#/ohbox/m/m1", "the letter's place, with the letter open");
    await waitFor(() => now().writing.replyTo === "m1", "the reply open after the walk");
    expect(now().composer.replyBody.text).toBe("Noon suits me.");
    expect(sends(A)).toEqual([]);
  }, 60_000);

  it("on one column an opened reply shows its letter; on two the address stays", async () => {
    const wideRoom = await account("acc-a");
    await stand(wideRoom.host);
    await act(async () => now().composer.openReply("m1"));
    await rounds(6);
    expect(wideRoom.address.read(), "two columns: the reply stands where the person is").toBe("#/ohbox");
    cleanup();
    resetComposerForTest();
    localStorage.clear();

    const narrow = await account("acc-a", { room: "phone" });
    await stand(narrow.host);
    await act(async () => now().composer.openReply("m1"));
    await waitFor(() => narrow.address.read() === "#/ohbox/m/m1", "the letter over the list");
    const writes = narrow.address.writes.length;
    /* The same reply opened again writes no second address: Back takes one press to leave the letter. */
    await act(async () => now().composer.openReply("m1"));
    await rounds(6);
    expect(narrow.address.writes.length).toBe(writes);
  }, 60_000);

  it("a send from a healthy connection leaves its editor at once, before the answer; the answer is applied where the person is", async () => {
    const A = await account("acc-a", { at: "#/compose" });
    await stand(A.host);
    await writeLetter("Plans for Friday", "Shall we meet at noon?");
    let release!: () => void;
    A.sendGate.wait = new Promise<void>((r) => {
      release = r;
    });
    await act(async () => now().composer.sendCompose());
    await waitFor(() => sends(A).length === 1, "the send on the wire");
    await waitFor(() => A.address.read() === "#/ohbox", "the Ohbox, while the send is still on its way");
    expect(now().composer.mailSend.stateOf("compose").phase, "the machine that sent, read at another place").toBe("sending");
    await act(async () => release());
    await waitFor(() => now().composer.mailSend.stateOf("compose").phase !== "sending", "the answer applied");
    await rounds(40);
    expect(sends(A), "one send left for one press").toHaveLength(1);
    expect(A.address.read(), "the answer walks nobody anywhere").toBe("#/ohbox");
  }, 60_000);

  it("Send + Done files the answered letter through the frame's one seam, and its Undo is the one z takes at another place", async () => {
    const A = await account("acc-a", { messages: [message("m1", { unread: true })] });
    await stand(A.host);
    await writeReply("AWORDS-REPLY and done");
    await act(async () => now().composer.pressSendAndDone("m1"));
    await waitFor(() => sends(A).length === 1, "the send on the wire");
    const after = (): EngineMutation[] => A.sent.slice(A.sent.findIndex((m) => m.kind === "mail_send") + 1);
    await waitFor(() => after().length > 0, "the letter filed Done, once its send was confirmed");
    expect(after()).toEqual([{ kind: "mark_seen", messageIds: ["m1"], unread: false }]);
    await go(() => now().commands.go({ place: "news" }));
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "z" });
    });
    await waitFor(() => after().length > 1, "the Done taken back by z, through the seam");
    expect(after().at(-1)).toEqual({ kind: "mark_seen", messageIds: ["m1"], unread: true });
    expect(sends(A), "taking Done back sends nothing again").toHaveLength(1);
  }, 60_000);

  it("Send + Done reads where a letter is presented, never its folder: a letter held at the gate is sent and nothing is filed", async () => {
    /* No rule names this sender: the presentation holds the letter at the gate, while the server's folder is INBOX. */
    const stranger = { address: "stranger@example.invalid", name: "A stranger" };
    const A = await account("acc-a", { messages: [message("m1", { unread: true, from: stranger } as never)] });
    await stand(A.host);
    await writeReply("AWORDS-REPLY to the gate");
    await act(async () => now().composer.pressSendAndDone("m1"));
    await waitFor(() => sends(A).length === 1, "the send on the wire");
    await waitFor(() => now().composer.replySendState("m1").phase !== "sending", "the send answered");
    await rounds(40);
    /* Today's plan is none there: an ordinary send, and no Done over a letter the Ohbox does not hold. */
    const after = A.sent.slice(A.sent.findIndex((m) => m.kind === "mail_send") + 1);
    expect(after, "a Done filed over a letter held at the gate").toEqual([]);
    expect(sends(A), "one send for one press").toHaveLength(1);
  }, 60_000);

  it("a reply whose send waits on the outbox is not offered as a held reply: its placeholder is no draft", async () => {
    const A = await account("acc-a", { offline: true });
    await stand(A.host);
    await writeReply("AWORDS-REPLY sent offline");
    await act(async () => now().composer.sendReply("m1"));
    /* The engine paints the waiting send as a row of its own: the placeholder, with no row of the account behind it. */
    await waitFor(
      () => A.engine.waitingSends().some((w) => w.paintId !== null && w.draftId === null),
      "the waiting send's placeholder",
    );
    await rounds(6);
    expect(now().writing.heldReplyRow("m1"), "the placeholder offered as a held reply").toBeNull();
    expect(now().composer.notSentRows.size, "the placeholder said as not sent").toBe(0);
  }, 60_000);

  it("a reply sent while every change waits on the outbox holds the restart: the update notice offers no Restart and says it waits for the letter, until the letter has left", async () => {
    const A = await account("acc-a", { offline: true });
    await stand(A.host);
    await writeReply("AWORDS-REPLY sent offline");
    await act(async () => now().composer.sendReply("m1"));
    await waitFor(() => restartHold() === "send", "the restart held while the letter waits");
    await act(async () => announceUpdate({ kind: "ready", version: "2.0.1", act: () => undefined } as UpdateOffer));
    await rounds(4);
    const restart = (): HTMLElement | null => document.querySelector<HTMLElement>(`button[aria-label="${en.update.lineRestart}"]`)
      ?? [...document.querySelectorAll<HTMLElement>("button")].find((b) => (b.textContent ?? "").trim() === en.update.lineRestart) ?? null;
    expect(restart(), "Restart offered while the letter waits").toBeNull();
    expect(document.body.textContent, "the update notice says it waits for the letter").toContain(en.update.lineAfterSend);
    /* The signal is back: the letter leaves, and the hold with it. */
    A.offline.on = false;
    await act(async () => void window.dispatchEvent(new Event("online")));
    await waitFor(() => sends(A).length === 1, "the letter on the wire");
    await waitFor(() => restartHold() === null, "the restart no longer held");
    await waitFor(() => restart() !== null, "Restart offered again");
  }, 60_000);

  it("a letter that did not leave is said in the notices: whom it was for, that it was not sent, and its way back to every word", async () => {
    const A = await account("acc-a", { refusesSend: true });
    await stand(A.host);
    await writeLetter("AWORDS-SUBJECT", "AWORDS-LETTER refused");
    await act(async () => now().composer.sendCompose());
    const notice = (): HTMLElement | undefined =>
      [...document.querySelectorAll<HTMLElement>('[role="status"]')].find((el) =>
        (el.textContent ?? "").includes("AWORDS-SUBJECT"),
      );
    await waitFor(() => notice() !== undefined && (notice()!.textContent ?? "").includes(en.compose.statusFailed), "the notice of the letter that did not leave");
    expect(sends(A), "one send for one press").toHaveLength(1);
    /* Its way back: the letter, with every word, in the composer. */
    await go(() => now().commands.go({ place: "ohbox" }));
    expect(A.address.read(), "at the Ohbox, away from the letter").toBe("#/ohbox");
    await act(async () => void fireEvent.click(within(notice()!).getByRole("button", { name: en.sendingLine.open })));
    await waitFor(() => A.address.read().startsWith("#/compose"), "Open leads back to the letter");
    await rounds(6);
    expect(notice(), "the ending leaves the notices once its letter is open").toBeUndefined();
    expect(now().composer.compose.body, "the words of the letter that did not go").toBe("AWORDS-LETTER refused");
    expect(now().composer.compose.subject).toBe("AWORDS-SUBJECT");
  }, 60_000);

  it("a reply sent and left that is refused is said by the frame's report, with its way back, and its words are kept", async () => {
    const A = await account("acc-a", { refusesSend: true });
    await stand(A.host);
    let release!: () => void;
    A.sendGate.wait = new Promise<void>((r) => {
      release = r;
    });
    await writeReply("AWORDS-REPLY refused");
    await act(async () => now().composer.sendReply("m1"));
    await waitFor(() => now().composer.replySendState("m1").phase === "sending", "the reply's send on its way");
    /* The person walks on before the answer: the reply closes, and its ending is said where no reply shows it. */
    await go(() => now().commands.go({ place: "news" }));
    expect(now().writing.replyTo).toBeNull();
    await act(async () => release());
    const said = (): HTMLElement | undefined =>
      [...document.querySelectorAll<HTMLElement>('[role="status"]')].find((el) =>
        (el.textContent ?? "").includes(en.reply.statusFailed),
      );
    await waitFor(() => said() !== undefined, "the frame's report of the refusal");
    expect(within(said()!).getByRole("button", { name: en.reply.notSentOpen }), "the report's way back").toBeTruthy();
    expect(sends(A), "one send for one press").toHaveLength(1);
    await act(async () => now().composer.openReply("m1"));
    await rounds(6);
    expect(now().composer.replyBody.text, "the words of the reply that did not go").toBe("AWORDS-REPLY refused");
  }, 60_000);

  it("a send that clears the form leaves for the Ohbox with no letter open, in one move", async () => {
    const A = await account("acc-a", { at: "#/compose" });
    await stand(A.host);
    await writeLetter("Plans for Friday", "Shall we meet at noon?");
    const writes = A.address.writes.length;
    await act(async () => now().composer.sendCompose());
    await waitFor(() => sends(A).length === 1, "the send on the wire");
    await waitFor(() => A.address.read() === "#/ohbox", "the Ohbox, after the form cleared", 400);
    expect(A.address.writes.slice(writes), "one move, and it names no letter").toEqual([{ next: "#/ohbox", how: "push" }]);
    expect(sends(A)).toHaveLength(1);
    expect(now().composer.compose.body).toBe("");
  }, 60_000);
});
