/** @vitest-environment jsdom */
/**
 * WRITE, REGISTERED ON THE MAIL GROUND: the places every host hands (`mailPlaces()`: the Ohbox and the place that
 * writes) over the real frame and the ground's one composer, on a real engine. The place `write` stands at its
 * address with the letter's fields; a reply that settled is the Ohbox's to read (its letter read, its row under
 * Earlier), from the one composer the ground stands and nothing the case hands by hand.
 */
import { MutationRejectedError } from "@ohmail/client-engine";
import type { EngineDraft, EngineMutation } from "@ohmail/wire";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposer } from "@ohmail/app-logic/writing/composer-record";
import { resetComposerForTest } from "@ohmail/app-logic/writing/compose";
import { COMPOSE_SEND_KEY } from "@ohmail/app-logic/writing/mail-send";
import { claimSendLock, SEND_LOCK_FORMAT, sendRecordsNaming } from "@ohmail/app-logic/writing/send-lock";
import type { ShellCompose } from "@ohmail/app-logic/writing/shell-compose";
import { Frame } from "@ohmail/app/frame";
import { NONE, type ReaderEntry } from "@ohmail/app/host";
import { MailGround, mailPlaces } from "@ohmail/app/mail";
import { TextProvider, type Messages } from "@ohmail/app/text";
import { fakeHost } from "../../../../packages/app/test/support/fake-host.js";
import { fakeAddress, fakeWindow } from "../../../../packages/app/test/support/fake-window.js";
import en from "../../messages/en.json";
import { engineOver, message, replyDraft, ROSTER, storeWith, stubDom, waitFor } from "../_draft-shell.js";

const WORDS = en as unknown as Messages;
const READER: ReaderEntry = { Reading: () => <output>the reading column</output>, Actions: () => null };

/** The one composer as the ground stands it, read beside the places (never handed to them). */
let composer: ShellCompose | null = null;
function ReadsTheComposer(): null {
  composer = useComposer();
  return null;
}
function GroundAndAReader({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <MailGround>
      <ReadsTheComposer />
      {children}
    </MailGround>
  );
}
const theComposer = (): ShellCompose => {
  if (composer === null) throw new Error("no composer stands on the ground");
  return composer;
};

async function stand(
  at: string,
  drafts: EngineDraft[] = [],
  scope = "acc-a",
  saveWait: Promise<void> | null = null,
  address = fakeAddress(at),
) {
  const sent: EngineMutation[] = [];
  const store = await storeWith([message("m1", { unread: true }), message("m2", { unread: true })], drafts);
  const engine = engineOver(store, sent, { on: false }, { wait: saveWait });
  const { host } = fakeHost({
    engine,
    service: "managed",
    scope,
    places: mailPlaces(),
    reader: READER,
    above: GroundAndAReader,
    mailboxes: async () => ROSTER,
    window: fakeWindow("desktop"),
    address,
  });
  const draw = (activeEngine = engine) => (
    <TextProvider locale="en" messages={WORDS} timeZone="UTC">
      <Frame host={{ ...host, engine: activeEngine }} />
    </TextProvider>
  );
  let mounted!: ReturnType<typeof render>;
  await act(async () => { mounted = render(draw()); });
  return { sent, engine, address, replaceEngine: (replacement: typeof engine) => mounted.rerender(draw(replacement)) };
}
const rounds = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i += 1) await act(async () => new Promise((r) => setTimeout(r, 5)));
};
function parkAttempt(scope: string, draftId: string, key: string): void {
  claimSendLock({
    v: SEND_LOCK_FORMAT, lane: COMPOSE_SEND_KEY, key, fp: key, at: Date.now(),
    draftId, subject: `draft:${draftId}`, unverified: true,
  }, () => false, scope);
}
/** The letters under one of the Ohbox's groups, by their ids. */
const group = (name: string): string[] =>
  screen
    .queryAllByRole("listbox", { name })
    .flatMap((box) => within(box).queryAllByRole("option").map((row) => /Subject (m\d)/.exec(row.getAttribute("aria-label") ?? "")?.[1] ?? "?"));

beforeEach(() => {
  localStorage.clear();
  stubDom();
  composer = null;
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
});
afterEach(() => {
  cleanup();
  resetComposerForTest();
  vi.restoreAllMocks();
});

describe("the place that writes, registered for every host", () => {
  it("stands at its address with the letter's fields, over the ground's one composer", async () => {
    await stand("#/compose");
    await waitFor(() => screen.queryByRole("textbox", { name: en.compose.subject }) !== null, "the letter's subject");
    expect(theComposer().compose.subject, "the composer the place writes in").toBe("");
  });

  it("opens a saved letter from Drafts in Write, with the same drafts alongside it", async () => {
    const row = { ...replyDraft("kept", "other", "Words from yesterday"), inReplyToMessageId: null, subject: "Weekend plans" };
    const { sent } = await stand("#/drafts", [row]);
    const item = await screen.findByRole("option", { name: /Weekend plans/ });
    fireEvent.click(item);
    await waitFor(() => theComposer().compose.subject === row.subject, "the saved subject opens");
    expect((await screen.findByRole("textbox", { name: en.compose.subject }) as HTMLInputElement).value).toBe(row.subject);
    expect(screen.getByRole("option", { name: /Weekend plans/ })).toBeTruthy();
    expect(sent.filter((mutation) => mutation.kind === "mail_send")).toHaveLength(0);
  });

  it("keeps the new letter in Drafts and saves edits to that same row", async () => {
    const { sent, engine } = await stand("#/compose");
    const subject = await screen.findByRole("textbox", { name: en.compose.subject });
    fireEvent.change(subject, { target: { value: "Trip notes" } });
    const drafts = () => within(screen.getByRole("navigation", { name: /places/i })).getByRole("button", { name: /^Drafts/ });
    expect(within(drafts()).queryByText(/^\d+$/)).toBeNull();
    fireEvent.click(drafts());
    await waitFor(() => engine.store.list<EngineDraft>("draft").some(row => row.subject === "Trip notes"), "the new letter is saved");
    const saved = await screen.findByRole("option", { name: /Trip notes/ });
    expect(within(drafts()).getByText("1")).toBeTruthy();
    fireEvent.click(saved);
    const reopened = await screen.findByRole("textbox", { name: en.compose.subject });
    fireEvent.change(reopened, { target: { value: "Edited trip notes" } });
    fireEvent.click(drafts());
    expect(await screen.findByRole("option", { name: /Edited trip notes/ })).toBeTruthy();
    expect(screen.getAllByRole("option", { name: /trip notes/i })).toHaveLength(1);
    expect(sent.filter(m => m.kind === "draft_save" && !m.draftId)).toHaveLength(1);
    expect(sent.filter(m => m.kind === "mail_send")).toHaveLength(0);
  });

  it("cancels an appointment before opening its letter for editing", async () => {
    const row: EngineDraft = {
      ...replyDraft("later", "elsewhere", "Keep the words"), inReplyToMessageId: null,
      subject: "Later letter", status: "scheduled", sendAt: "2031-12-12T12:00:00.000Z",
    };
    const { sent } = await stand("#/drafts", [row]);
    const scheduled = await screen.findByRole("listbox", { name: en.drafts.scheduledTitle });
    fireEvent.click(within(scheduled).getByRole("option", { name: /Later letter/ }));
    await waitFor(() => theComposer().compose.subject === row.subject, "cancelled and reopened");
    expect(sent.filter(m => m.kind === "draft_schedule_cancel")).toEqual([{ kind: "draft_schedule_cancel", draftId: row.id }]);
    expect(sent.filter(m => m.kind === "mail_send")).toHaveLength(0);
  });

  it("opens an uncertain send at its two recovery actions without resending it", async () => {
    const row: EngineDraft = { ...replyDraft("held", "m1", "Only copy"), status: "unverified", subject: "Uncertain letter" };
    const { sent, address } = await stand("#/drafts", [row]);
    fireEvent.click(await screen.findByRole("option", { name: /Uncertain letter/ }));
    expect(await screen.findByRole("button", { name: en.drafts.sendAgain })).toBeTruthy();
    expect(screen.getByRole("button", { name: en.drafts.heldItWasSent })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: en.compose.subject })).toBeNull();
    expect(address.read()).toBe("#/drafts/m/held");
    await act(async () => address.visit("#/drafts"));
    expect(screen.queryByRole("button", { name: en.drafts.sendAgain })).toBeNull();
    await act(async () => address.visit("#/drafts/m/held"));
    expect(await screen.findByRole("button", { name: en.drafts.heldItWasSent })).toBeTruthy();
    expect(sent.filter(m => m.kind === "mail_send" || m.kind === "draft_resolve")).toHaveLength(0);
  });

  it.each(["arrived", "not_arrived"] as const)("records the selected answer %s for a held send without resending it", async (outcome) => {
    const row: EngineDraft = { ...replyDraft("held", "elsewhere", "The held words"), inReplyToMessageId: null, status: "unverified", subject: "Held letter" };
    const { sent, engine } = await stand("#/drafts/m/held", [row]);
    const label = outcome === "arrived" ? en.drafts.heldItWasSent : en.drafts.sendAgain;
    fireEvent.click(await screen.findByRole("button", { name: label }));
    await waitFor(() => engine.store.get<EngineDraft>("draft", row.id)?.status === (outcome === "arrived" ? "sent" : "draft"), "the account confirmed the selected answer");
    if (outcome === "arrived") {
      expect(screen.queryByRole("option", { name: /Held letter/ })).toBeNull();
      expect(screen.queryByRole("textbox", { name: en.compose.subject })).toBeNull();
    } else {
      await waitFor(() => theComposer().compose.subject === row.subject, "the confirmed draft opened in Write");
      expect(theComposer().compose.body).toBe("The held words");
    }
    expect(sent.filter(m => m.kind === "draft_resolve" || m.kind === "mail_send")).toEqual([
      { kind: "draft_resolve", draftId: row.id, outcome, ifUpdatedAt: row.updatedAt },
    ]);
  });

  it("releases a later unconfirmed send when the same draft is resolved again", async () => {
    const scope = "acc-a";
    const row: EngineDraft = {
      ...replyDraft("held", "elsewhere", "Same draft, another attempt"),
      inReplyToMessageId: null, status: "unverified", subject: "Held twice",
    };
    const records = () => sendRecordsNaming(COMPOSE_SEND_KEY, row.id, null, scope).map(record => record.key);
    parkAttempt(scope, row.id, "first-attempt");
    const { sent, engine, address } = await stand("#/drafts/m/held", [row], scope);
    await act(async () => { await engine.start(); });
    expect(engine.outboxKnown()).toBe(true);
    const results: string[] = [];
    const mutate = engine.mutate.bind(engine);
    vi.spyOn(engine, "mutate").mockImplementation(async (mutation, options) => {
      const result = await mutate(mutation, options);
      if (mutation.kind === "draft_resolve") results.push(result.status);
      return result;
    });
    const answer = async (count: number): Promise<void> => {
      fireEvent.click(await screen.findByRole("button", { name: en.drafts.sendAgain }));
      await waitFor(() => results.length === count, "the server answers for the named attempt");
      expect(results).toEqual(Array(count).fill("confirmed"));
      await rounds(2);
    };
    expect(records()).toEqual(["first-attempt"]);
    await answer(1);
    expect(records()).toEqual([]);

    parkAttempt(scope, row.id, "second-attempt");
    const updatedAt = new Date().toISOString();
    await act(async () => {
      await engine.store.applyChanges([{
        type: "draft", op: "update", id: row.id, seq: 100, updatedAt,
        entity: { ...row, updatedAt },
      }]);
      address.visit("#/drafts/m/held");
    });
    expect(records()).toEqual(["second-attempt"]);
    await answer(2);
    expect(records()).toEqual([]);
    expect(theComposer().compose.body).toBe(row.body);
    expect(sent.filter(m => m.kind === "draft_resolve" || m.kind === "mail_send")).toEqual([
      { kind: "draft_resolve", draftId: row.id, outcome: "not_arrived", ifUpdatedAt: row.updatedAt },
      { kind: "draft_resolve", draftId: row.id, outcome: "not_arrived", ifUpdatedAt: updatedAt },
    ]);
  });

  it("keeps a late answer with the account that pressed Send again", async () => {
    const firstScope = "acc-a";
    const nextScope = "acc-b";
    const firstRow: EngineDraft = {
      ...replyDraft("held", "elsewhere", "The first account's words"),
      inReplyToMessageId: null, status: "unverified", subject: "First account's draft",
    };
    const nextRow: EngineDraft = {
      ...firstRow, subject: "Second account's only draft", body: "Second account's words",
    };
    parkAttempt(firstScope, firstRow.id, "same-local-marker");
    parkAttempt(nextScope, nextRow.id, "same-local-marker");
    const first = await stand("#/drafts/m/held", [firstRow], firstScope);
    await act(async () => { await first.engine.start(); });

    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let confirmed = false;
    const mutate = first.engine.mutate.bind(first.engine);
    vi.spyOn(first.engine, "mutate").mockImplementation(async (mutation, options) => {
      const result = await mutate(mutation, options);
      if (mutation.kind === "draft_resolve") {
        confirmed = result.status === "confirmed";
        await waiting;
      }
      return result;
    });

    try {
      fireEvent.click(await screen.findByRole("button", { name: en.drafts.sendAgain }));
      await waitFor(() => confirmed, "the first account confirmed its draft resolution");
      cleanup();
      first.address.visit("#/ohbox");
      const next = await stand("#/ohbox", [nextRow], nextScope, null, first.address);

      await act(async () => { release(); });
      await waitFor(
        () => sendRecordsNaming(COMPOSE_SEND_KEY, firstRow.id, null, firstScope).length === 0,
        "the first account released its confirmed send record",
      );
      expect(next.address.read()).toBe("#/ohbox");
      expect(theComposer().compose.subject).not.toBe(firstRow.subject);
      expect(next.sent.filter(mutation => mutation.kind === "draft_resolve" || mutation.kind === "mail_send")).toEqual([]);
      expect(sendRecordsNaming(COMPOSE_SEND_KEY, nextRow.id, null, nextScope).map(record => record.key)).toEqual([
        "same-local-marker",
      ]);
    } finally {
      release();
    }
  });

  it("leaves the route alone when a held draft body arrives after replacing the engine", async () => {
    const scope = "acc-a";
    const row: EngineDraft = {
      ...replyDraft("held", "elsewhere", ""),
      inReplyToMessageId: null, status: "unverified", subject: "A held draft with a remote body", body: null,
    };
    parkAttempt(scope, row.id, "attempt-awaiting-body");
    const first = await stand("#/drafts/m/held", [row], scope);
    await act(async () => { await first.engine.start(); });
    let deliver!: (body: string) => void;
    const remoteBody = new Promise<string>((resolve) => { deliver = resolve; });
    const readBody = vi.spyOn(first.engine, "readDraftBody").mockReturnValue(remoteBody);

    try {
      fireEvent.click(await screen.findByRole("button", { name: en.drafts.sendAgain }));
      await waitFor(() => readBody.mock.calls.length > 0, "a confirmed draft asked for its missing body");
      const replacement = engineOver(await storeWith([message("m1")], []), [], { on: false }, { wait: null });
      await act(async () => {
        first.replaceEngine(replacement);
        first.address.visit("#/ohbox");
      });

      await act(async () => { deliver("Words from the earlier engine"); });
      expect(first.address.read()).toBe("#/ohbox");
      expect(theComposer().compose.subject).not.toBe(row.subject);
      expect(sendRecordsNaming(COMPOSE_SEND_KEY, row.id, null, scope)).toEqual([]);
    } finally {
      deliver("");
    }
  });

  it("keeps the route when a recovered draft's prerequisite save finishes after switching accounts", async () => {
    const scope = "acc-a";
    const row: EngineDraft = {
      ...replyDraft("held", "elsewhere", "The recovered letter"),
      inReplyToMessageId: null, status: "unverified", subject: "First account's recovered draft",
    };
    parkAttempt(scope, row.id, "attempt-awaiting-recovery");
    let finishSave!: () => void;
    const saveBlocked = new Promise<void>((resolve) => { finishSave = resolve; });
    const first = await stand("#/drafts/m/held", [row], scope, saveBlocked);
    await act(async () => { await first.engine.start(); });

    try {
      await act(async () => {
        const writing = theComposer();
        writing.onComposeFields({ ...writing.compose, subject: "Different unsaved letter", body: "New unsaved words" });
      });
      expect(theComposer().compose.subject).toBe("Different unsaved letter");
      fireEvent.click(await screen.findByRole("button", { name: en.drafts.sendAgain }));
      await waitFor(
        () => first.sent.some(mutation => mutation.kind === "draft_save"),
        "the prerequisite save is held on the transport",
      );
      expect(first.sent.some(mutation => mutation.kind === "draft_resolve")).toBe(true);
      cleanup();
      first.address.visit("#/ohbox");
      const next = await stand("#/ohbox", [], "acc-b", null, first.address);

      await act(async () => { finishSave(); });
      await rounds(8);
      expect(next.address.read()).toBe("#/ohbox");
      expect(theComposer().compose.subject).not.toBe(row.subject);
      expect(next.sent.filter(mutation => mutation.kind === "draft_resolve" || mutation.kind === "mail_send")).toEqual([]);
      expect(sendRecordsNaming(COMPOSE_SEND_KEY, row.id, null, scope)).toEqual([]);
    } finally {
      finishSave();
    }
  });

  it("a late confirmation leaves an attempt made after the answer was pressed", async () => {
    const scope = "acc-a";
    const row: EngineDraft = { ...replyDraft("held", "elsewhere", "Held words"), status: "unverified", subject: "Held reply" };
    parkAttempt(scope, row.id, "old-attempt");
    const { sent, engine } = await stand("#/drafts/m/held", [row], scope);
    await act(async () => { await engine.start(); });
    expect(engine.outboxKnown()).toBe(true);
    const records = () => sendRecordsNaming(COMPOSE_SEND_KEY, row.id, null, scope).map(record => record.key);

    let answer!: () => void;
    const onWire = new Promise<void>(resolve => { answer = resolve; });
    const mutate = engine.mutate.bind(engine);
    let answering = false;
    vi.spyOn(engine, "mutate").mockImplementation(async (mutation, options) => {
      if (mutation.kind === "draft_resolve") {
        answering = true;
        await onWire;
      }
      return mutate(mutation, options);
    });
    try {
      fireEvent.click(await screen.findByRole("button", { name: en.drafts.heldItWasSent }));
      await waitFor(() => answering, "the answer is waiting on the first attempt");
      parkAttempt(scope, row.id, "new-attempt");
      expect(records().sort()).toEqual(["new-attempt", "old-attempt"]);
      await act(async () => { answer(); });
      await waitFor(() => !records().includes("old-attempt"), "the answer releases its original record");
      expect(records()).toEqual(["new-attempt"]);
      expect(sent.filter(m => m.kind === "draft_resolve" || m.kind === "mail_send")).toEqual([
        { kind: "draft_resolve", draftId: row.id, outcome: "arrived", ifUpdatedAt: row.updatedAt },
      ]);
    } finally {
      answer();
    }
  });

  it("restores a discarded draft with Undo before any delete reaches the transport", async () => {
    const row = { ...replyDraft("kept", "elsewhere", "Keep these words"), inReplyToMessageId: null, subject: "Can undo" };
    const { sent } = await stand("#/drafts", [row]);
    await screen.findByRole("option", { name: /Can undo/ });
    fireEvent.click(screen.getByRole("button", { name: en.drafts.discard }));
    await waitFor(() => screen.queryByRole("option", { name: /Can undo/ }) === null, "removed during Undo");
    fireEvent.click(await screen.findByRole("button", { name: en.drafts.reportUndo }));
    fireEvent.click(await screen.findByRole("option", { name: /Can undo/ }));
    await waitFor(() => theComposer().compose.subject === row.subject, "recovered the same draft");
    expect(sent.filter(m => m.kind === "draft_discard" || m.kind === "mail_send")).toHaveLength(0);
  });

  it.each(["confirmed", "offline", "refused"] as const)("settles a discard when an unowned first save ends %s", async (ending) => {
    let release!: () => void;
    let fail!: (reason: Error) => void;
    const gate = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
    const { engine, sent } = await stand("#/drafts", [], "acc-a", gate);
    const save = engine.mutate({
      kind: "draft_save", draftId: null, mailboxId: "mb1", subject: "A first save", body: "Words",
      threadId: null, inReplyToMessageId: null, to: [], cc: [], bcc: [],
    });
    try {
      await waitFor(() => sent.some(m => m.kind === "draft_save"), "the first save reached transport");
      const row = engine.read().list<EngineDraft>("draft").find(d => d.pendingCreate);
      if (!row) throw new Error("the first save has no local row");
      const discard = theComposer().discardDraftRow(row.id, row);
      await act(async () => {
        if (ending === "confirmed") release();
        else if (ending === "offline") fail(new MutationRejectedError("offline", { code: "network", retryable: true }));
        else fail(new MutationRejectedError("save refused", { code: "validation_failed", retryable: false }));
        await save;
      });
      const outcome = await discard;
      const deletes = sent.filter(m => m.kind === "draft_discard");
      if (ending === "confirmed") {
        expect(outcome.kind).toBe("applied");
        expect(deletes).toHaveLength(1);
        expect(deletes[0]!.draftId).not.toBe(row.id);
        expect(engine.store.list<EngineDraft>("draft").some(d => d.subject === "A first save")).toBe(false);
      } else {
        expect(outcome.kind).toBe("refused");
        expect(deletes).toHaveLength(0);
        expect(engine.read().list<EngineDraft>("draft").some(d => d.subject === "A first save")).toBe(ending === "offline");
      }
    } finally {
      release();
      await save;
    }
    expect(sent.filter(m => m.kind === "mail_send")).toHaveLength(0);
  });

  it("keeps another account's letter separate after opening a draft", async () => {
    const row = { ...replyDraft("same-id", "elsewhere", "First account's words"), inReplyToMessageId: null, subject: "First letter" };
    await stand("#/drafts", [row]);
    fireEvent.click(await screen.findByRole("option", { name: /First letter/ }));
    await waitFor(() => theComposer().compose.subject === row.subject, "first letter opened");
    cleanup();
    const second = { ...row, body: "Second account's words", subject: "Second letter" };
    const { sent } = await stand("#/drafts", [second], "acc-b");
    expect(screen.queryByText(row.subject)).toBeNull();
    fireEvent.click(await screen.findByRole("option", { name: /Second letter/ }));
    await waitFor(() => theComposer().compose.subject === second.subject, "second account's letter");
    expect(sent.filter(m => m.kind === "draft_save" && m.subject === row.subject)).toHaveLength(0);
  });

  it("a reply that settled is the Ohbox's: its letter is read and its row files under Earlier", async () => {
    const { sent } = await stand("#/ohbox");
    await waitFor(() => group("New").includes("m1"), "the letter waits in New");
    await act(async () => theComposer().openReply("m1"));
    await rounds(4);
    await act(async () => theComposer().onReplyBody({ text: "Noon works.", html: "" }));
    await act(async () => theComposer().sendReply("m1"));
    await waitFor(() => sent.some((m) => m.kind === "mail_send"), "the reply sent");
    await waitFor(() => group("Earlier").includes("m1"), "the answered letter under Earlier");
    expect(group("New"), "and no longer in New").not.toContain("m1");
  }, 30_000);
});
