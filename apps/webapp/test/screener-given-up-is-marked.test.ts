/** @vitest-environment jsdom */
/**
 * A SCREENER DECISION THE OUTBOX GAVE UP ON COMES BACK MARKED, NEVER LOOKING UNDECIDED.
 *
 * Eight answers the server gave and nobody modelled (an unhandled 500 each) and the outbox gives
 * the decision up: its overlay goes and the sender is back in Waiting. The Screener had been told
 * `queued`, so its refused mark was never set, and the row looked like a decision never made — the
 * Unsaved changes panel was the only place that said otherwise. The row now carries "Not saved"
 * for as long as the given-up record stands: Discard and Try again end it, and so does a new
 * decision about the sender (it supersedes the record). A decision the person withdrew themselves
 * comes back unmarked: nothing was refused.
 *
 * Mutations: the accessor reading `s.refused` alone → case 4 red; `givenUpRowIds` ignoring
 * `superseded` → case 2 red; matching a decide by its row id alone → case 1's re-minted row red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryMirrorStore, MutationRejectedError, OhmailEngine, OUTBOX_MAX_SERVER_FAILURES,
  type EngineMutation, type ScreenerSenderDTO,
} from "@ohmail/client-engine";
import { givenUpRowIds } from "../app/shell/screener-given-up";
import {
  ISO, goTo, installShellEnv, mailbox, mountShell, teardownShellEnv, tick, act,
} from "./fixtures/live-walk-shell";
import messages from "../messages/en.json";

const NOW = "2026-10-23T09:00:00.000Z";
const SCREENER = "ohmail/Screener";

// ── the engine and the pure half ────────────────────────────────────────────────────────────

const heldMsg = (id: string, address: string) => ({
  id, accountId: "acct_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
  subject: `subject of ${id}`, from: { name: `Sender ${id}`, address },
  to: [], cc: [], date: NOW, folder: SCREENER, snippet: "…", unread: true,
  hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null, labels: [],
  remoteContent: "none", updatedAt: NOW,
});

/** A waiting row as the Screener derives it: its representative, the sender, the held bag. */
const row = (id: string, address: string, held: string[] = [id]) =>
  ({ id, from: { name: null, address }, derived: true, held: held.map((h) => ({ id: h })) }) as unknown as ScreenerSenderDTO;

async function engineThatRefuses() {
  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  const state = { refuse: true };
  const engine = new OhmailEngine({
    store,
    now: () => new Date(NOW),
    adapter: {
      sync: async () => ({
        changes: {
          creates: seq > 0 ? [] : [
            { type: "message", id: "s1", entity: heldMsg("s1", "ada@example.invalid") },
            { type: "message", id: "s2", entity: heldMsg("s2", "bo@example.invalid") },
          ].map((c) => ({ ...c, op: "create", seq: ++seq, updatedAt: NOW })),
          updates: [], moves: [], deletes: [],
        },
        cursor: String(seq), hasMore: false, serverTime: NOW,
      }),
      fetchBody: async () => null,
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      mutate: async () => {
        if (state.refuse) throw new MutationRejectedError("internal error", { status: 500, code: "internal", retryable: true });
        return { changes: [], seq: null };
      },
    } as never,
  });
  await engine.start();
  return { engine, state };
}

/** Press once, then Try again until the outbox gives up — eight answers from the server. */
async function giveUp(engine: OhmailEngine, m: EngineMutation): Promise<string> {
  const first = await engine.mutate(m);
  expect(first.status).toBe("queued");
  for (let i = 1; i < OUTBOX_MAX_SERVER_FAILURES; i++) await engine.retryQueued(first.id);
  expect(engine.abandoned().map((a) => a.id), "the outbox did not give up").toContain(first.id);
  return first.id;
}

const decide = (senderId: string): EngineMutation =>
  ({ kind: "screener_decide", senderId, decision: "yes", dest: "ohbox", scope: "sender" }) as EngineMutation;

describe("givenUpRowIds — the rows whose decision the outbox gave up on", () => {
  it("1 — a decide given up on marks its row, and the sender's row re-minted on newer mail", async () => {
    const { engine } = await engineThatRefuses();
    await giveUp(engine, decide("s1"));
    expect([...givenUpRowIds(engine.abandoned(), [row("s1", "ada@example.invalid"), row("s2", "bo@example.invalid")])])
      .toEqual(["s1"]);
    // A newer letter from the same sender re-mints the row under another representative.
    expect([...givenUpRowIds(engine.abandoned(), [row("s9", "ada@example.invalid", ["s1", "s9"])])]).toEqual(["s9"]);
  });

  it("2 — a new decision about the sender supersedes the record, and the mark goes with it", async () => {
    const { engine, state } = await engineThatRefuses();
    await giveUp(engine, decide("s1"));
    state.refuse = false;
    expect((await engine.mutate(decide("s1"))).status).toBe("confirmed");
    expect(engine.abandoned().find((a) => a.mutation.kind === "screener_decide")?.superseded).toBe(true);
    expect(givenUpRowIds(engine.abandoned(), [row("s1", "ada@example.invalid")]).size, "a superseded record still marks").toBe(0);
  });

  it("3 — CONTROL: a decision the person withdrew is no refusal, and leaves no mark", async () => {
    const { engine } = await engineThatRefuses();
    const queued = await engine.mutate(decide("s2"));
    expect(queued.status).toBe("queued");
    expect(await engine.withdrawQueued(queued.key)).toBe("withdrawn");
    expect(givenUpRowIds(engine.abandoned(), [row("s2", "bo@example.invalid")]).size).toBe(0);
  });

  it("4 — a rule given up on marks the sender's row, or the domain's rows; a sliced rule marks nothing", async () => {
    const { engine } = await engineThatRefuses();
    await giveUp(engine, { kind: "rule_create", ruleKind: "sender", match: "ada@example.invalid", destination: "INBOX" } as EngineMutation);
    const rows = [row("s1", "Ada@Example.invalid"), row("s2", "bo@example.invalid"), row("s3", "cy@other.invalid")];
    expect([...givenUpRowIds(engine.abandoned(), rows)]).toEqual(["s1"]);

    const domain = await engineThatRefuses();
    await giveUp(domain.engine, { kind: "rule_create", ruleKind: "domain", match: "example.invalid", destination: "INBOX" } as EngineMutation);
    expect([...givenUpRowIds(domain.engine.abandoned(), rows)].sort()).toEqual(["s1", "s2"]);

    const sliced = await engineThatRefuses();
    await giveUp(sliced.engine, {
      kind: "rule_create", ruleKind: "sender", match: "ada@example.invalid", destination: "INBOX", subjectContains: "Invoice",
    } as EngineMutation);
    expect(givenUpRowIds(sliced.engine.abandoned(), rows).size, "a slice of a sender's mail is no decision about them").toBe(0);
  });
});

// ── the shipped shell ───────────────────────────────────────────────────────────────────────

interface Change { type: string; op: string; id: string; seq: number; updatedAt: string; entity: unknown }

/** The server: a held sender at the gate, and a decide that answers 500 until told otherwise. */
class World {
  seq = 0;
  log: Change[] = [];
  decides = 0;
  refuse = true;
  add(id: string, from: string): void {
    this.log.push({
      type: "message", op: "create", id, seq: ++this.seq, updatedAt: ISO,
      entity: { ...heldMsg(id, from), accountId: "acct_live_1", date: "2026-08-03T09:00:00.000Z", updatedAt: ISO },
    });
  }
  decide(id: string): Response {
    this.decides += 1;
    if (this.refuse) {
      return new Response(JSON.stringify({ error: { code: "internal", message: "internal error" } }),
        { status: 500, headers: { "content-type": "application/json" } });
    }
    const m = this.log.find((c) => c.id === id);
    if (m) {
      this.log.push({ ...m, op: "move", seq: ++this.seq, entity: { ...(m.entity as object), folder: "INBOX" } });
    }
    return new Response(JSON.stringify({ messageId: id, appliedFolder: "INBOX" }),
      { status: 200, headers: { "content-type": "application/json", "X-Sync-Seq": String(this.seq) } });
  }
  syncFrom(since: string): Response {
    const rows = this.log.filter((c) => c.seq > (Number(since) || 0));
    return new Response(JSON.stringify({
      changes: {
        creates: rows.filter((c) => c.op === "create"), updates: [],
        moves: rows.filter((c) => c.op === "move"), deletes: [],
      },
      cursor: String(this.seq), hasMore: false, serverTime: ISO,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
}

let w: World;
const ALPHA = "aaa1";

function installWorld(): void {
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/sync")) return w.syncFrom(new URL(url, "http://x").searchParams.get("since") ?? "0");
    if (url.includes("/consent")) {
      return new Response(JSON.stringify({
        seedConfirmedAt: ISO, screeningResetAt: null, dormancyDays: 60,
        counts: { decidedSenders: 0, activeUndecidedSenders: 0, dormantUndecidedSenders: 0 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const scn = /\/screener\/([^/?]+)$/.exec(url);
    if (scn && (init?.method ?? "GET") === "POST") return w.decide(scn[1]!);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

const rowText = (c: HTMLElement, id: string): string | null =>
  c.querySelector(`.row[data-id="${id}"]`)?.textContent ?? null;

/** File a row to the Ohbox through its own quick-adjust menu, then leave so the commit fires. */
async function decideToOhbox(c: HTMLElement, id: string): Promise<void> {
  const slot = c.querySelector(`.row[data-id="${id}"]`)?.closest(".row-slot");
  if (!slot) throw new Error(`no row ${id}`);
  slot.querySelector<HTMLButtonElement>(".scn-act-more")!.click();
  await tick(0);
  slot.querySelectorAll<HTMLButtonElement>(".scn-act-dest")[0]!.click();
  await tick(400);
  await goTo("ohbox");
  await tick(200);
}

/** The shell's Unsaved changes strip, opened: its rows. */
async function stripRows(c: HTMLElement): Promise<HTMLElement[]> {
  const strip = c.querySelector<HTMLElement>(".unsaved-shell");
  if (strip === null) return [];
  const toggle = strip.querySelector<HTMLButtonElement>(".unsaved-toggle");
  if (toggle?.getAttribute("aria-expanded") === "false") { await act(async () => { toggle.click(); }); await tick(0); }
  return [...(c.querySelector(".unsaved-shell")?.querySelectorAll<HTMLElement>(".unsaved-row") ?? [])];
}
const buttonIn = (el: HTMLElement, label: string): HTMLButtonElement | null =>
  [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.textContent ?? "").trim() === label) ?? null;

describe("in the shipped shell", () => {
  beforeEach(() => {
    installShellEnv();
    // A decision left in its Undo window is journalled for the next boot; each case boots clean.
    window.localStorage.clear();
    window.sessionStorage.clear();
    w = new World();
    w.add(ALPHA, "alpha@example.invalid");
    installWorld();
  });
  afterEach(teardownShellEnv);

  it("5 — eight 500s from the panel's Try again, and the sender is back in Waiting marked Not saved", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("screener");
    await tick(50);
    expect(rowText(c, ALPHA), "the sender is not waiting").not.toBeNull();
    await decideToOhbox(c, ALPHA);
    expect(w.decides, "the decision never reached the wire").toBe(1);

    // Waiting in the panel with the server's answer, and pressed again until the outbox gives up.
    for (let i = 1; i < OUTBOX_MAX_SERVER_FAILURES; i++) {
      const [waiting] = await stripRows(c);
      expect(waiting?.textContent, "the queued decision is not listed").toContain(messages.sync.unsavedKindScreener);
      await act(async () => { buttonIn(waiting!, messages.sync.unsavedRetry)!.click(); });
      await tick(50);
    }
    expect(w.decides).toBe(OUTBOX_MAX_SERVER_FAILURES);

    await goTo("screener");
    await tick(200);
    expect(rowText(c, ALPHA), "the given-up sender is not back in Waiting").not.toBeNull();
    expect(rowText(c, ALPHA), "the given-up decision came back looking undecided").toContain(messages.screener.rowNotSaved);

    // A new decision about the sender clears the mark in the same frame.
    w.refuse = false;
    const slot = c.querySelector(`.row[data-id="${ALPHA}"]`)!.closest(".row-slot")!;
    slot.querySelector<HTMLButtonElement>(".scn-act-more")!.click();
    await tick(0);
    slot.querySelectorAll<HTMLButtonElement>(".scn-act-dest")[0]!.click();
    await tick(0);
    expect(rowText(c, ALPHA) ?? "", "the mark outlived the new decision").not.toContain(messages.screener.rowNotSaved);
    // …and once it lands the given-up record is superseded: the sender is decided, nothing marked.
    await tick(400);
    await goTo("ohbox");
    await tick(200);
    await goTo("screener");
    await tick(200);
    expect(rowText(c, ALPHA), "the new decision did not land").toBeNull();
    expect(c.textContent, "a stale mark outlived the decision that replaced it").not.toContain(messages.screener.rowNotSaved);
  }, 60_000);

  it("6 — CONTROL: a decision discarded from the panel comes back unmarked", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("screener");
    await tick(50);
    await decideToOhbox(c, ALPHA);
    const [waiting] = await stripRows(c);
    await act(async () => { buttonIn(waiting!, messages.sync.unsavedDiscard)!.click(); });
    await tick(50);
    await goTo("screener");
    await tick(200);
    expect(rowText(c, ALPHA), "the withdrawn decision's sender did not come back").not.toBeNull();
    expect(rowText(c, ALPHA), "a decision the person withdrew was marked as refused").not.toContain(messages.screener.rowNotSaved);
  }, 60_000);
});
