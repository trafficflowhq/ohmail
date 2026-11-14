/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import type { EngineMessage, Folder, RuleEntity as RuleDTO } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryMirrorStore, OhmailEngine,
  type SyncChange,
} from "@ohmail/client-engine";
import {
  ISO, act, goTo, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";
import { UNDO_MS } from "@ohmail/app-logic/screener/screener-state";

/**
 * Close the routing window, so the held rule is sent. A Move moves the mail now and holds the
 * sender's rule for `UNDO_MS`; the fixtures install a fake clock, so this is the real constant
 * advanced rather than waited out.
 */
const closeTheWindow = (): Promise<void> => tick(UNDO_MS + 1000);

/**
 * ═══ "MOVE → OHBOX" ON A MESSAGE IN READS DID NOTHING, TWICE ══════════════════════════════
 *
 * Reported against the shipped 0.19.0 desktop, with a screenshot: a newsletter in
 * Reads, Move → Ohbox, no action — pressed twice.
 *
 * Reads is not a folder that mail sits in. `consentPartition` PRESENTS a message at the place the
 * sender's rule names, so that newsletter was physically in the INBOX the whole time and the pile
 * was a projection over it. Both the strip that offers the destinations and the arm that acted on
 * one compared against that PRESENTED place, so "Ohbox" was offered and accepted; the folder move
 * they dispatched was INBOX→INBOX, which yields no effects, and the engine rejects an effectless
 * verb before the wire. The shell threw that answer away (`void`) and said "Moved to Ohbox."
 *
 * The fix is not a better sentence over the same nothing: the place is decided by the sender's
 * routing, so the press WRITES the routing — and on a mailbox organized in place the row then
 * moves with no folder touched at all.
 *
 * The shell mounted here is the shipped one and the engine is the real `OhmailEngine` over a real
 * mirror, in the standalone configuration the desktop bundles (`NEXT_PUBLIC_API_BASE` cleared, the
 * engine handed in — `desktop-cutline.test.ts` sets out why that IS the desktop here). The adapter
 * ECHOES what it is sent, the way a server confirms a write: without the echo the engine settles
 * every verb against an empty answer and rolls its overlay off, and this file would measure the
 * rollback rather than the press.
 */

const NEWS = "newsletter@example.invalid";
const READS: Folder = "ohmail/News" as Folder;
const INBOX: Folder = "INBOX" as Folder;

let seq = 0;

const message = (o: { id: string; from: string; folder?: Folder }): EngineMessage => ({
  id: o.id, accountId: "acct_local_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
  subject: `subject of ${o.id}`,
  from: { name: "Weekly Dispatch", address: o.from },
  to: [], cc: [], date: ISO, folder: o.folder ?? INBOX,
  snippet: `snippet of ${o.id}`, unread: false,
  hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
} as unknown as EngineMessage);

/** The sender's routing decision, as a rule row. Its store key IS its own id, as the server's is. */
const rule = (address: string, destination: string): RuleDTO => ({
  id: `rule_${address}`, kind: "sender", match: address, destination, priority: 0,
  provenance: "manual", enabled: true,
  stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
} as unknown as RuleDTO);

interface Rig {
  engine: OhmailEngine;
  /** Every verb the shell put on the wire, in order. */
  wire: Array<{ kind: string; [k: string]: unknown }>;
}

/**
 * @param routedTo  where the sender's rule sends their mail
 * @param physical  where the message actually sits on the server
 * @param refuse    a server that declines every write — the arm that proves the sentence follows
 *                  the answer rather than the press
 */
async function rig(routedTo: string, physical: Folder, refuse = false): Promise<Rig> {
  const store = new MemoryMirrorStore();
  await store.load();
  const ruleRow = rule(NEWS, routedTo);
  const messageRow = message({ id: "nl1", from: NEWS, folder: physical });
  await store.applyChanges([
    { type: "message", op: "create", id: "nl1", seq: ++seq, updatedAt: ISO,
      entity: messageRow } as unknown as SyncChange,
    { type: "rule", op: "create", id: ruleRow.id, seq: ++seq, updatedAt: ISO,
      entity: ruleRow } as unknown as SyncChange,
  ]);

  const wire: Rig["wire"] = [];
  const engine = new OhmailEngine({
    store,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: ISO,
      }),
      /** The server: it records the verb and echoes the row it changed. */
      mutate: async (m: { kind: string; [k: string]: unknown }) => {
        wire.push(m);
        if (refuse) throw Object.assign(new Error("refused"), { status: 403, code: "forbidden" });
        if (m.kind === "rule_update") {
          return { changes: [{ type: "rule", op: "update", id: String(m.ruleId), seq: ++seq, updatedAt: ISO,
            entity: { ...ruleRow, destination: String(m.destination), updatedAt: ISO } }], seq: null };
        }
        if (m.kind === "move") {
          return { changes: [{ type: "message", op: "update", id: String(m.messageId), seq: ++seq,
            updatedAt: ISO,
            entity: { ...messageRow, folder: m.folder as Folder, updatedAt: ISO } }], seq: null };
        }
        return { changes: [], seq: null };
      },
      fetchBody: async () => null,
    },
  } as never);
  return { engine, wire };
}

/** The shell, mounted as the organizer of this mailbox — which a local install is. */
async function open(engine: OhmailEngine, view: string): Promise<HTMLElement> {
  const c = await mountShell(
    [mailbox({ id: "mb_1", organizerRole: "organizer", lastSyncAt: ISO } as never)],
    { engine },
  );
  await tick(0);
  await goTo(view);
  await tick(0);
  return c;
}

const ids = (c: HTMLElement): string[] =>
  [...c.querySelectorAll("[data-id]")].map((n) => n.getAttribute("data-id") ?? "");

const toasts = (): string[] =>
  [...document.querySelectorAll(".fr-report [role=status]")].map((n) => (n.textContent ?? "").trim()).filter(Boolean);

/** Expand the Newsletter, press Move, then take the first destination. */
async function pressMoveToOhbox(c: HTMLElement): Promise<string[]> {
  const stream = within(c).getByRole("region", { name: "News stream" });
  const expand = within(stream).getByRole("button", { name: "Expand" });
  await act(async () => { expand.click(); });
  await tick(10);
  const panel = within(c).getByRole("toolbar", { name: "Actions" });
  let move = within(panel).queryByRole("button", { name: "Move" });
  if (move === null) {
    await act(async () => { within(panel).getByRole("button", { name: "More" }).click(); });
    move = within(c).getByRole("menuitem", { name: "Move" });
  }
  await act(async () => { move.click(); });
  await tick(10);
  const menu = within(c).getByRole("menu", { name: "Move" });
  const destinations = within(menu).getAllByRole("menuitem");
  const dests = destinations.map((button) => (button.textContent ?? "").trim());
  expect(dests[0], "Ohbox is not the first destination").toContain("Ohbox");
  await act(async () => { destinations[0]!.click(); });
  await tick(50);
  return dests;
}

describe("Move → Ohbox, from a pile the router owns", () => {
  beforeEach(() => {
    installShellEnv();
    // The desktop's answer to `apiConfigured()`, reproduced through the real module.
    process.env.NEXT_PUBLIC_API_BASE = "";
  });
  afterEach(async () => {
    await teardownShellEnv();
    process.env.NEXT_PUBLIC_API_BASE = "/api";
  });

  it("the press writes the sender's routing, and the message leaves Reads", async () => {
    /* FILED by the router since ARCH-R902: a rule no longer presents an unmoved
       INBOX letter in Reads (the next case), so the pile this press starts from is one the
       router filed into — the consumer this defended, the routing written by a Move press. */
    const { engine, wire } = await rig(READS, READS);
    const c = await open(engine, "reads");

    expect(engine.read().get<EngineMessage>("message", "nl1")?.folder).toBe(READS);
    expect(ids(c), "the newsletter is not in Reads").toContain("nl1");

    const dests = await pressMoveToOhbox(c);
    expect(dests[0], "Ohbox is not the strip's first destination").toContain("Ohbox");

    /* THE ROUTING IS HELD: the letter's own move goes now and the rule waits for the window. */
    expect(wire.map((m) => m.kind), "a rule went out inside the undo window").not.toContain("rule_update");

    expect(ids(c), "the newsletter is still in Reads").not.toContain("nl1");
    await goTo("ohbox");
    await tick(0);
    expect(ids(c), "the newsletter never arrived in the Ohbox").toContain("nl1");

    // ONE sentence, and it states both halves: this mail, and the mail still to come.
    const said = toasts().join(" ");
    expect(said).toContain("Ohbox");
    expect(said, "the sentence says nothing about future mail").toMatch(/future mail/i);

    /* THE FIX, once the window closes: the routing is what decides the place, so the routing is
       what the press writes. Before it this array was EMPTY for ever — the folder move was
       INBOX→INBOX, so the engine computed no effects and rejected the verb before the wire. */
    await closeTheWindow();
    expect(wire.map((m) => m.kind), "the sender's routing never reached the wire").toContain("rule_update");
    expect(wire.find((m) => m.kind === "rule_update")?.destination).toBe(INBOX);
  });

  it("an INBOX letter its Reads rule never moved is in the Ohbox, not in Reads", async () => {
    // INVERTED by ARCH-R902: the reported state — in the INBOX, shown in Reads.
    const { engine } = await rig(READS, INBOX);
    const c = await open(engine, "reads");
    expect(ids(c)).not.toContain("nl1");
    await goTo("ohbox");
    await tick(0);
    expect(ids(c)).toContain("nl1");
  });

  it("says what the server answered, never what the press hoped", async () => {
    const { engine, wire } = await rig(READS, READS, true);
    const c = await open(engine, "reads");
    await pressMoveToOhbox(c);
    /* THE REFUSAL IS THE WINDOW'S TO REPORT: the press said what it did, and only the server's
       answer — seconds later — can contradict it. */
    await closeTheWindow();

    expect(wire.map((m) => m.kind)).toContain("rule_update");
    const said = toasts().join(" ");
    // The shipped defect's sentence, over a write the server refused.
    expect(said, "a refused press still claims the message moved").not.toContain("Moved to Ohbox.");
    expect(said, "a refused press does not say the rule failed").toMatch(/couldn't be made|unchanged/i);
  });

  it("moves the mail too when it really is filed elsewhere, and counts what moved", async () => {
    /* FOLDERS ON: the newsletter physically sits in `ohmail/News`, so the press owes a real move
       as well as the routing. Without the routing half the move lands and the next partition files
       the row straight back into Reads — the sender's rule still says Reads — which is the same
       "nothing happened" from the other direction. */
    const { engine, wire } = await rig(READS, READS);
    const c = await open(engine, "reads");
    expect(ids(c)).toContain("nl1");

    await pressMoveToOhbox(c);
    // Read while it is on screen: the Undo capsule leaves the tree once its window has closed.
    const said = toasts().join(" ");

    /* THE MAIL GOES NOW AND THE ROUTING WAITS — the two halves of one press. */
    expect(wire.map((m) => m.kind), "the message itself was never moved").toContain("move");
    expect(wire.map((m) => m.kind), "a rule went out inside the undo window").not.toContain("rule_update");
    expect(wire.find((m) => m.kind === "move")?.folder).toBe(INBOX);
    await closeTheWindow();
    expect(wire.map((m) => m.kind), "the sender's routing never reached the wire").toContain("rule_update");

    /* The move is dispatched beside the rule and settles on its own turn — the rule is the awaited
       half, so the row lands one drain later than the sentence. */
    await tick(1000);
    expect(ids(c), "the newsletter is still in Reads").not.toContain("nl1");
    await goTo("ohbox");
    await tick(0);
    expect(ids(c), "the newsletter never arrived in the Ohbox").toContain("nl1");

    expect(said, "the sentence does not count the message it moved").toMatch(/1 message/);
    expect(said).toMatch(/future mail/i);
  });
});
