/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { OhmailEngine, type EngineAdapter, type EngineDraft, type EngineMutation } from "@ohmail/client-engine";
import { DRAFT_BODY_MAX_BYTES } from "@trafficflow/core/outbound-text";
import {
  useComposeAutosave, worthSaving, reopenWouldOverwrite, draftNoteKey, AUTOSAVE_DELAY_MS,
} from "../app/shell/compose-autosave";
import {
  EMPTY_COMPOSE, composePlan, composeRowKey, composeSessionKey, type ComposeFields,
} from "../app/shell/compose";
import { claimSendLock, sendLocksKey, type SendLock } from "../app/shell/send-lock";
/* The census below reads the shell AS SOURCE and has to find one declaration in it. The rule,
   and what a hook spelling costs, are written out in the helper. */
import { shellFrameOf, sliceOfDeclaration } from "./source-anchor.js";
/** No send is owed an ending in these jar-only cases — the shape every deletion had before keys could be owed. */
const NONE_OWED = (): boolean => false;

/**
 * ═══ ONE DRAFT ROW, FROM THE FIRST KEYSTROKE TO DELIVERY ═════════════════════════════════
 *
 * The compose form autosaves to a real `drafts` row on the account. Everything that can go wrong
 * with that goes wrong in the same direction — MORE ROWS THAN MESSAGES — and each one is silent
 * on the surface that caused it while the Drafts list fills with debris:
 *
 *   · a create on every debounce, because the server's id was never adopted;
 *   · a create on every render, because the effect did not ask whether anything had changed;
 *   · a second row at Send, because the send path did its own `POST /drafts`;
 *   · a row for merely visiting Compose, because a sender pick counted as a draft.
 *
 * So the assertions below are mostly COUNTS OF WIRE CALLS, taken from a recording adapter rather
 * than from the mirror: the mirror converges either way and would show one tidy row while three
 * had been written. What is under test is what the account is asked to store.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/** Every mutation the engine dispatched, in order. */
let sent: EngineMutation[];
/** Server ids, minted in order, so an adopted id is distinguishable from a client-local one. */
let minted: number;
let seq: number;

/**
 * A recording adapter that ECHOES, and the echo is not decoration: a `MutationOutcome` with no
 * `changes` sends `Engine.dispatch` down its authoritative-drain path (`syncFresh`), which under
 * fake timers is a second async machine standing between the assertion and the thing being
 * asserted. Every real mutation this hook makes echoes anyway — `POST`/`PUT /drafts` return the
 * DTO and an `X-Sync-Seq` — so the echo is also what the live path does.
 */
function adapterWith(over: Partial<EngineAdapter> = {}): EngineAdapter {
  return {
    sync: async () => ({ changes: [], cursor: "1", hasMore: false }) as never,
    mutate: async (m: EngineMutation) => {
      sent.push(m);
      const n = ++seq;
      if (m.kind === "draft_save") {
        const id = m.draftId ?? `srv-${++minted}`;
        const entity = { id, mailboxId: "mb-1", status: "draft" } as unknown as Record<string, unknown>;
        return {
          changes: [{
            type: "draft", op: m.draftId === null ? "create" : "update", id, seq: n,
            updatedAt: "2026-08-07T00:00:00.000Z", entity,
          }] as never,
          seq: n,
          entityId: id,
        };
      }
      if (m.kind === "draft_discard") {
        return {
          changes: [{
            type: "draft", op: "delete", id: m.draftId, seq: n,
            updatedAt: "2026-08-07T00:00:00.000Z", entity: null,
          }] as never,
          seq: n,
        };
      }
      return { changes: [], seq: n };
    },
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    ...over,
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let seen: ReturnType<typeof useComposeAutosave>;

function Harness({ engine, fields, mailboxId, active, keepRowMailbox }: {
  engine: OhmailEngine;
  fields: ComposeFields;
  mailboxId: string | null;
  active: boolean;
  keepRowMailbox?: boolean;
}) {
  seen = useComposeAutosave({ engine, fields, mailboxId, active, keepRowMailbox });
  return null;
}

interface Opts { mailboxId?: string | null; active?: boolean; keepRowMailbox?: boolean }

/* `"mailboxId" in opts` and NOT `opts.mailboxId ?? "mb-1"` — `null` is the case under test (no
   mailbox to send from) and `??` treats it as "not supplied", which silently handed the test a
   mailbox and made the assertion about nothing. It failed that way first. */
const propsOf = (engine: OhmailEngine, fields: ComposeFields, opts: Opts) => ({
  engine,
  fields,
  mailboxId: "mailboxId" in opts ? (opts.mailboxId ?? null) : "mb-1",
  active: opts.active ?? true,
  keepRowMailbox: opts.keepRowMailbox ?? false,
});

async function mount(engine: OhmailEngine, fields: ComposeFields, opts: Opts = {}): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(h(Harness, propsOf(engine, fields, opts))));
}

async function rerender(engine: OhmailEngine, fields: ComposeFields, opts: Opts = {}): Promise<void> {
  await act(async () => root!.render(h(Harness, propsOf(engine, fields, opts))));
}

/** Run the debounce out and let every promise it started settle. */
async function settle(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS + 10);
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
  });
}

const typed = (over: Partial<ComposeFields> = {}): ComposeFields => ({
  ...EMPTY_COMPOSE, to: "sam@example.com", subject: "Friday", body: "Are we still on?", ...over,
});

/** The compose session a reload comes back to — the name a park holds a message by. */
const SESSION = "S-1";

/**
 * A SEND WHOSE OUTCOME NOBODY KNOWS, recorded durably — what a park IS.
 *
 * Written through `claimSendLock` rather than as raw JSON so the record has the shape this build
 * actually stores (`v` is stamped there, not by the caller); the session is seeded beside it
 * because that is the half that survives a reload whether or not a row does.
 */
function park(over: Partial<SendLock> = {}): void {
  window.localStorage.setItem(composeSessionKey(), SESSION);
  claimSendLock({
    v: 1, lane: "compose", key: "idem-1", at: Date.now(),
    draftId: "srv-1", subject: "draft:srv-1", session: SESSION, fp: "fp-1", unverified: true,
    ...over,
  }, NONE_OWED);
}

/** The jar's bytes, for "this reload changed nothing about the record". */
const jarBytes = (): string | null => window.localStorage.getItem(sendLocksKey());

beforeEach(() => {
  sent = [];
  minted = 0;
  seq = 0;
  // The row this surface holds is durable now (`composeRowKey`), and jsdom's storage outlives a
  // test — so without this a case adopts the previous case's row and measures nothing.
  window.localStorage.clear();
  vi.useFakeTimers();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

describe("what counts as a draft at all", () => {
  /**
   * MERELY VISITING COMPOSE WRITES NOTHING. `writeComposeDraft` makes the same judgement about
   * the local buffer and for a smaller version of the same reason — here the cost of getting it
   * wrong is a `drafts` row on the account for every visit to the form.
   *
   * Mutation: `return true` in `worthSaving`. Real failure text:
   *   AssertionError: opening Compose wrote a draft to the account: expected [ { …(9) } ] to
   *   have a length of +0 but got 1
   */
  it("an untouched form is not a draft, and neither is a sender pick on one", async () => {
    expect(worthSaving(EMPTY_COMPOSE)).toBe(false);
    expect(worthSaving({ ...EMPTY_COMPOSE, fromMailboxId: "mb-2" })).toBe(false);
    // …and `html`, which is never empty: an empty ProseMirror document serialises to `<p></p>`.
    expect(worthSaving({ ...EMPTY_COMPOSE, html: "<p></p>" })).toBe(false);
    expect(worthSaving({ ...EMPTY_COMPOSE, to: "sam@example.com" })).toBe(true);

    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, { ...EMPTY_COMPOSE, fromMailboxId: "mb-2" });
    await settle();
    expect(sent, "opening Compose wrote a draft to the account").toHaveLength(0);
  });

  /**
   * AND NOTHING IS WRITTEN UNTIL THE FORM HAS BEEN STILL. Two seconds is the debounce; a save
   * per keystroke is a write storm, which is the objection `compose.ts` raised against server
   * drafts in the first place.
   */
  it("nothing is written until the typing stops", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, typed());
    await act(async () => { vi.advanceTimersByTime(AUTOSAVE_DELAY_MS - 100); });
    expect(sent, "a keystroke reached the account before the pause was over").toHaveLength(0);
    await settle();
    expect(sent).toHaveLength(1);
  });
});

describe("one row, however long somebody types", () => {
  /**
   * ══ THE CENTRAL GUARD ══════════════════════════════════════════════════════════════════
   *
   * FIRST save creates; every later save UPDATES THE ROW THE FIRST ONE MADE. The server's id is
   * adopted from `MutationResult.entityId` — without it the hook has nothing to name the row by
   * and creates a new one every two seconds, which is a Drafts list with a row per pause in a
   * sentence.
   *
   * Mutation: drop `entityId` from the adapter's create branch in `http-adapter.ts` (or the
   * `if (draftId === null && result.entityId) setDraftId(...)` line here). Real failure text:
   *   AssertionError: a second row was created instead of updating the first: expected [ null,
   *   null, null ] to deeply equal [ null, 'srv-1', 'srv-1' ]
   */
  it("creates once and then updates the same row", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, typed());
    await settle();
    await rerender(engine, typed({ body: "Are we still on? Let me know." }));
    await settle();
    await rerender(engine, typed({ body: "Are we still on? Let me know.", subject: "Friday?" }));
    await settle();

    const ids = sent.map((m) => (m.kind === "draft_save" ? m.draftId : "not-a-save"));
    expect(ids, "a second row was created instead of updating the first")
      .toEqual([null, "srv-1", "srv-1"]);
    expect(seen.draftId).toBe("srv-1");
  });

  /**
   * A RE-RENDER IS NOT AN EDIT. The effect depends on `fields`, and `AppShell` rebuilds that
   * object for reasons that have nothing to do with typing — a sync drain, a theme change,
   * another pane. Without the signature check the account would be PUT the same text every two
   * seconds for as long as the form was open.
   *
   * Mutation: remove the `if (signature === saved.current) return;` line. Real failure text:
   *   AssertionError: an idle form kept writing itself to the account: expected 3 to be 1
   */
  it("a forward's kept files are saved with it once one was removed, and never as null", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, typed({ forwardOf: "m-orig", forwardParts: null }));
    await settle();
    const first = sent[0] as Extract<EngineMutation, { kind: "draft_save" }>;
    expect(first.forwardOfMessageId).toBe("m-orig");
    expect(first, "no screen may clear another device's choice").not.toHaveProperty("forwardParts");
    // A removal is an edit: it saves, and the row learns the list.
    await rerender(engine, typed({ forwardOf: "m-orig", forwardParts: ["p-1"] }));
    await settle();
    expect(sent).toHaveLength(2);
    expect((sent[1] as Extract<EngineMutation, { kind: "draft_save" }>).forwardParts).toEqual(["p-1"]);
  });

  it("an unchanged form writes nothing, however often it re-renders", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, typed());
    await settle();
    // Same VALUES, fresh objects — exactly what a parent re-render produces.
    await rerender(engine, typed());
    await settle();
    await rerender(engine, typed());
    await settle();
    expect(sent.length, "an idle form kept writing itself to the account").toBe(1);
  });

  /**
   * A CREATE WITH NOWHERE TO SEND FROM IS NOT ATTEMPTED. `drafts.mailboxId` is NOT NULL, so the
   * server would answer 400 — and the From line is already saying there is nothing to send from,
   * so a refusal here would be a second, worse way of saying it.
   */
  it("waits for a mailbox before creating anything", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, typed(), { mailboxId: null });
    await settle();
    expect(sent, "a draft was created with no mailbox to send it from").toHaveLength(0);

    await rerender(engine, typed(), { mailboxId: "mb-1" });
    await settle();
    expect(sent).toHaveLength(1);
  });

  /**
   * LEAVING COMPOSE DISARMS THE TIMER. Without it a save armed by the last keystroke fires after
   * the form has been cleared by a send, writing the delivered message back as a fresh draft.
   *
   * Mutation: remove the `if (!active) return;` line. Real failure text:
   *   AssertionError: a draft was written after the user left Compose: expected 1 to be +0
   */
  it("a form nobody is looking at is not saved", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, typed(), { active: false });
    await settle();
    expect(sent.length, "a draft was written after the user left Compose").toBe(0);
  });
});

describe("send, adopt and discard", () => {
  /**
   * ══ THE SECOND HALF OF ONE-ROW-BIRTH-TO-SENT ══════════════════════════════════════════
   *
   * The plan's mutation carries the id autosave wrote, so the adapter sends THAT row instead of
   * doing its own `POST /drafts`. Asserted on the plan rather than by driving a send, because
   * the plan is where the two halves meet and a send would need a whole SMTP fake to say the
   * same thing.
   *
   * Mutation: drop the `...(draftId ? { draftId } : {})` line from `composePlan`. Real failure
   * text:
   *   AssertionError: Send would create a SECOND draft row beside the one autosave wrote:
   *   expected undefined to be 'srv-1'
   */
  it("Send reuses the row autosave wrote", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, typed());
    await settle();
    expect(seen.draftId).toBe("srv-1");

    const plan = composePlan(typed(), "mb-1", seen.draftId);
    expect(
      plan.mutation.draftId,
      "Send would create a SECOND draft row beside the one autosave wrote",
    ).toBe("srv-1");
    // …and a surface with no autosave behind it is unaffected: the adapter creates the row and
    // sends it, exactly as it did before any of this existed.
    expect(composePlan(typed(), "mb-1").mutation.draftId).toBeUndefined();
  });

  /**
   * OPENING A DRAFT ADOPTS ITS ROW AND WRITES NOTHING. Opening one and closing it again used to
   * be free and must stay free — a list you can browse should not rewrite what you looked at.
   *
   * Mutation: drop the `saved.current = signatureOf(f)` line from `adopt`. Real failure text:
   *   AssertionError: opening a draft rewrote it to the account: expected 1 to be +0
   */
  it("adopting a draft writes nothing until it is edited", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    /* The row has to EXIST IN THE MIRROR to be adopted — `mutationEffects` resolves an update
       against it and rejects an id it does not know, without going near the wire. So it is put
       there the way the real one gets there: written once, which is also what the Drafts list is
       built from. Then released, which is the state somebody is in when they open it from the
       list. Adopting a fabricated id would have made every assertion below pass for the wrong
       reason — it failed that way first, silently, with zero writes and a green `draftId`. */
    /* `fromMailboxId` is seeded because `openDraft` always seeds it from the row — an adopted
       form whose pick is empty while a resolved mailbox exists is a state the shell cannot
       produce, and the hook reads the pick as "which mailbox the account's row already has". */
    const opened = typed({ subject: "From the list", fromMailboxId: "mb-1" });
    await mount(engine, opened);
    await settle();
    expect(sent).toHaveLength(1);
    await act(async () => { seen.release(); });
    sent.length = 0;

    await act(async () => { seen.adopt("srv-1", opened); });
    await settle();
    expect(sent.length, "opening a draft rewrote it to the account").toBe(0);
    expect(seen.draftId).toBe("srv-1");

    // …and the first real edit UPDATES it rather than creating a twin.
    await rerender(engine, typed({ subject: "From the list", body: "now edited" }));
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.kind === "draft_save" && sent[0]!.draftId).toBe("srv-1");
  });

  /**
   * A FROM PICK AFTER THE FIRST SAVE RE-HOMES THE ROW. The row is born at the first pause,
   * under whatever the picker held then; without this write the pick lives only in this tab and
   * the row keeps the old identity — which is what another device reads, and what the send
   * dials if this tab never presses Send itself. The text is deliberately UNCHANGED here, so
   * what is under test is the mailbox reaching the wire on its own.
   *
   * Mutation: drop the mailbox term from the hook's changed-check (or `mailboxId` from the
   * update mutation) and the first assertion goes red — measured before the hook was changed.
   */
  it("a From pick after the first save re-homes the row", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, typed());
    await settle();
    expect(seen.draftId).toBe("srv-1");
    sent.length = 0;

    // The user picks the other identity. Nothing else changed.
    await rerender(engine, typed({ fromMailboxId: "mb-2" }), { mailboxId: "mb-2" });
    await settle();
    expect(sent, "the From pick never reached the row").toHaveLength(1);
    const put = sent[0]!;
    expect(put.kind === "draft_save" && put.draftId).toBe("srv-1");
    expect(put.kind === "draft_save" && put.mailboxId, "the update carried no mailboxId")
      .toBe("mb-2");

    // …and the same form, unchanged, writes nothing more.
    sent.length = 0;
    await rerender(engine, typed({ fromMailboxId: "mb-2" }), { mailboxId: "mb-2" });
    await settle();
    expect(sent, "an unchanged pick was re-written").toHaveLength(0);
  });

  /* A kept draft of a removed mailbox reopens on a SUBSTITUTE sender. Autosave
     must not move the row to it; only Send (or a pick) does. Mutation: ignore `keepRowMailbox`
     in the hook and the first update carries "mb-2". */
  it("a SUBSTITUTED sender never re-homes an existing row", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, typed());
    await settle();
    expect(seen.draftId).toBe("srv-1");
    sent.length = 0;

    await rerender(engine, typed({ body: "Are we still on? Yes." }), { mailboxId: "mb-2", keepRowMailbox: true });
    await settle();
    expect(sent, "the edit was not saved").toHaveLength(1);
    const put = sent[0]!;
    expect(put.kind === "draft_save" && put.draftId).toBe("srv-1");
    expect(put.kind === "draft_save" && "mailboxId" in put, "autosave moved the row to the substitute")
      .toBe(false);

    sent.length = 0;
    await rerender(engine, typed({ body: "Are we still on? Yes." }), { mailboxId: "mb-2", keepRowMailbox: true });
    await settle();
    expect(sent, "the substitute alone counted as a change").toHaveLength(0);
  });

  it("…but a CREATE under a substitute still carries it — there is no row to keep", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, typed(), { mailboxId: "mb-2", keepRowMailbox: true });
    await settle();
    const create = sent.find((m) => m.kind === "draft_save" && m.draftId === null);
    expect(create && create.kind === "draft_save" && create.mailboxId, "a create lost its sender").toBe("mb-2");
  });

  it("the shell passes the substitution to the hook", async () => {
    const { readFileSync } = await import("node:fs");
    const shell = readFileSync(`${process.cwd()}/apps/webapp/app/shell/shell-compose.ts`, "utf8");
    expect(shell).toContain("keepRowMailbox: composeFrom.substituted,");
  });

  /**
   * DISCARD DELETES THE ROW AND FORGETS IT. Forgetting matters as much as deleting: a hook still
   * holding the id would PUT a row that is gone on the next pause, and the reader would watch a
   * draft they discarded reappear.
   *
   * Mutation: drop the `release()` call from `discard`. Real failure text:
   *   AssertionError: the discarded row was written again after it was deleted: expected
   *   'draft_save' to be 'draft_discard'
   */
  it("discard deletes the row, and nothing writes to it afterwards", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, typed());
    await settle();
    expect(seen.draftId).toBe("srv-1");

    await act(async () => { await seen.discard(); });
    expect(sent[1]).toEqual({ kind: "draft_discard", draftId: "srv-1" });
    expect(seen.draftId).toBeNull();

    // The form still holds text, so the next pause saves — as a NEW draft, not as a write to the
    // row that was just deleted.
    await rerender(engine, typed({ body: "different" }));
    await settle();
    const last = sent[sent.length - 1]!;
    expect(last.kind, "the discarded row was written again after it was deleted")
      .toBe("draft_save");
    expect(last.kind === "draft_save" && last.draftId, "the deleted row was PUT again").toBeNull();
  });

  /**
   * AFTER A SEND THE ROW IS RELEASED AND NOT DELETED. `SendService` moves the row to `sent`,
   * which is what takes it out of the Drafts list; deleting it would destroy the account's
   * record of an outgoing message.
   */
  it("release forgets the row without deleting it", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, typed());
    await settle();
    await act(async () => { seen.release(); });
    expect(seen.draftId).toBeNull();
    expect(sent.filter((m) => m.kind === "draft_discard"), "a sent message's row was deleted")
      .toHaveLength(0);
  });
});

describe("the row survives the reload that loses this hook's state", () => {
  /** THE RELOAD: the component and its state are gone; the mirror and `localStorage` are not. */
  async function reload(engine: OhmailEngine, fields: ComposeFields): Promise<void> {
    if (root) await act(async () => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    sent.length = 0;
    await mount(engine, fields);
  }

  /**
   * ── THE ROW WAS THE HALF A RELOAD LOST, AND LOSING IT WAS A DUPLICATE DELIVERY ────────────
   *
   * The scratch buffer restores the message's TEXT after a reload and restored nothing about its
   * row, so the next pause CREATED one. That is a second row for one message on its own — but
   * the cost that made it a release blocker is upstream of the Drafts list: the durable send
   * record names the row the press carried, and a send that came back unverified was therefore
   * held against `d1` while the surface computed `d2`. The reviewed sequence — send from saved
   * draft, unverified, reload, autosave, press — delivered the message a second time.
   *
   * Mutation: delete the `writeComposeRow(result.entityId)` beside the create's `setDraftId`.
   * Real failure text: expected null to be 'srv-1'.
   */
  it("the row is written down and adopted on the next mount", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, typed());
    await settle();
    expect(seen.draftId, "the create\u0027s id was not adopted").toBe("srv-1");
    expect(
      window.localStorage.getItem(composeRowKey()),
      "the row was never written down, so a reload cannot know which message this is",
    ).toBe("srv-1");

    await reload(engine, typed());
    expect(
      seen.draftId,
      "the restored composer forgot the row it was holding — the next pause makes a second one",
    ).toBe("srv-1");

    await rerender(engine, typed({ body: "Are we still on? Say the word." }));
    await settle();
    const ids = sent.map((m) => (m.kind === "draft_save" ? m.draftId : "not-a-save"));
    expect(ids, "the pause after the reload created a SECOND row for one message").toEqual(["srv-1"]);
  });

  /**
   * ── IT ADOPTS ONLY WHAT THE MIRROR CALLS A DRAFT ──────────────────────────────────────────
   *
   * `adopt`\u0027s own rule, applied to an id nobody re-checked. Two refusals ride on it: an id the
   * mirror does not know resolves an update to no effects and the engine answers `not_found`
   * without going near the wire (a row another device deleted must not be resurrected by a PUT),
   * and a row past `draft` — `unverified`, or a stranded `sending` — is one the server refuses to
   * send under any key, so adopting it would point every PUT and the Send press at that refusal.
   *
   * Not adopting is safe rather than merely tolerable: the compose SESSION is what parks an
   * unresolved send, and it survives the reload whether or not a row does.
   *
   * Mutation: `if (row === null) { … }` in place of the `status !== "draft"` test — the stranded
   * row IS in the mirror, so a presence check passes and this case reddens.
   */
  it("a stored row the mirror calls unverified is HELD, and one it calls something else is dropped", async () => {
    // The echo puts the row in the mirror as `unverified` — SMTP threw and the Sent probe found
    // nothing, which is the state `SendService` refuses every further key on. Same adapter shape
    // as `adapterWith`\u0027s own save branch, one field different, so the case cannot pass by
    // accident on a row the mirror never held.
    const engine = new OhmailEngine({ adapter: adapterWith({
      mutate: async (m: EngineMutation) => {
        sent.push(m);
        const n = ++seq;
        if (m.kind !== "draft_save") return { changes: [], seq: n };
        const id = m.draftId ?? `srv-${++minted}`;
        return {
          changes: [{
            type: "draft", op: m.draftId === null ? "create" : "update", id, seq: n,
            updatedAt: "2026-08-07T00:00:00.000Z",
            entity: { id, mailboxId: "mb-1", status: "unverified" },
          }] as never,
          seq: n,
          entityId: id,
        };
      },
    }) });
    await mount(engine, typed());
    await settle();
    expect(seen.draftId, "the create\u0027s id was not adopted at all").toBe("srv-1");
    expect(window.localStorage.getItem(composeRowKey())).toBe("srv-1");

    await reload(engine, typed());
    expect(
      seen.draftId,
      "a row the server will not send from was adopted — every PUT and the Send press answer 409",
    ).toBeNull();
    /* ── AND IT IS NOT DROPPED EITHER, WHICH IS THE CORRECTION ────────────────────────────────
       This case used to assert the id was thrown away, on the reasoning that the compose SESSION
       parks such a message and the row is worth nothing. Measured live, twice, that reasoning was
       the duplicate: dropping the id let the next pause create a row for the same message, and the
       server's own `unverified` is the ONE witness for a row this browser never recorded — the row
       the send made for itself, whose id nothing here can name. So it is held. */
    expect(
      window.localStorage.getItem(composeRowKey()),
      "the row of a send the server could not confirm was thrown away — the next pause creates "
      + "another for the same message",
    ).toBe("srv-1");
    await rerender(engine, typed({ body: "Are we still on? Say the word." }));
    await settle();
    expect(sent, "the pause after the reload wrote for a message whose fate is unknown")
      .toHaveLength(0);
  });

  /**
   * ── THE OTHER HALF, AND IT MOVED WITH INVARIANT S(2) ────────────────────────────────────────
   *
   * A row in a status that is not `draft` used to be DROPPED unless the server's own `unverified`
   * mark was on it, on the reasoning that nothing about a `scheduled` or `sending` row says a send
   * may have gone out. That reasoning was wrong for one of them and the wrong one was reachable: a
   * stranded `sending` row is a send whose answer never arrived, and dropping it let the next
   * pause mint a fresh row for the very message most likely still in flight.
   *
   * `holdOf` therefore calls every non-`draft` status parked, so this row is KEPT and nothing is
   * written to it. The positive control — an ordinary `draft` row is adopted and written to — is
   * the case above this one and the two-row cases below it, so "hold every row forever" is not a
   * way to satisfy this file.
   *
   * Mutation: `row.status !== "draft"` → `row.status === "unverified"` in `holdOf`. Real failure
   * text: AssertionError: a row the server has moved past `draft` was thrown away — the next pause
   * mints another for the same message: expected null to be 'srv-1'
   */
  it("a stored row the mirror calls something else entirely is HELD, not dropped and not adopted", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith({
      mutate: async (m: EngineMutation) => {
        sent.push(m);
        const n = ++seq;
        if (m.kind !== "draft_save") return { changes: [], seq: n };
        const id = m.draftId ?? `srv-${++minted}`;
        return {
          changes: [{
            type: "draft", op: m.draftId === null ? "create" : "update", id, seq: n,
            updatedAt: "2026-08-07T00:00:00.000Z",
            entity: { id, mailboxId: "mb-1", status: "scheduled" },
          }] as never,
          seq: n,
          entityId: id,
        };
      },
    }) });
    await mount(engine, typed());
    await settle();
    expect(seen.draftId).toBe("srv-1");

    await reload(engine, typed());
    expect(seen.draftId, "a frozen row was adopted — every PUT would answer 409").toBeNull();
    expect(
      window.localStorage.getItem(composeRowKey()),
      "a row the server has moved past `draft` was thrown away — the next pause mints another "
        + "for the same message",
    ).toBe("srv-1");
    /* AND NOTHING IS WRITTEN FOR IT: the hold refuses the create as well as the adoption, which
       is the half a guard watching only writes TO the row could not see. */
    const before = sent.length;
    await rerender(engine, typed({ body: "Noch da?" }));
    await settle();
    expect(
      sent.slice(before),
      "the pause after the reload wrote for a message the server has moved past `draft`",
    ).toHaveLength(0);
  });

  it("an id the mirror cannot answer for is not adopted, not thrown away, and not doubled", async () => {
    /**
     * The two states `get` cannot tell apart: a row deleted somewhere else, and a mirror that has
     * simply not loaded yet. Neither is adopted — a PUT would resurrect the first — and neither is
     * dropped, because dropping on a miss is what a cold reload looks like and would defeat the
     * adoption on exactly the path it exists for.
     *
     * ── AND THE NEXT PAUSE NO LONGER CREATES A ROW OF ITS OWN ────────────────────────────────
     *
     * That was this case's last assertion and it was the reload duplicate: a row IS written down,
     * the adoption is correctly waiting, this hook therefore holds nothing, and the timer minted a
     * SECOND row for the message that row belongs to. `unknown` still admits a create with NOTHING
     * written down — a first compose in a browser that refuses storage must still reach the
     * account — so the refusal is scoped by `readComposeRow() !== null`.
     *
     * THE COST, NAMED: a row genuinely deleted on another device is indistinguishable from a cold
     * mirror, so a compose left holding that id writes nothing more until a door replaces the
     * message (every door does: the reopen, Write-to, a mail link, Cancel, a confirmed send). The
     * duplicate it prevents is the worse of the two and is reachable without leaving the tab.
     *
     * Mutation: `if (row === null || row === undefined) { adopted.current = true; return true; }`,
     * or drop the `readComposeRow() !== null && hold.kind === "unknown"` line.
     */
    const engine = new OhmailEngine({ adapter: adapterWith() });
    window.localStorage.setItem(composeRowKey(), "deleted-on-another-device");
    await mount(engine, typed());
    expect(
      seen.draftId,
      "an id the mirror does not know was adopted — the PUT would resurrect a deleted row",
    ).toBeNull();
    expect(
      window.localStorage.getItem(composeRowKey()),
      "an unanswered id was thrown away — on a cold reload that is the row being lost",
    ).toBe("deleted-on-another-device");
    await settle();
    const ids = sent.map((m) => (m.kind === "draft_save" ? m.draftId : "not-a-save"));
    expect(
      ids,
      "the pause after the reload minted a second row beside the one already written down",
    ).toEqual([]);
  });

  /**
   * ══ THE RELOAD HALF OF THE DUPLICATE DELIVERY ═════════════════════════════════════════════
   *
   * Measured live on the release candidate, recipient total 2, and it needs no reopen at all:
   * park a send from saved draft `d1`, reload the tab, and `#/drafts` listed TWO rows for the one
   * message before anybody touched anything. The mount dropped `d1` (the server had moved it past
   * `draft`) and the next pause minted `d2`; the surface then presented `d2` as the message, and
   * the one press it allowed delivered a second copy.
   *
   * The rule is the one `openDraft` already follows, from the same function: while this browser
   * holds an unresolved record for the message it came back to, this surface takes NO row —
   * the stored id is kept, nothing is adopted, and nothing is created. Not adopting matters as
   * much as not dropping: a PUT, or a Discard's DELETE, would go at a row the server may be
   * sending right now.
   *
   * The three cases above are the positive controls and they are unchanged: with no record, a
   * `draft` row is still adopted, a row past `draft` is still dropped, and a cold mirror is still
   * waited for.
   *
   * Mutation: delete `if (parkedHere(held)) return false;` from the adoption effect. Real failure
   * text:
   *   AssertionError: the row of a message we are still waiting on was thrown away — the next
   *   pause mints a second one: expected null to be 'srv-1'
   */
  it("a message we are still waiting on keeps its row, and the pause after the reload mints nothing", async () => {
    // The echo puts the row in the mirror as `unverified` — the state a send that threw and could
    // not be found in Sent leaves behind, and the one the live sequence was measured in.
    const engine = new OhmailEngine({ adapter: adapterWith({
      mutate: async (m: EngineMutation) => {
        sent.push(m);
        const n = ++seq;
        if (m.kind !== "draft_save") return { changes: [], seq: n };
        const id = m.draftId ?? `srv-${++minted}`;
        return {
          changes: [{
            type: "draft", op: m.draftId === null ? "create" : "update", id, seq: n,
            updatedAt: "2026-08-07T00:00:00.000Z",
            entity: { id, mailboxId: "mb-1", status: "unverified" },
          }] as never,
          seq: n,
          entityId: id,
        };
      },
    }) });
    await mount(engine, typed());
    await settle();
    expect(seen.draftId).toBe("srv-1");
    // …and THEN the send goes out and comes back unverified.
    park();
    const before = jarBytes();

    await reload(engine, typed());
    expect(
      window.localStorage.getItem(composeRowKey()),
      "the row of a message we are still waiting on was thrown away — the next pause mints a "
      + "second one",
    ).toBe("srv-1");
    expect(
      seen.draftId,
      "the parked row was adopted — a PUT, or a Discard, would go at a row that may be sending",
    ).toBeNull();

    await rerender(engine, typed({ body: "Are we still on? Say the word." }));
    await settle();
    expect(
      sent,
      "the pause after the reload wrote to the account for a message whose fate is unknown",
    ).toHaveLength(0);
    expect(jarBytes(), "the reload rewrote the record of an unresolved send").toBe(before);
  });

  /**
   * ── THE SAME, COLD, WHICH IS THE ONLY RELOAD THERE IS ─────────────────────────────────────
   *
   * On a real reload the mirror is EMPTY while this hook mounts. The park is decided from the
   * durable record and the session, not from the mirror, so it must hold in that window too —
   * otherwise the debounce (two seconds) fires first and mints the second row before the row it
   * would have been asked about has even arrived.
   *
   * Mutation: delete `if (draftId === null && parkedHere(readComposeRow())) return;` from the
   * save effect. Real failure text:
   *   AssertionError: a second row was minted while the mirror was still loading — the row it
   *   belongs to arrived moments later: expected [ { …(9) } ] to have a length of +0 but got 1
   */
  it("a cold mirror does not let the debounce mint a row for a parked message", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith({
      sync: async () => ({
        changes: {
          creates: [{
            type: "draft", id: "srv-1", op: "create", seq: 1,
            updatedAt: "2026-08-07T00:00:00.000Z",
            entity: { id: "srv-1", mailboxId: "mb-1", status: "unverified" },
          }],
          updates: [], moves: [], deletes: [],
        },
        cursor: "1", hasMore: false, serverTime: "2026-08-07T00:00:00.000Z",
      }) as never,
    }) });
    window.localStorage.setItem(composeRowKey(), "srv-1");
    park();

    await mount(engine, typed());
    await settle();
    expect(
      sent,
      "a second row was minted while the mirror was still loading — the row it belongs to "
      + "arrived moments later",
    ).toHaveLength(0);

    await act(async () => { await engine.start(); });
    expect(seen.draftId, "the parked row was adopted once the mirror answered").toBeNull();
    expect(
      window.localStorage.getItem(composeRowKey()),
      "the row was dropped once the mirror could name it, which is the same second row one "
      + "notification later",
    ).toBe("srv-1");
    await rerender(engine, typed({ body: "Are we still on? Any time." }));
    await settle();
    expect(sent, "the pause after the mirror loaded minted a row anyway").toHaveLength(0);
  });

  /**
   * ── A PARK CAN NAME NO ROW AT ALL ─────────────────────────────────────────────────────────
   *
   * A send pressed before the first save has no row to be named by: the record carries
   * `draftId: null` and `compose:<session>`, and the session is the only name it will ever have.
   * Reading the row alone would call that message new and mint one for it.
   *
   * AND THE POSITIVE HALF, in the same case, because a rule that only ever refuses would be
   * satisfied by refusing every compose in the account: the moment the session is re-minted — the
   * one line every door that replaces the form runs — the very next pause creates a row as it
   * always did.
   *
   * Mutation: `if (session !== null && r.session === session) return true;` deleted from
   * `parkedComposeMessage`. Real failure text:
   *   AssertionError: a row was minted for a message named only by its session — the record can
   *   no longer recognise it: expected [ { …(9) } ] to have a length of +0 but got 1
   */
  it("a park that names only the session mints nothing, and a re-minted session mints again", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    park({ draftId: null, subject: `compose:${SESSION}` });

    await mount(engine, typed());
    await settle();
    expect(
      sent,
      "a row was minted for a message named only by its session — the record can no longer "
      + "recognise it",
    ).toHaveLength(0);

    // THE DOOR: a different message replaces the form, so the session goes with it.
    const { clearComposeDraft } = await import("../app/shell/compose");
    clearComposeDraft();
    await rerender(engine, typed({ subject: "Something else" }));
    await settle();
    const ids = sent.map((m) => (m.kind === "draft_save" ? m.draftId : "not-a-save"));
    expect(
      ids,
      "the next message after the park was refused a row too — every later compose is unsaveable",
    ).toEqual([null]);
  });

  /**
   * ── THE SAVE THAT WAS ARMED WHEN THE PRESS WENT OUT DOES NOT LAND ─────────────────────────
   *
   * A send pressed before the first save has no row: the record is named `compose:<session>` and
   * nothing else. The save it beat is still ARMED — the timer was set two seconds before the
   * press — and it used to fire, creating a SECOND row for a message the server had already
   * parked under a row of its own. Measured live: four rows on the server for one message, two of
   * them listed in Drafts as ordinary drafts, and opening either of them was a way to send it
   * again.
   *
   * The armed save now asks at FIRE time whether the message is one this browser is waiting on,
   * so it does not land at all. Nothing is created, nothing is attached, and the record keeps the
   * only name that message has.
   *
   * Mutation: delete the `if (parkedHere(engine, readComposeRow())) return;` inside the timer
   * callback. Real failure text:
   *   AssertionError: the save armed before the press landed anyway, making a second row for a
   *   message the server has already parked: expected [ { kind: 'draft_save', …(7) } ] to have a
   *   length of +0 but got 1
   */
  it("the save armed before the press does not land once the press is unresolved", async () => {
    const { parkedComposeRecord } = await import("../app/shell/send-lock");
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, typed());
    /* THE PRESS LANDS INSIDE THE DEBOUNCE. The save effect has already armed its timer. */
    await act(async () => { vi.advanceTimersByTime(AUTOSAVE_DELAY_MS - 100); });
    park({ draftId: null, subject: `compose:${SESSION}` });
    await settle();

    expect(
      sent,
      "the save armed before the press landed anyway, making a second row for a message the "
      + "server has already parked",
    ).toHaveLength(0);
    expect(seen.draftId, "a row was adopted for a message whose send is unresolved").toBeNull();
    expect(
      window.localStorage.getItem(composeRowKey()),
      "a row was written down for a message the record names by its session alone",
    ).toBeNull();

    /* ── AND THE ROW THE SEND MADE FOR ITSELF ────────────────────────────────────────────────
       The press with no row makes the ADAPTER create one, server-side, and that is the row the
       server marks. The client is never told its id, so no record here can name it — the server's
       own mark is what parks it, and the send gate refuses while it is held. */
    const { canSend, heldRowUnverified } = await import("../app/shell/mail-send");
    const { holdOf } = await import("../app/shell/send-lock");
    const mirrorRows = [{ id: "A", status: "unverified" }, { id: "ordinary", status: "draft" }];
    const mirrorOf = { read: () => ({ get: (_t: string, id: string) => mirrorRows.find((r) => r.id === id) }) };
    const holdFor = (id: string): ReturnType<typeof holdOf> =>
      holdOf(mirrorOf as never, { lane: "compose", draftId: id, session: SESSION });
    const msg = {
      kind: "mail_send", inReplyTo: null, body: "Kommst du noch?", subject: "Bis Montag",
      to: [{ name: null, address: "lena@atelier.example" }], mailboxId: "mb-1",
    } as never;
    expect(
      parkedComposeRecord("compose", "A", null),
      "a record names the row the send made for itself — it cannot, the id never reached here",
    ).toBeNull();
    expect(
      canSend(heldRowUnverified({ phase: "idle" }, "A", holdFor("A"), SESSION), msg),
      "reopening the row the send made for itself is sendable — one press is a second copy",
    ).toBe(false);
    /* THE POSITIVE, in the same breath: an ordinary draft row nothing has parked still sends. */
    expect(
      /* WITH NO SESSION, so the ROW is the only thing that can park it: this control is about the
         status arm, and the record naming this compose's session parks every message it is asked
         about — correctly, and not what is under test here. */
      canSend(heldRowUnverified({ phase: "idle" }, "ordinary", holdOf(mirrorOf as never, {
        lane: "compose", draftId: "ordinary", session: null,
      }), null), msg),
      "an ordinary draft row is refused — every reopened draft in the account becomes unsendable",
    ).toBe(true);
  });

  /**
   * ══ THE PARKED MESSAGE POURED INTO THE PREVIOUS MESSAGE'S ROW ═════════════════════════════
   *
   * Measured live on the release candidate, recipient total 2, and the mechanism is not the one
   * the earlier cases guard. The door that opens a new compose (a contact's Write) MINTS AN EMPTY
   * ROW as it goes — it appears in Drafts as "(no subject)" — so the composer is HOLDING that row
   * when the parked message is reopened from the list. The reopen loaded the right message and
   * the next pause wrote it into the DOOR'S row: one `PUT /api/drafts/<door row>` carrying the
   * parked subject and body. The parked row was never touched, so a guard watching writes to IT
   * saw a clean reopen — while the composer was working on a row the record does not name, Send
   * was live, and one press sent the message a second time.
   *
   * So the census here counts writes to ANY row, and the row this hook is holding at the moment
   * of the reopen is deliberately NOT released first: the shell's parked branch does release it
   * (pinned in `drafts-unverified.test.tsx`), and this asserts the refusal holds anyway, at the
   * layer the write happens in. A guard that depends on another file remembering to call
   * `release` is one edit away from the live sequence above.
   *
   * Mutation: restore `draftId === null &&` in front of the save effect's `parkedHere` test —
   * which is what shipped at that change. Real failure text:
   *   AssertionError: the parked message was written into a row that is not its own — the
   *   composer is working on a row the record cannot name: expected [ 'srv-1' ] to deeply equal []
   */
  it("a parked message is not poured into the row the previous message was holding", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    // THE DOOR: a new compose that mints an empty row at once. This hook is holding it.
    await mount(engine, typed());
    await settle();
    expect(seen.draftId, "the door's row was not created, so there is nothing to pour into")
      .toBe("srv-1");
    sent.length = 0;

    /* THE REOPEN. The parked message is a different row entirely, and its session is restored —
       the two writes the shell's parked branch makes. `release` is deliberately not called. */
    park({ draftId: "d-parked", subject: "draft:d-parked" });
    window.localStorage.setItem(composeRowKey(), "d-parked");
    await rerender(engine, typed({ subject: "Bis Montag", body: "Kommst du noch?" }));
    await settle();

    const wrote = sent
      .filter((m) => m.kind === "draft_save")
      .map((m) => (m as { draftId: string | null }).draftId ?? "a NEW row");
    expect(
      wrote,
      "the parked message was written into a row that is not its own — the composer is working "
      + "on a row the record cannot name",
    ).toEqual([]);
    expect(
      sent.filter((m) => m.kind === "draft_discard"),
      "a row was deleted across the reopen of a parked message",
    ).toHaveLength(0);
    expect(
      window.localStorage.getItem(composeRowKey()),
      "the held row moved off the parked message",
    ).toBe("d-parked");
  });

  /**
   * ══ THE ROW THE SEND MADE FOR ITSELF, OPENED FROM A SESSION THAT HAS MOVED ON ═════════════
   *
   * Nine steps, measured live end to end, and the last three are this hook's. Press Send before
   * the first save settles: the ADAPTER creates row A and the server marks A unconfirmed, while
   * the composer's own save creates B and the record binds to B — A's id never reaches this
   * browser. A door then starts a new message under a new session. Open A from Drafts: the reopen
   * holds it on the server's mark and Send is refused, correctly, because no record names A.
   *
   * And two seconds later this hook decided the message was NEW: its refusal asked only the
   * record, which names B under the old session — no match — so it created a row D, adopted it,
   * and `writeComposeRow(D)` REPLACED the hold on A. The send gate then saw an ordinary row,
   * Send came back on, and one press sent A's message a second time.
   *
   * So the refusal here is the same predicate the reopen and the send gate ask
   * (`composeMessageHeld`): a record naming the row or the session, OR the server's own mark on
   * the row this compose is holding. Three sites, one answer.
   *
   * Mutation: `composeMessageHeld(parked, _status)` → `parked !== null` (the status arm removed
   * at the save site). Real failure text:
   *   AssertionError: two seconds after opening the row, the composer decided the message was new
   *   and wrote for it: expected [ { kind: 'draft_save', …(7) } ] to have a length of +0 but got 1
   */
  it("a held row the server marked unverified is not replaced by a row of this hook's own", async () => {
    /* The mirror holds A as the server marks it. No record names A or the session on screen —
       the record, if any, belongs to the message that has been left behind. */
    const engine = new OhmailEngine({ adapter: adapterWith({
      sync: async () => ({
        changes: {
          creates: [{
            type: "draft", id: "A", op: "create", seq: 1,
            updatedAt: "2026-08-07T00:00:00.000Z",
            entity: { id: "A", mailboxId: "mb-1", status: "unverified" },
          }],
          updates: [], moves: [], deletes: [],
        },
        cursor: "1", hasMore: false, serverTime: "2026-08-07T00:00:00.000Z",
      }) as never,
    }) });
    await act(async () => { await engine.start(); });

    // THE REOPEN, as the parked branch leaves things: A held, nothing adopted, session s2 intact.
    window.localStorage.setItem(composeSessionKey(), "s2");
    window.localStorage.setItem(composeRowKey(), "A");
    await mount(engine, typed({ subject: "Bis Montag", body: "Kommst du noch?" }));
    await settle();

    expect(
      sent,
      "two seconds after opening the row, the composer decided the message was new and wrote for it",
    ).toHaveLength(0);
    expect(
      window.localStorage.getItem(composeRowKey()),
      "the hold on the row the server could not confirm was replaced by a row of this hook's own",
    ).toBe("A");
    expect(seen.draftId, "the unconfirmed row was adopted — a PUT or a Discard would go at it")
      .toBeNull();
    /* …and the send gate therefore still refuses, which is the end of the sequence. */
    const { canSend, heldRowUnverified } = await import("../app/shell/mail-send");
    const { holdOf: holdOf2 } = await import("../app/shell/send-lock");
    const rows2 = [{ id: "A", status: "unverified" }];
    const mirror2 = { read: () => ({ get: (_t: string, id: string) => rows2.find((r) => r.id === id) }) };
    expect(
      canSend(
        heldRowUnverified(
          { phase: "idle" }, window.localStorage.getItem(composeRowKey()),
          holdOf2(mirror2 as never, {
            lane: "compose", draftId: window.localStorage.getItem(composeRowKey()), session: "s2",
          }), "s2",
        ),
        {
          kind: "mail_send", inReplyTo: null, body: "Kommst du noch?", subject: "Bis Montag",
          to: [{ name: null, address: "lena@atelier.example" }], mailboxId: "mb-1",
        } as never,
      ),
      "Send is live for a message the server holds as unconfirmed — one press is a second copy",
    ).toBe(false);
  });

  /**
   * ══ THE SAVE THAT WAS ALREADY ARMED WHEN THE MESSAGE CHANGED ══════════════════════════════
   *
   * Measured live on RC10, and it moved where the fix has to bite. The create did NOT happen two
   * seconds after the reopen: it happened IN THE REOPEN WINDOW, and across the eight idle seconds
   * that followed every verb was zero. The compose the door had opened was still holding an armed
   * save — the door mints an empty row, a keystroke arms the next write — and the reopen switched
   * the held row underneath it. The scheduled save then fired against a message that no longer
   * existed on screen, made a row of its own, and replaced the hold on the unconfirmed row. Send
   * came back on immediately, before anybody waited for anything.
   *
   * A save is therefore asked again AT FIRE TIME, not only when it was scheduled. Cancelling the
   * pending timer at the reopen is the other half and is worth having, but on its own it is a race
   * with a two-second window; this is not.
   *
   * Mutation: delete the `if (parkedHere(engine, readComposeRow())) return;` INSIDE the timer
   * callback (the scheduled-time test above it stays). Real failure text:
   *   AssertionError: the save armed for the previous message fired against the held row and made
   *   a row of its own: expected [ { kind: 'draft_save', …(7) } ] to have a length of +0 but got 1
   */
  it("a save armed before the message changed does not write once it has", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith({
      sync: async () => ({
        changes: {
          creates: [{
            type: "draft", id: "A", op: "create", seq: 1,
            updatedAt: "2026-08-07T00:00:00.000Z",
            entity: { id: "A", mailboxId: "mb-1", status: "unverified" },
          }],
          updates: [], moves: [], deletes: [],
        },
        cursor: "1", hasMore: false, serverTime: "2026-08-07T00:00:00.000Z",
      }) as never,
    }) });
    await act(async () => { await engine.start(); });

    // THE DOOR'S COMPOSE: a new message under its own session, one keystroke in, save armed.
    window.localStorage.setItem(composeSessionKey(), "s2");
    await mount(engine, typed({ subject: "Etwas anderes", body: "Kurz:" }));
    await act(async () => { vi.advanceTimersByTime(AUTOSAVE_DELAY_MS - 100); });
    expect(sent, "the armed save fired early, so nothing is armed when the reopen happens")
      .toHaveLength(0);

    /* THE REOPEN, mid-flight: the held row becomes the unconfirmed one. The session is NOT
       restored — no record names this row, which is exactly the case under test. */
    window.localStorage.setItem(composeRowKey(), "A");
    await settle();

    expect(
      sent,
      "the save armed for the previous message fired against the held row and made a row of its own",
    ).toHaveLength(0);
    expect(
      window.localStorage.getItem(composeRowKey()),
      "the hold on the unconfirmed row was replaced by the armed save's own row",
    ).toBe("A");
    expect(seen.draftId, "the unconfirmed row was adopted by the armed save").toBeNull();
  });

  /**
   * THE POSITIVE. An ordinary `draft` row held under any session autosaves exactly as before —
   * without this, the refusal above would be satisfied by refusing every compose in the account.
   */
  it("an ordinary held row still autosaves, whatever session it is held under", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith({
      sync: async () => ({
        changes: {
          creates: [{
            type: "draft", id: "ordinary", op: "create", seq: 1,
            updatedAt: "2026-08-07T00:00:00.000Z",
            entity: { id: "ordinary", mailboxId: "mb-1", status: "draft" },
          }],
          updates: [], moves: [], deletes: [],
        },
        cursor: "1", hasMore: false, serverTime: "2026-08-07T00:00:00.000Z",
      }) as never,
    }) });
    await act(async () => { await engine.start(); });
    window.localStorage.setItem(composeSessionKey(), "s2");
    window.localStorage.setItem(composeRowKey(), "ordinary");
    await mount(engine, typed());
    await settle();

    expect(seen.draftId, "an ordinary held row was not adopted on the next mount").toBe("ordinary");
    /* The pause right after an adoption writes once on purpose — this mount does not know what
       the account holds for the row (`saved` stays null), so the first change is an UPDATE. */
    sent.length = 0;
    await rerender(engine, typed({ body: "Are we still on? Any time." }));
    await settle();
    const ids = sent.map((m) => (m.kind === "draft_save" ? m.draftId : "not-a-save"));
    expect(ids, "an ordinary draft stopped autosaving — every compose is unsaveable")
      .toEqual(["ordinary"]);
  });

  it("the row is adopted when the mirror loads, not only if it was warm at mount", async () => {
    /**
     * ── THE COLD RELOAD, WHICH IS THE ONLY RELOAD THERE IS ────────────────────────────────────
     *
     * On a real reload the shell starts the engine in an effect, so the mirror is EMPTY while
     * this hook mounts and the rows arrive afterwards. A version of the adoption that asked once
     * and gave up would therefore never adopt anything in production while passing every case
     * that reuses a warm engine — the pair-measuring shape. Here the row arrives only when the
     * engine is started, after the mount.
     *
     * Mutation: delete the `engine.subscribe(...)` retry and return after the first `settle()`.
     */
    const engine = new OhmailEngine({ adapter: adapterWith({
      sync: async () => ({
        changes: {
          creates: [{
            type: "draft", id: "srv-cold", op: "create", seq: 1,
            updatedAt: "2026-08-07T00:00:00.000Z",
            entity: { id: "srv-cold", mailboxId: "mb-1", status: "draft" },
          }],
          updates: [], moves: [], deletes: [],
        },
        cursor: "1", hasMore: false, serverTime: "2026-08-07T00:00:00.000Z",
      }) as never,
    }) });
    window.localStorage.setItem(composeRowKey(), "srv-cold");
    await mount(engine, typed());
    expect(seen.draftId, "a row the mirror had not loaded yet was adopted on faith").toBeNull();

    await act(async () => { await engine.start(); });
    expect(
      seen.draftId,
      "the row was never adopted — the mirror answered after the one and only question",
    ).toBe("srv-cold");

    await rerender(engine, typed({ body: "Are we still on? Any time." }));
    await settle();
    const ids = sent.map((m) => (m.kind === "draft_save" ? m.draftId : "not-a-save"));
    expect(ids, "the pause created a row instead of updating the one it came back to")
      .toEqual(["srv-cold"]);
  });
});

describe("the shell is the consumer, not just the harness", () => {
  /**
   * THE WIRING, STRUCTURALLY. Everything above drives the hook directly, which is exactly the
   * blind spot `fetchBody` and `searchServer` shipped through: a hook that works perfectly and
   * is called by nothing. Both ends are pinned here — the shell arms the hook and gives its id
   * to the plan, and the Drafts list is rendered from the selector rather than from a copy.
   */
  it("AppShell arms autosave, feeds Send its id, and renders the list", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const shell = readFileSync(
      resolve(process.cwd(), "apps/webapp/app/shell/shell-compose.ts"), "utf8",
    );
    expect(shell, "the compose form is not autosaved on the live path")
      .toContain("useComposeAutosave(");
    expect(shell, "autosave runs whether or not Compose is open")
      .toMatch(/active:\s*route\.view === "compose"/);
    expect(shell, "Send would create a second row beside the autosaved one")
      .toMatch(/composePlan\(\{ \.\.\.compose, forwardParts: [^}]*\}, composeMailbox, autosave\.draftId\)/);
    expect(shellFrameOf("drafts").source, "the Drafts list is built from something other than the selector")
      .toContain("draftsList(reader)");
    /* The rail entry is chrome, and the rail left `AppShell.tsx` for `shell-keys.tsx` with the
       palette and the global chords (ARCH-022 L6). Asked of the FRAME that declares the rail:
       `railGroups` carries a type annotation, so `const railGroups =` is not in the file and the
       resolver has no name to find — `railGroupsWithHints`, which maps over it, is the one it
       does. */
    expect(shellFrameOf("railGroupsWithHints").source, "there is no way to reach the Drafts list")
      .toContain('id: "drafts"');
  });

  /**
   * ── EVERY DOOR THAT REPLACES THE COMPOSE FORM RE-MINTS ITS SESSION ────────────────────────
   *
   * The compose session id is what a durable send record parks a message BY, and it is minted
   * lazily beside the scratch buffer — so a door that replaces the form and leaves the id alone
   * makes one session span several messages. Measured consequence: a send of the first message
   * came back unverified, the person opened a different draft (or took a `mailto:` link, or the
   * contact popover\u0027s Write), and the surface showed "We couldn\u0027t confirm this send" over a
   * message nobody had ever pressed Send on, with Send refused.
   *
   * A census over the SHAPE rather than a list of the three doors: the pairing is what has to
   * hold, so it is recomputed from the file and a fourth door added later is covered without
   * anybody remembering this test. The window is the immediately preceding statement — a
   * `clearComposeDraft()` in a neighbouring function must not be able to satisfy it, which a
   * character-count window would have allowed (`cancelCompose` sits thirty lines above `writeTo`).
   *
   * Mutation: delete the `clearComposeDraft();` line from any one of the three.
   */
  it("every door that replaces the compose form re-mints its session", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const lines = readFileSync(
      resolve(process.cwd(), "apps/webapp/app/shell/shell-compose.ts"), "utf8",
    ).split("\n");

    const doors = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => line.includes("writeComposeDraft(seeded)"));
    expect(
      doors.length,
      "the compose-seeding doors moved — this census is counting something else",
    ).toBe(3);

    /*
     * ── ONE DOOR IS CONDITIONAL, AND THE CONDITION IS NAMED ─────────────────────────────────
     *
     * Reopening a draft the browser holds an UNRESOLVED send record for must NOT re-mint: doing
     * so takes both of the names the park holds that message by off it at once, which is the
     * measured duplicate delivery (recipient total 2). So that one door reads
     * `if (!parked) clearComposeDraft();`.
     *
     * The census is not loosened to accept either form anywhere — that would let the next door
     * added quietly skip the re-mint behind any condition at all. The guarded form is allowed at
     * exactly ONE door, its condition must be the `parked` question, and that question must be
     * asked from `holdOf` above it. Every other door stays unconditional.
     */
    const GUARDED = "if (!parked) clearComposeDraft();";
    let guarded = 0;
    for (const { i } of doors) {
      // Upwards past blank lines and comment lines to the previous STATEMENT.
      let j = i - 1;
      while (j >= 0) {
        const t = lines[j]!.trim();
        if (t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*")) break;
        j -= 1;
      }
      const prev = lines[j]!.trim();
      if (prev === GUARDED) {
        guarded += 1;
        /*
         * THE WINDOW IS THE ENCLOSING CALLBACK, NOT A LINE COUNT, and that is a correction.
         *
         * This read 40 lines above the door, which was enough while `openDraft` computed its
         * hold immediately before seeding the form. It no longer does: the hold moved to the TOP
         * of the callback so the REPLY arm — which returns before the seeding code and used to
         * open a held draft in the inline editor with Send live — is covered by the same reading.
         * The declaration now sits hundreds of lines above this door and a fixed window could not see it,
         * so the census failed on a change that made the property it guards strictly more true.
         *
         * Scoping to the enclosing `useCallback(` is also STRICTER than the line count, which is
         * why it is the right repair rather than a bigger number: a `parked` declared in some
         * neighbouring callback can no longer satisfy a door in this one, at any distance.
         */
        let fnStart = j;
        while (fnStart > 0 && !lines[fnStart]!.includes("useCallback(")) fnStart -= 1;
        const above = lines.slice(fnStart, j).join("\n");
        expect(
          above,
          `the door at shell-compose.ts:${i + 1} skips the re-mint behind a condition that is not the `
          + "parked question asked from `holdOf` inside its own callback",
        ).toContain("const parked = hold.kind !== \"free\";");
        continue;
      }
      expect(
        prev,
        `the door at shell-compose.ts:${i + 1} seeds a new message without re-minting the compose `
        + "session, so an unresolved send parks whatever replaced it",
      ).toBe("clearComposeDraft();");
    }
    expect(
      guarded,
      "more than one door skips the re-mint, or the reopen of a parked message stopped doing so",
    ).toBe(1);
  });

  /**
   * WHAT THE LIST SHOWS: everything the user can still act on, and nothing that left.
   *
   *   · `draft` — being written.
   *   · `unverified` — SMTP threw and the Sent probe found nothing: the row holds the ONLY copy
   *     of a message that may never have been delivered. Filtering it out (which this test used
   *     to pin) made that loss invisible on every surface — the user was told to check Sent,
   *     found nothing anywhere, and concluded the mail was gone. It was.
   *   · `sending`, once STALE (past `SENDING_STALE_AFTER_MS`) — a send that died without a
   *     verdict; the same stranding without the word.
   *   · `sent` — never. And a FRESH `sending` row — never: that is an ordinary delivery's two
   *     seconds, not a warning.
   *
   * Mutation: widen the filter to every status, or drop the staleness cut, and one of the two
   * assertions below goes red — measured before this comment was written.
   */
  /**
   * ══ EVERY SITE THAT WRITES A DRAFT ROW, AND WHAT STOPS IT WRITING FOR A HELD MESSAGE ══════
   *
   * The door census beside this one counts DOORS — the places that replace the message on screen.
   * This counts WRITE SITES, which is where the damage happened three times running: each of those
   * defects was a place that wrote to the account for a message whose send may already have gone,
   * and each was found by driving a browser rather than by anything here.
   *
   * There is no review round after this one. So the census enumerates the sites rather than
   * sampling them: a new `draft_save` or `draft_discard` anywhere in the shell fails the count,
   * and each existing one is named with the reason it cannot write for a held message. The reasons
   * are of two kinds and they are not interchangeable — one is a GUARD (the predicate is asked),
   * the other is a STRUCTURE (the row it would write to cannot exist for a held message). A
   * structural reason is only as good as the sentence explaining it, so each is asserted, not
   * asserted-in-passing.
   *
   * Mutation (and the RC10 state): the save effect asks `parkedComposeRecord` alone,
   * with no fire-time test. Real failure text:
   *   AssertionError: the save effect does not ask the one predicate — it reads the record for
   *   itself, so the server's own mark on a held row does not stop it writing: expected
   *   'function parkedHere(engine: OhmailEng…' to match /composeMessageHeld\(/
   */
  it("every site that writes a draft row is accounted for, and the writing one asks the predicate", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (f: string): string =>
      readFileSync(`${process.cwd()}/apps/webapp/app/shell/${f}`, "utf8");
    const shell = read("shell-compose.ts");
    const autosave = read("compose-autosave.ts");
    const send = read("mail-send.ts");
    const lock = read("send-lock.ts");
    const creates = read("draft-creates.ts");

    /* ── THE PREDICATE ITSELF, IN ONE PLACE, WITH BOTH WITNESSES ─────────────────────────────
       The record speaks for a row the server still calls `draft`; the server's mark speaks for the
       row the SEND created for itself, whose id never reaches this browser. Either alone was
       measured shipping a duplicate. */
    expect(lock, "the one predicate is gone, so each site decides for itself again")
      .toMatch(/export function holdOf\(/);
    /* BOTH WITNESSES, and the third answer. `parked` by record speaks for a row the server still
       calls `draft`; `parked` by status speaks for the row the SEND created for itself, whose id
       never reaches this browser; `unknown` is the state a boolean had nowhere to put. */
    expect(lock, "the predicate lost the record witness — it was a duplicate on its own")
      .toMatch(/kind: "parked", by: "record"/);
    expect(lock, "the predicate lost the status witness — it was a duplicate on its own")
      .toMatch(/kind: "parked", by: "status"/);
    expect(lock, "every status past `draft` is no longer held — a stranded `sending` row was the "
      + "one that took the recovery door and delivered twice")
      .toMatch(/if \(row\.status !== "draft"\) \{/);

    /* ── EVERY WRITE SITE IN THE SHELL ───────────────────────────────────────────────────────
       Counted, so one added later cannot pass unclassified. */
    const sites: Array<[string, string]> = [];
    for (const [name, src] of [
      ["shell-compose.ts", shell], ["compose-autosave.ts", autosave], ["mail-send.ts", send],
      // The copy a landed create left (`dropCopy`): a delete that never takes a row a send
      // record names nor the row the send went from (S(2)); held in `sent-offline-leaves-drafts`.
      ["draft-creates.ts", creates],
    ] as Array<[string, string]>) {
      for (const m of src.matchAll(/kind: "draft_(save|discard)"/g)) {
        sites.push([name, m[1]!]);
      }
    }
    expect(
      sites.length,
      "a site that writes a draft row was added or removed — classify it here before shipping it",
    ).toBe(8);
    /* TWO SAVES NOW, and the second one is classified below with the other write sites: the
       orphaned-lane promotion in `mail-send.ts` (the type it takes, and the call inside it) is one
       site spelled twice. It writes for a message whose PARENT has been deleted, which is not the
       same question as a held compose — so it asks the three witnesses the create gate asks, on
       the REPLY lane, and skips the lane when any of them speaks. */
    expect(sites.filter(([, kind]) => kind === "save"), "the write count moved").toHaveLength(3);

    /* ── THE ONE THAT WRITES ─────────────────────────────────────────────────────────────────
       Asked TWICE: when the save is scheduled, and again when it fires. The second is not
       redundant — two seconds pass in between, and the message on screen can become a different
       one, which is precisely the sequence measured live (a create landing in the reopen window
       of a row the server holds as unconfirmed). Both must sit ABOVE the mutation. */
    /* TWO MOMENTS, TWO SPELLINGS — and the second is not a tidier version of the first. At SCHEDULE
       time the answer is thrown away after the test and the effect simply does not arm; at WRITE
       time it is KEPT (the create arm needs it again for the `unknown`-beside-a-held-row refusal,
       the reload duplicate) and it answers the CLOSE, which is why it returns a flush outcome
       rather than nothing. Both are pinned so neither can be rewritten into the other. */
    const scheduleAsk = [...autosave.matchAll(
      /if \(holdOf\(engine, \{\n\s*lane: COMPOSE_SEND_KEY, draftId: readComposeRow\(\), session: composeSessionId\(\),\n\s*\}\)\.kind === "parked"\) return;/g,
    )].map((m) => m.index ?? -1);
    const writeAsk = [...autosave.matchAll(
      /const hold = holdOf\(engine, \{\n\s*lane: COMPOSE_SEND_KEY, draftId: readComposeRow\(\), session: composeSessionId\(\),\n\s*\}\);\n\s*if \(hold\.kind === "parked"\) return \{ kind: "nothing" \};/g,
    )].map((m) => m.index ?? -1);
    expect(
      scheduleAsk.length + writeAsk.length,
      "the save is asked at one moment only — a save armed before the message changed writes for "
      + "whatever replaced it",
    ).toBe(2);
    /* AGAINST THE WRITE-TIME ASK, NAMED — not against "the later of the two". The write left the
       effect when the close gained a flush (`writeNow` is the one implementation both run), so
       the scheduling ask now sits BELOW the write in the file and an ordering pin over the pair
       would read the move as the defect it exists to catch. */
    const writesAt = autosave.indexOf('kind: "draft_save"');
    expect(writesAt, "the write moved above its own guard").toBeGreaterThan(writeAsk[0]!);

    /* ── THE ONES THAT DELETE, EACH WITH ITS REASON ──────────────────────────────────────────
       No `draft_discard` is guarded by the predicate, and none needs to be — but the reason is
       different at every site, so each is stated and checked rather than waved at. */

    // 1. The composer's own Discard asks the predicate ITSELF, in the primitive rather than at
    //    each door: `cancelCompose` calls it, `settled`'s phantom branch calls it, and a door
    //    added later would call it too. A held row is released, never deleted.
    expect(autosave, "Discard deletes a row without asking whether the message is held")
      .toMatch(/const hold = holdOf\(engine, \{[\s\S]{0,220}\}\);\n\s*if \(hold\.kind !== "free"\) \{/);
    expect(autosave, "the adoption stopped refusing a held row")
      .toMatch(/if \(hold\.kind !== "free"\) return false;/);

    // 2. The epoch undo deletes a row THIS CALL just created — which cannot happen for a held
    //    message, because the guard above refused the call.
    expect(autosave, "the undo deletes a row it did not create")
      .toMatch(/draftId: result\.entityId/);

    // 3. THE RECOVERY DELETE IS GONE. `onSendSettled` used to discard the row a compose had been
    //    "recovered" from once the fresh send confirmed. Invariant S(2) forbids recovering a row
    //    past `draft` into a fresh key at all, so the branch that armed it is unreachable and both
    //    it and the delete are removed rather than left as a dead arm.
    expect(shell, "the recovery seed came back — a row a send may still be delivering is armed "
      + "for deletion again")
      .not.toMatch(/recoverySeed\.current =/);

    // 4. The reply-seed delete belongs to another lane entirely (`replySeedDrafts`, keyed by the
    //    answered message), never to the compose surface.
    expect(shell, "the reply seed delete reaches the compose surface's rows")
      .toMatch(/replySeedDrafts\.current\.delete\(key\);\s*\n\s*void engine\.mutate\(\{ kind: "draft_discard"/);

    // 5. `discardDraft` is a person pressing Delete on a row in the list. It is not this
    //    predicate's business to refuse that, and it is the one place a held row IS deleted on
    //    purpose. (The server answers 500 for such a row today — recorded as its own gap.)
    /* Anchored on the DECLARED NAME, not on the hook it happens to be declared with. The
       previous spelling named the memo primitive; a codemod rewrote every one of them in the
       shell and this positive `toMatch` then failed with the sentence for a different defect
       ("the shell stopped using this name") instead of for the stale anchor it was.
       `sliceOfDeclaration` throws `anchor not found: discardDraft` if the shell stops declaring
       it, which is the existence half of this claim, and the slice it returns is the
       declaration itself — so the assertion is that this site is the one that reaches the wire,
       rather than merely that some line somewhere spells the name. */
    expect(
      sliceOfDeclaration(shell, "discardDraft"),
      "the explicit Delete moved out of the drafts list",
    ).toContain('kind: "draft_discard"');

    // 6. THE ORPHANED-LANE PROMOTION. It creates a row for a reply whose parent another mail
    //    client deleted, so the compose surface's record says nothing about it — the question is
    //    whether THAT LANE's send is already on its way, and it is asked with the same three
    //    witnesses (queue, durable outbox, jar record) before the lane is touched at all.
    expect(shell, "the promotion writes a row for a lane whose send may already have gone")
      .toMatch(/sendPendingInOutbox\(engine, lane\)\s*\|\| sendPendingInDurableOutbox\(engine, lane\)\s*\|\| holdOf\(engine, \{ lane, draftId: null, session: null \}\)\.kind !== "free"\s*\) continue;/);
    //    …and the lane is cleared only once the row is CONFIRMED — the server's id for a create,
    //    the row it wrote for an update — so a refusal leaves the words where they were.
    expect(send, "the promoted lane is cleared before its row exists")
      .toMatch(/const rowId = result\.entityId \?\? plan\.rowId;\s*if \(result\.status !== "confirmed" \|\| !rowId\) return "refused";/);

    /* ── AND THE THREE SITES THAT DECIDE WHAT THE MESSAGE IS ─────────────────────────────────
       Not writes, but they choose the row every later write goes to. All ask the predicate. */
    expect(shell, "the reopen decides without the predicate")
      .toMatch(/const hold = holdOf\(engine, \{[\s\S]{0,200}\}\);\n\s*const parked = hold\.kind !== "free";/);
    expect(send, "the send gate reads a row's status for itself instead of consuming the answer")
      .toMatch(/if \(hold\.kind !== "parked"\) return state;/);
    expect(send, "the press does not ask the predicate, so a caller that is not the button gets past "
      + "what the button enforces")
      .toMatch(/const hold = holdOf\(engine, \{[\s\S]{0,260}\}, owner\.current\);\n\s*if \(hold\.kind === "parked"\) \{/);
  });

  it("draftsList: drafts, unverified and stranded sends — never sent, never a live send", async () => {
    const { draftsList, SENDING_STALE_AFTER_MS } = await import("@ohmail/client-engine");
    const now = new Date("2026-08-07T12:00:00.000Z");
    const at = (msAgo: number): string => new Date(now.getTime() - msAgo).toISOString();
    const base = {
      mailboxId: "mb-1", threadId: null, inReplyToMessageId: null,
      subject: "", body: "", to: [], cc: [], bcc: [], rationale: null,
      createdAt: "2026-08-01T00:00:00.000Z",
    };
    const rows: EngineDraft[] = [
      { ...base, id: "a", status: "draft", updatedAt: at(4 * 60_000) },
      { ...base, id: "live", status: "sending", updatedAt: at(60_000) },
      { ...base, id: "sent", status: "sent", updatedAt: at(30_000) },
      { ...base, id: "u", status: "unverified", updatedAt: at(2 * 60_000) },
      { ...base, id: "stranded", status: "sending", updatedAt: at(SENDING_STALE_AFTER_MS + 60_000) },
    ];
    const reader = {
      list: <T,>(type: string): T[] => (type === "draft" ? (rows as unknown as T[]) : []),
      get: () => undefined,
    } as never;
    const listed = draftsList(reader, now).map((d) => d.id);
    expect(listed, "a sent message, or a send still in flight, is in the Drafts list")
      .not.toContain("sent");
    expect(listed).not.toContain("live");
    // Newest-touched first: the unverified send and the stranded one are IN the list.
    expect(listed, "an undelivered send is invisible in the Drafts list")
      .toEqual(["u", "a", "stranded"]);

    // …and the order is by LAST TOUCHED, which is what "what was I writing" means.
    const two: EngineDraft[] = [
      { ...base, id: "old", status: "draft", updatedAt: "2026-08-01T00:00:00.000Z" },
      { ...base, id: "new", status: "draft", updatedAt: "2026-08-07T00:00:00.000Z" },
    ];
    const reader2 = {
      list: <T,>(type: string): T[] => (type === "draft" ? (two as unknown as T[]) : []),
      get: () => undefined,
    } as never;
    expect(draftsList(reader2, now).map((d) => d.id)).toEqual(["new", "old"]);
  });
});

describe("reopening a held row does not write over what is on screen", () => {
  /**
   * ── THE LOSS THIS CLOSES ────────────────────────────────────────────────────────────────
   *
   * The refusal asked "is a DIFFERENT row on screen" (`autosave.draftId !== d.id`), and a held
   * message's own row is exactly the binding an unconfirmed send leaves in place — so reopening it
   * from Drafts skipped the refusal and wrote the row's PRE-SEND text over the buffer. Autosave
   * had written none of the text typed since: a parked message's saves are refused, which is what
   * makes the buffer the only copy. Nothing asked, and it cannot be undone.
   *
   * The question is the buffer's DRIFT from the row instead — something worth keeping on screen,
   * and a value the reopen would change. Recipients are compared as ADDRESSES, not as the chip
   * text: the row stores parsed addresses and the buffer holds what somebody typed, so a
   * formatting round-trip must not read as an edit and refuse the right person.
   */
  const seed = (over: Partial<ComposeFields> = {}): ComposeFields => ({
    ...EMPTY_COMPOSE, to: "sam@customer.example, ", subject: "Invoice", body: "The paper order.",
    ...over,
  });

  /**
   * THE POSITIVE CONTROL, first because everything else here is a refusal: reopening the row
   * that is already on screen, untouched, still opens. A rule that refused it would leave a held
   * message unreachable from its own composer.
   *
   * Mutation: `return true` in `reopenWouldOverwrite`.
   */
  it("the row on screen, untouched, is not an overwrite", () => {
    expect(reopenWouldOverwrite(seed(), seed())).toBe(false);
    expect(reopenWouldOverwrite(EMPTY_COMPOSE, seed())).toBe(false);
    /* The chip text round-trips through parse and format; the addresses are what the row holds. */
    expect(
      reopenWouldOverwrite(seed({ to: "Sam <SAM@customer.example>" }), seed()),
      "a formatting difference in the To line reads as an edit, so reopening a held message from "
      + "its own composer is refused for a change nobody made",
    ).toBe(false);
  });

  /**
   * ── THE DEFECT'S OWN SEQUENCE ─────────────────────────────────────────────────────────────
   *
   * Mutation: drop the body comparison from `reopenWouldOverwrite`. Real failure text:
   *   AssertionError: text typed into a held message after its send is not protected …
   */
  it("a word typed into the held message since the send IS an overwrite", () => {
    expect(
      reopenWouldOverwrite(seed({ body: "The paper order. And the pallets?" }), seed()),
      "text typed into a held message after its send is not protected — reopening its own row "
      + "replaces it with the row's pre-send text, and autosave never stored it",
    ).toBe(true);
    expect(
      reopenWouldOverwrite(seed({ subject: "Invoice and pallets" }), seed()),
      "a retitled held message loses its new subject to the reopen",
    ).toBe(true);
    expect(
      reopenWouldOverwrite(seed({ to: "sam@customer.example, ops@customer.example" }), seed()),
      "a recipient added to a held message is dropped by the reopen",
    ).toBe(true);
  });

  /** A different part-written message on screen — the case the old rule did cover. */
  it("an unrelated part-written message is still protected", () => {
    expect(
      reopenWouldOverwrite(seed({ subject: "Pallets", body: "Different message." }), seed()),
      "the reopen writes over a message the account has not been given yet",
    ).toBe(true);
  });

  /**
   * ── FILES, IN TWO FIXTURES, BECAUSE ONE MEASURES THE PAIR ─────────────────────────────────
   *
   * Two arms answer for an attachment: the first gate counts files so a form holding only a file
   * is not called empty (`worthSaving` reads text alone), and the comparison itself refuses a file
   * the row does not hold. With one fixture they cover for each other — dropping the comparison
   * stayed GREEN against a buffer whose subject also differed, because the subject decided it.
   * So each arm gets the fixture that tells it apart.
   *
   * Mutations: `if (!worthSaving(buffer)) return false;` in place of the gate (first case), and
   * dropping the file comparison (second).
   */
  const FILE = { id: "a1", name: "order.pdf", type: "application/pdf", size: 12, dataBase64: "AA==" };

  it("a file attached and nothing typed is not an empty form", () => {
    const onlyFile: ComposeFields = { ...EMPTY_COMPOSE, attachments: [FILE] } as never;
    expect(
      reopenWouldOverwrite(onlyFile, seed()),
      "a compose holding only an attachment is called empty, so the reopen drops the file",
    ).toBe(true);
  });

  it("a file the row does not hold is an overwrite on its own", () => {
    /* IDENTICAL IN EVERY OTHER FIELD, which is what makes the file the only thing that can
       decide this — the point the one-fixture version could not make. */
    const seedPlusFile: ComposeFields = { ...seed(), attachments: [FILE] } as never;
    expect(
      reopenWouldOverwrite(seedPlusFile, seed()),
      "a file attached to a held message since its send is dropped by the reopen, and nothing "
      + "else on screen had changed to say so",
    ).toBe(true);
  });

  /**
   * And the shell asks THIS rather than deciding again.
   *
   * `openDraftWithBody` and not `openDraft`: opening a draft is two steps now — `openDraft`
   * decides whether the text is in hand and fetches it when it is not, and this is the door it
   * hands a known body to. The refusal belongs to the door that seeds the composer, so slicing
   * the wrong declaration reads as the refusal being gone. The second case keeps the pair
   * honest: the outer door must reach this one instead of seeding anything itself, or a future
   * split could open a draft past the refusal with both slices still matching.
   */
  it("the seeding door's refusal asks the predicate and no longer asks which row is bound", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const shell = readFileSync(
      resolve(process.cwd(), "apps/webapp/app/shell/shell-compose.ts"), "utf8",
    );
    const openDraft = sliceOfDeclaration(shell, "openDraftWithBody");
    expect(
      openDraft,
      "openDraftWithBody decides for itself whether the reopen would overwrite anything",
    ).toMatch(/if \(parked && reopenWouldOverwrite\(composeRef\.current, seeded\)\)/);
    expect(
      openDraft,
      "openDraftWithBody still skips the refusal for the row it is bound to — which is exactly "
      + "the binding an unconfirmed send leaves in place",
    ).not.toMatch(/autosave\.draftId !== d\.id/);
  });

  it("the outer door reaches the seeding door instead of seeding a composer of its own", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const shell = readFileSync(
      resolve(process.cwd(), "apps/webapp/app/shell/shell-compose.ts"), "utf8",
    );
    const outer = sliceOfDeclaration(shell, "openDraft");
    expect(
      outer,
      "openDraft no longer hands the row to the door that asks about the hold",
    ).toMatch(/openDraftWithBody\(/);
    expect(
      outer,
      "openDraft seeds the composer itself, so a draft can now be opened without the refusal "
      + "ever being asked",
    ).not.toMatch(/setCompose\(/);
  });
});

/**
 * ═══ A BODY TOO BIG TO SAVE SAYS SO, AND SAYS IT BEFORE THE PUT ══════════════════════════
 *
 * The server refuses a plain body past `DRAFT_BODY_MAX_BYTES` with `draft_too_large`/413, and this
 * hook's error path is a deliberate silence — see its `catch`. So an oversized body sent from here
 * would be retried at every pause for ever, with nothing on screen to say the account is not
 * keeping up and "Saved to your drafts after a moment" still on the surface underneath it. That is
 * the shape where somebody loses what they wrote while being told it was kept.
 *
 * Two things are therefore asserted together: the door writes NOTHING, and the sentence the
 * surface renders changes at the same byte. Nothing is taken away from the author on either side —
 * the text stays in the form, and the first edit that brings it back under the ceiling saves the
 * whole message.
 */
describe("a body past the ceiling is refused here, not at the server", () => {
  const atCeiling = "a".repeat(DRAFT_BODY_MAX_BYTES);
  const overCeiling = "a".repeat(DRAFT_BODY_MAX_BYTES + 1);

  it("writes nothing at all for an oversized body", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, typed({ body: overCeiling }));
    await settle();
    expect(sent, "an oversized draft was PUT to the account anyway").toHaveLength(0);
  });

  it("writes the whole body AT the ceiling — the refusal is one byte wide", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, typed({ body: atCeiling }));
    await settle();
    expect(sent).toHaveLength(1);
    expect((sent[0] as { body?: string }).body, "the body was shortened to fit").toBe(atCeiling);
  });

  it("saves the whole message once it is cut back under — the repair path", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, typed({ body: overCeiling }));
    await settle();
    expect(sent).toHaveLength(0);

    // The person deletes what they pasted. Nothing was written while it was over, so this is a
    // CREATE carrying everything — subject and recipients included, not just the body.
    await rerender(engine, typed({ body: "the short version" }));
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "draft_save", body: "the short version", subject: "Friday" });
  });

  it("refuses an EDIT that grows an existing row past the ceiling, and keeps the row", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, typed({ body: "first" }));
    await settle();
    expect(sent).toHaveLength(1);
    const id = seen.draftId;
    expect(id, "the create was not adopted, so the next case measures nothing").not.toBeNull();

    await rerender(engine, typed({ body: overCeiling }));
    await settle();
    expect(sent, "an oversized EDIT reached the account").toHaveLength(1);
    // The row is still this message's row: the refusal did not discard or re-mint it.
    expect(seen.draftId).toBe(id);

    await rerender(engine, typed({ body: "cut back down" }));
    await settle();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ kind: "draft_save", draftId: id, body: "cut back down" });
  });

  /**
   * THE CLAIM AND ITS ENFORCEMENT, DRIVEN FROM ONE INPUT.
   *
   * `draftNoteKey` is what `ComposeView` renders the note from and the door above is what decides
   * whether anything is written. Neither test alone catches the failure that matters — a surface
   * promising a save the door refuses — so the two are measured against each other over the same
   * fields, including the exact boundary.
   */
  it("the sentence turns over at the same byte the door does", async () => {
    for (const [body, saves] of [
      ["", true], ["ordinary text", true], [atCeiling, true], [overCeiling, false],
      // Bytes, not characters: under the ceiling in `String.length`, over it on the wire.
      ["ä".repeat(DRAFT_BODY_MAX_BYTES / 2 + 1), false],
    ] as const) {
      const fields = typed({ body });
      expect(draftNoteKey(fields)).toBe(saves ? "draftNote" : "bodyTooLong");

      sent = [];
      const engine = new OhmailEngine({ adapter: adapterWith() });
      await mount(engine, fields);
      await settle();
      expect(
        sent.length > 0,
        `the note said ${draftNoteKey(fields)} and the door ${sent.length > 0 ? "wrote" : "wrote nothing"}`,
      ).toBe(saves);
      await act(async () => root!.unmount());
      root = null;
      host?.remove();
      host = null;
      window.localStorage.clear();
    }
  });

  /**
   * ── AND THE FORMATTED HALF, WHICH USED TO 413 IN SILENCE ─────────────────────────────────
   *
   * `DRAFT_HTML_CAP_BYTES` is the same number and has been refused at the server since the rich
   * editor shipped, with nothing said beforehand — the exact shape closed above for plain text,
   * one message type over. The composer sends `html` OR `body`, never both, so the predicate is
   * over the EFFECTIVE body: the larger of the two halves, which is how the request door prices
   * its worst legal body.
   */
  const atHtmlCeiling = `<p>${"a".repeat(DRAFT_BODY_MAX_BYTES - 7)}</p>`;
  const overHtmlCeiling = `<p>${"a".repeat(DRAFT_BODY_MAX_BYTES - 6)}</p>`;

  it("writes nothing for an oversized FORMATTED body, whatever the plain half weighs", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    // A short plain half beside a huge markup one: the arm a plain-only predicate admits.
    await mount(engine, typed({ body: "short", html: overHtmlCeiling }));
    await settle();
    expect(sent, "an oversized formatted draft was PUT to the account anyway").toHaveLength(0);
  });

  it("writes the whole markup AT the ceiling — one byte wide on this half too", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, typed({ body: "short", html: atHtmlCeiling }));
    await settle();
    expect(sent).toHaveLength(1);
    expect((sent[0] as { html?: string }).html, "the markup was shortened to fit").toBe(atHtmlCeiling);
  });

  it("the sentence turns over at the same byte on the formatted half", async () => {
    for (const [html, saves] of [
      ["<p>ordinary</p>", true], [atHtmlCeiling, true], [overHtmlCeiling, false],
    ] as const) {
      const fields = typed({ body: "short", html });
      expect(draftNoteKey(fields)).toBe(saves ? "draftNote" : "bodyTooLong");

      sent = [];
      const engine = new OhmailEngine({ adapter: adapterWith() });
      await mount(engine, fields);
      await settle();
      expect(
        sent.length > 0,
        `the note said ${draftNoteKey(fields)} and the door ${sent.length > 0 ? "wrote" : "wrote nothing"}`,
      ).toBe(saves);
      await act(async () => root!.unmount());
      root = null;
      host?.remove();
      host = null;
      window.localStorage.clear();
    }
  });

  it("a plain draft is still judged on its text alone", async () => {
    // The control for the effective-body rule: an empty markup half must not make an oversized
    // PLAIN body savable, and must not make an ordinary one refusable. `ComposeFields.html` is
    // `""` until somebody formats something; the predicate's absent-markup arm is exercised from
    // `packages/core/test/outbound-text.test.ts`, where a caller can omit the argument.
    expect(draftNoteKey(typed({ body: "short", html: "" }))).toBe("draftNote");
    expect(draftNoteKey(typed({ body: overCeiling, html: "" }))).toBe("bodyTooLong");
  });

  it("both sentences exist in both catalogues", async () => {
    // A key the surface renders and a catalogue does not carry is a crash on first render, and
    // this branch only appears once somebody has pasted a book into the form.
    // Through `unknown`: the catalogues' inferred literal types nest objects, so the direct
    // assertion is a TS2352 the webapp's own typecheck refuses. The runtime read is unchanged.
    const en = (await import("../messages/en.json")).default as unknown as Record<string, Record<string, string>>;
    const de = (await import("../messages/de.json")).default as unknown as Record<string, Record<string, string>>;
    for (const key of ["draftNote", "bodyTooLong"]) {
      expect(en.compose?.[key], `en.compose.${key}`).toBeTruthy();
      expect(de.compose?.[key], `de.compose.${key}`).toBeTruthy();
    }
    expect(de.compose!.bodyTooLong).not.toBe(en.compose!.bodyTooLong);
  });
});

describe("the close's flush, at the hook", () => {
  /**
   * ═══ THE PENDING SAVE RUNS BEFORE THE COMPOSER IS GONE ═══════════════════════════════════
   *
   * The debounce is a promise to write in two seconds; a close inside those two seconds used to
   * cancel it with its timer and say nothing. `flush()` is that same write, run early — the
   * surface-level arms are in `compose-close-saves.test.tsx`; these are the hook's own contract,
   * which no mounted shell can show.
   */
  it("writes what the pause had not, without waiting the pause out", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, typed());
    expect(sent, "the debounce did not hold — this case measures nothing").toHaveLength(0);

    await act(async () => { await seen.flush(); });

    expect(sent.map((m) => m.kind), "the close wrote nothing").toEqual(["draft_save"]);
  });

  /**
   * AND THE BELT, for the exits no door owns — the hook's `active` falling. Same write, so a
   * door that forgets to flush cannot lose a message; only the sentence on a refusal is the
   * door's own.
   *
   * Mutation: delete the deactivate effect (`return () => { void writeNow(); };`). Real failure
   * text:
   *   AssertionError: the composer went inactive and the armed save went with it: expected []
   *   to deeply equal [ 'draft_save' ]
   */
  it("writes when the composer goes inactive", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, typed());

    await rerender(engine, typed(), { active: false });
    await act(async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); });

    expect(sent.map((m) => m.kind), "the composer went inactive and the armed save went with it")
      .toEqual(["draft_save"]);
  });

  /**
   * ══ AND IT MAY NOT WRITE BACK A MESSAGE THIS SURFACE LET GO OF ═════════════════════════
   *
   * `release` is how every door lets go — the cancel's discard, a send settling, a new-message
   * door — and it clears `saved`, so the dedupe that would otherwise refuse this write is gone
   * by construction. A flush on the way out would then create a row for a message somebody threw
   * away: a copy in the Drafts list that nothing surfaces and nobody asked for.
   *
   * Mutation: drop `if (signature === abandonedAt.current)` from `writeNow`. Real failure text:
   *   AssertionError: the close wrote back a message this surface had let go of: expected [
   *   'draft_save', 'draft_save' ] to deeply equal [ 'draft_save' ]
   */
  it("writes nothing for a form that was released and not touched since", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, typed());
    await settle();
    expect(sent, "the first save never happened — the release arm measures nothing")
      .toHaveLength(1);

    await act(async () => { seen.release(); });
    await rerender(engine, typed(), { active: false });
    await act(async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); });

    expect(
      sent.map((m) => m.kind),
      "the close wrote back a message this surface had let go of",
    ).toEqual(["draft_save"]);
  });

  /**
   * THE ORDINARY CASE IS ADMITTED — the refusal above is keyed on the form, not on a latch, so a
   * message typed after a release is still a message. Every new-message door releases and then
   * seeds a form somebody is about to write in.
   */
  it("writes a form that was typed into after the release", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, typed());
    await settle();
    await act(async () => { seen.release(); });

    await rerender(engine, typed({ subject: "Saturday" }));
    await rerender(engine, typed({ subject: "Saturday" }), { active: false });
    await act(async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); });

    expect(
      sent.map((m) => (m as unknown as { subject: string }).subject),
      "a message written after the release was thrown away on the way out",
    ).toEqual(["Friday", "Saturday"]);
  });
});

/**
 * THE AUTOSAVE STRAGGLER OVER A SENT ROW (ruling §3 iii), driven once.
 * A save already on the wire when Send releases the composer reaches the server after the send made
 * the row `sent`, and the server now refuses it `409 draft_sent` instead of rewriting the record.
 * What renders: nothing. The refusal rolls the save back, nothing lists it as unsaved (it is not
 * abandoned), and the released composer holds no row, so it neither says a false sentence nor writes
 * again. The words that went are the ones the send PUT.
 */
describe("a save that lands after its message was sent", () => {
  it("is refused draft_sent, renders nothing on the released composer, and is not listed as unsaved", async () => {
    const { MutationRejectedError } = await import("@ohmail/client-engine");
    let holdSave: ((refuse: boolean) => void) | null = null;
    const engine = new OhmailEngine({
      adapter: adapterWith({
        mutate: async (m: EngineMutation) => {
          sent.push(m);
          const n = ++seq;
          if (m.kind === "draft_save" && m.draftId !== null) {
            const refuse = await new Promise<boolean>((r) => { holdSave = r; });
            if (refuse) {
              throw new MutationRejectedError("this message has already been sent; its words cannot be changed",
                { status: 409, code: "draft_sent", retryable: false });
            }
          }
          const id = m.kind === "draft_save" ? (m.draftId ?? `srv-${++minted}`) : "x";
          return {
            changes: [{ type: "draft", op: "update", id, seq: n, updatedAt: "2026-10-03T00:00:00.000Z",
              entity: { id, mailboxId: "mb-1", status: "draft" } }] as never,
            seq: n, entityId: id,
          };
        },
      }),
    });
    await mount(engine, typed());
    await settle();
    expect(seen.draftId).toBe("srv-1");
    await rerender(engine, typed({ body: "Are we still on? Bring the figures." }));
    await settle();
    expect(holdSave, "the straggler never reached the wire").not.toBeNull();
    // Send released the composer while the save was in the air; then the server refuses it.
    await act(async () => { seen.release(); });
    await act(async () => { holdSave!(true); for (let i = 0; i < 40; i += 1) await Promise.resolve(); });
    await settle();
    expect({
      draftId: seen.draftId,
      unsaved: engine.abandoned().length,
      puts: sent.filter((m) => m.kind === "draft_save" && m.draftId !== null).length,
    }).toEqual({ draftId: null, unsaved: 0, puts: 1 });
  });
});
