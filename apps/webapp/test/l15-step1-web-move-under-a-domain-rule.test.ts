/* STEP 1 measurement (L15) row 118, harness copied from move-from-a-pile.test.ts. */
/** @vitest-environment jsdom */
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
let DOMAIN_RULE: RuleDTO | null = null;

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
  const ruleRow = DOMAIN_RULE ?? rule(NEWS, routedTo);
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
  [...document.querySelectorAll("[class*=toast]")].map((n) => (n.textContent ?? "").trim()).filter(Boolean);

/** The reported gesture: expand the card, press Move, press the first destination (Ohbox). */
async function pressMoveToOhbox(c: HTMLElement): Promise<string[]> {
  const expand = c.querySelector<HTMLElement>(".sc-x");
  if (expand) { await act(async () => { expand.click(); }); await tick(10); }
  const move = c.querySelector<HTMLElement>(".abar-move");
  expect(move, "the card offers no Move verb").toBeTruthy();
  await act(async () => { move!.click(); });
  await tick(10);
  const dests = [...c.querySelectorAll(".abar-panel .abar-solo")].map((b) => (b.textContent ?? "").trim());
  const first = c.querySelector<HTMLElement>(".abar-panel .abar-solo");
  expect(first, "the Move strip offers no destination").toBeTruthy();
  await act(async () => { first!.click(); });
  await tick(50);
  return dests;
}

describe("row 118 FIX-024-WEB-MOVE-UNDER-A-HIGHER-PRIORITY-DOMAIN-RULE", () => {
  beforeEach(() => { installShellEnv(); process.env.NEXT_PUBLIC_API_BASE = ""; });
  afterEach(async () => { await teardownShellEnv(); process.env.NEXT_PUBLIC_API_BASE = "/api"; DOMAIN_RULE = null; });

  it("a Move out of News under a priority-5 domain rule writes an address rule that outranks it", async () => {
    DOMAIN_RULE = { ...rule("example.invalid", READS), id: "rule_domain", kind: "domain", priority: 5 } as RuleDTO;
    const { engine, wire } = await rig(READS, READS);
    const c = await open(engine, "reads");
    expect(ids(c)).toContain("nl1");
    await pressMoveToOhbox(c);
    await closeTheWindow();
    const made = wire.find((m) => m.kind === "rule_create");
    expect(made, JSON.stringify(wire)).toMatchObject({ ruleKind: "sender", match: NEWS, destination: INBOX });
    expect(Number(made!.priority ?? 0), "the address rule loses to its domain's").toBeGreaterThanOrEqual(5);
  });
});
