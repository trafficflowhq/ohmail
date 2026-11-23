/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ISO, act, goTo, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
  liveAccountResponse,
} from "./fixtures/live-walk-shell";
import {
  releaseScreenerRow,
  screenerReport as toastText,
  screenerRowIds as rowIds,
  selectScreenerRow as selectRow,
} from "./fixtures/live-screener";

/**
 * RELEASING A SENDER A RULE IS HOLDING — the rule is the thing that has to change.
 *
 * ## THE LIVE SHAPE THIS CARRIES
 *
 * Measured on a production account, 2026-08-19. A sender carried an enabled
 * `sender` rule with `destination: "ohmail/Quarantine"`. The consent cutline presents a decided
 * sender's undecided-residence mail AT THE RULE'S DESTINATION (`consent-cutline.ts` — `decided
 * !== null ⇒ placeOf = decided`), so their INBOX and Screener mail all presented in Spam beside
 * the mail physically quarantined — the row said "25 held". Every press of "Not spam → Ohbox"
 * answered *"sender@example.test is still in Spam — that change could not be saved. Try it again."*,
 * for two defects that compound:
 *
 *  1. the release issued a bare `move` for EVERY held id. For mail already physically at the
 *     destination (`INBOX`), `mutationEffects` answers no effects (`msg.folder === m.folder`),
 *     `Engine.mutate` rolls back locally with a 404 AND NOTHING SENT — so `moveAll` reported the
 *     release refused, forever, deterministically;
 *  2. even the moves that landed changed nothing on screen: the RULE was never touched, and the
 *     projection re-presented the moved mail straight back into Spam. Retrying could not help —
 *     and adding an allow rule instead would not either, because `core/src/rules.ts#compareRules`
 *     ranks deny over allow at equal priority, so the standing deny rule keeps winning ingest.
 *
 * `screener-reversal-holds.test.ts` measured half of this while it was being written — its header
 * documents that a fixture rule pointing at Quarantine "makes the cutline present the sender's
 * INBOX mail back in Spam, so a release that SUCCEEDED left the row exactly where a refused one
 * does" — and then deliberately emitted no rules so its own subject (watched moves) stayed
 * observable. This file is the other half: worlds WITH such a rule, asserting the release
 * REWRITES it.
 *
 * ## WHAT A RELEASE MUST DO NOW
 *
 *  · "Not spam → Ohbox" / "Allow" RETARGETS every enabled, term-free rule filing this sender at
 *    the segment's folder (`rule_update` → the pressed destination) — one rule row flips both the
 *    presentation and future ingest, and the server's retro pass walks the backlog;
 *  · "Not spam → Screener" DELETES those rules — back to Waiting means undecided, and no rule may
 *    point at the gate;
 *  · moves are issued ONLY for mail physically in the segment's folder. Mail presented here by
 *    the rule alone needs no move once the rule is gone — and asking for one is the local 404 of
 *    defect 1;
 *  · the rule half is WATCHED like the moves: a refused retarget marks the row "Not saved" and
 *    raises the refusal sentence.
 */

const QUARANTINE = "ohmail/Quarantine";
const SCREENED = "ohmail/Screened";
const GATE = "ohmail/Screener";

interface Msg { id: string; from: string; folder: string; date: string; subject?: string }
interface RuleRow {
  id: string; kind: "sender" | "domain"; match: string; destination: string;
  subjectContains?: string | null;
}
interface Change { type: string; op: string; id: string; seq: number; updatedAt: string; entity: unknown }

class World {
  seq = 0;
  msgs = new Map<string, Msg>();
  rules = new Map<string, RuleRow>();
  log: Change[] = [];
  posts: string[] = [];
  patches: string[] = [];
  deletes: string[] = [];
  /** Refuse every `PATCH /rules/:id` — the watched-rule-half case. */
  refuseRulePatch = false;
  /** Answer every move this many ms later, or refuse it — the move half's two other endings. */
  moveDelayMs = 0;
  refuseMove = false;

  private entityOf(m: Msg): unknown {
    return {
      id: m.id, accountId: "acct_live_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
      subject: m.subject ?? `subject of ${m.id}`,
      from: { name: `Sender ${m.id}`, address: m.from },
      to: [], cc: [], date: m.date, folder: m.folder, snippet: `snippet of ${m.id}`,
      unread: true, hasAttachments: false, attachmentCount: 0, sensitivity: {},
      triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
    };
  }

  private ruleEntityOf(r: RuleRow): unknown {
    return {
      id: r.id, kind: r.kind, match: r.match, destination: r.destination, priority: 0,
      provenance: "manual", enabled: true,
      subjectContains: r.subjectContains ?? null, bodyContains: null,
      stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
    };
  }

  add(m: Msg): void {
    this.msgs.set(m.id, m);
    this.log.push({ type: "message", op: "create", id: m.id, seq: ++this.seq, updatedAt: ISO, entity: this.entityOf(m) });
  }

  addRule(r: RuleRow): void {
    this.rules.set(r.id, r);
    this.log.push({ type: "rule", op: "create", id: r.id, seq: ++this.seq, updatedAt: ISO, entity: this.ruleEntityOf(r) });
  }

  private move(id: string, folder: string): void {
    const m = this.msgs.get(id);
    if (!m) return;
    m.folder = folder;
    this.log.push({ type: "message", op: "move", id, seq: ++this.seq, updatedAt: ISO, entity: this.entityOf(m) });
  }

  moveOne(id: string, folder: string): Response {
    const m = this.msgs.get(id);
    if (!m) {
      return new Response(JSON.stringify({ error: { code: "not_found", message: "message not found" } }),
        { status: 404, headers: { "content-type": "application/json" } });
    }
    this.move(id, folder);
    return new Response(JSON.stringify(this.entityOf(m)),
      { status: 200, headers: { "content-type": "application/json", "X-Sync-Seq": String(this.seq) } });
  }

  patchRule(id: string, destination: string, release?: { messageIds: string[]; to: string }): Response {
    if (this.refuseRulePatch) {
      return new Response(JSON.stringify({ error: { code: "forbidden", message: "no" } }),
        { status: 403, headers: { "content-type": "application/json" } });
    }
    const r = this.rules.get(id);
    if (!r) {
      return new Response(JSON.stringify({ error: { code: "not_found", message: "rule not found" } }),
        { status: 404, headers: { "content-type": "application/json" } });
    }
    if (release && this.refuseMove) {
      return new Response(JSON.stringify({ error: { code: "conflict", message: "no" } }),
        { status: 409, headers: { "content-type": "application/json" } });
    }
    for (const id of release?.messageIds ?? []) {
      this.posts.push(`move ${id} → ${release!.to}`);
      this.move(id, release!.to);
    }
    r.destination = destination;
    this.log.push({ type: "rule", op: "update", id, seq: ++this.seq, updatedAt: ISO, entity: this.ruleEntityOf(r) });
    return new Response(JSON.stringify(this.ruleEntityOf(r)),
      { status: 200, headers: { "content-type": "application/json", "X-Sync-Seq": String(this.seq) } });
  }

  deleteRule(id: string): Response {
    const r = this.rules.get(id);
    if (!r) {
      return new Response(JSON.stringify({ error: { code: "not_found", message: "rule not found" } }),
        { status: 404, headers: { "content-type": "application/json" } });
    }
    this.rules.delete(id);
    this.log.push({ type: "rule", op: "delete", id, seq: ++this.seq, updatedAt: ISO, entity: null });
    return new Response("{}",
      { status: 200, headers: { "content-type": "application/json", "X-Sync-Seq": String(this.seq) } });
  }

  syncFrom(since: string): Response {
    const from = Number(String(since).replace(/^c/, "")) || 0;
    const rows = this.log.filter((c) => c.seq > from);
    return new Response(JSON.stringify({
      changes: {
        creates: rows.filter((c) => c.op === "create"),
        updates: rows.filter((c) => c.op === "update"),
        moves: rows.filter((c) => c.op === "move"),
        deletes: rows.filter((c) => c.op === "delete"),
      },
      cursor: String(this.seq), hasMore: false, serverTime: ISO,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
}

let w: World;

function installWorld(): void {
  const respond = async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/sync")) {
      return w.syncFrom(new URL(url, "http://x").searchParams.get("since") ?? "0");
    }
    if (url.includes("/consent")) {
      return new Response(JSON.stringify({
        seedConfirmedAt: ISO, screeningResetAt: null, dormancyDays: 60,
        counts: { decidedSenders: 1, activeUndecidedSenders: 0, dormantUndecidedSenders: 0 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const mv = /\/messages\/([^/?]+)\/move$/.exec(url);
    if (mv && method === "POST") {
      const folder = (JSON.parse(String(init?.body ?? "{}")) as { folder?: string }).folder ?? "";
      w.posts.push(`move ${mv[1]} → ${folder}`);
      if (w.refuseMove) {
        return new Response(JSON.stringify({ error: { code: "conflict", message: "no" } }),
          { status: 409, headers: { "content-type": "application/json" } });
      }
      if (w.moveDelayMs > 0) await new Promise((r) => setTimeout(r, w.moveDelayMs));
      return w.moveOne(mv[1]!, folder);
    }
    const rl = /\/rules\/([^/?]+)$/.exec(url);
    if (rl && method === "PATCH") {
      const { destination, release } = JSON.parse(String(init?.body ?? "{}")) as {
        destination: string; release?: { messageIds: string[]; to: string };
      };
      w.patches.push(`rule ${rl[1]} → ${destination}`);
      if (w.moveDelayMs > 0) await new Promise((r) => setTimeout(r, w.moveDelayMs));
      return w.patchRule(rl[1]!, destination, release);
    }
    if (rl && method === "DELETE") {
      w.deletes.push(`rule ${rl[1]}`);
      return w.deleteRule(rl[1]!);
    }
    return new Response("{}", { status: 200 });
  };
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    liveAccountResponse(await respond(input, init)));
}


/**
 * The production shape, verbatim: the sender's NEWEST mail ("WG: Herbstaktion") physically in the
 * INBOX, older mail physically at the gate, older still physically in Quarantine — and one
 * enabled sender rule filing the address to Quarantine, which is what presents all three in Spam.
 * The derived row is minted on the newest presented message, so its id is the INBOX one: the
 * message a bare `move` to INBOX can only ever answer with the local 404.
 */
const SENDER = "news@aktionen.example";
const REP = "wg-herbstaktion";
const AT_GATE = "gate-older";
const QUARANTINED = "spam-oldest";
const SPAM_RULE = "rule-aktionen-spam";

function seedRuledSpammer(): void {
  w = new World();
  w.add({ id: REP, from: SENDER, folder: "INBOX", date: "2026-08-04T12:47:06.000Z", subject: "WG: Herbstaktion" });
  w.add({ id: AT_GATE, from: SENDER, folder: GATE, date: "2026-08-03T15:18:21.000Z", subject: "Herbstaktion" });
  w.add({ id: QUARANTINED, from: SENDER, folder: QUARANTINE, date: "2026-08-01T17:58:54.000Z", subject: "WG: Letzter Aufruf Sonderverkauf Herbst" });
  w.addRule({ id: SPAM_RULE, kind: "sender", match: SENDER, destination: QUARANTINE });
}

async function openSegment(segment: "spam" | "screened"): Promise<HTMLElement> {
  const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
  await tick(0);
  await goTo(`screener/${segment}`);
  await tick(200);
  return c;
}

describe("releasing a sender a RULE holds in Spam", () => {
  beforeEach(() => {
    installShellEnv();
    seedRuledSpammer();
    installWorld();
  });
  afterEach(teardownShellEnv);

  it("'Not spam → Ohbox' retargets the rule, moves only the quarantined mail, and the release sticks", async () => {
    const c = await openSegment("spam");
    expect(rowIds(c), "the rule-held sender did not present in Spam").toContain(REP);

    await selectRow(c, REP);
    releaseScreenerRow(c, "ohbox");
    await tick(200);

    // The DURABLE half: the deny rule now points at the Ohbox. Without this the projection puts
    // every moved message straight back into Spam, and future mail keeps arriving quarantined —
    // deny outranks allow at equal priority, so a second rule could never have won.
    expect(w.patches, "the holding rule was not retargeted").toEqual([`rule ${SPAM_RULE} → INBOX`]);
    // Moves ONLY for mail physically in Quarantine. A move for the INBOX-physical representative
    // is the engine's local refusal (already at the destination) — the exact refusal that made this
    // release fail deterministically on a live account.
    expect(w.posts, "the release moved mail the rule change already covers").toEqual([`move ${QUARANTINED} → INBOX`]);

    expect(rowIds(c), "the released sender is still listed in Spam").not.toContain(REP);
    expect(c.textContent, "a successful release claimed a failure").not.toContain("Not saved");
    expect(toastText(), "a successful release raised the refusal sentence").not.toContain("could not be saved");
    // Claims are contracts: the rule WAS rewritten, so the no-rule sentence would be false here.
    expect(toastText(), "the toast denies the rule rewrite it just made").not.toContain("future mail is unchanged");

    // And it STAYS released across the next authoritative drain — the live defect's second half
    // was precisely a release that looked done until the projection re-presented the mail.
    await tick(400);
    expect(rowIds(c), "the release did not survive the next drain").not.toContain(REP);
  }, 30000);

  it("'Not spam → Screener' deletes the rule — back to Waiting means undecided", async () => {
    const c = await openSegment("spam");
    await selectRow(c, REP);
    releaseScreenerRow(c, "waiting");
    await tick(200);

    // The rule change waits out the Undo offer, and is written when it closes.
    expect(w.deletes, "the rule was removed before the Undo offer closed").toEqual([]);
    await tick(9000);
    expect(w.deletes, "the holding rule was not deleted").toEqual([`rule ${SPAM_RULE}`]);
    expect(w.patches, "back-to-Waiting retargeted a rule instead of deleting it").toEqual([]);
    // Only the quarantined message needs a physical move to the gate; the INBOX mail presents
    // there by the cutline the moment the sender is undecided again.
    expect(w.posts).toEqual([`move ${QUARANTINED} → ${GATE}`]);

    expect(rowIds(c), "the sender is still listed in Spam").not.toContain(REP);
    expect(toastText()).not.toContain("could not be saved");
  }, 30000);

  it("a refused rule retarget marks the row and says so — the rule half is watched", async () => {
    w.refuseRulePatch = true;
    const c = await openSegment("spam");
    await selectRow(c, REP);
    releaseScreenerRow(c, "ohbox");
    await tick(200);

    expect(w.patches, "no retarget was even attempted").toEqual([`rule ${SPAM_RULE} → INBOX`]);
    expect(rowIds(c), "the refused release dropped the row anyway").toContain(REP);
    expect(c.textContent, "the returned row carries no refusal note").toContain("Not saved");
    expect(toastText(), "no toast reported the refusal").toContain("could not be saved");
  }, 30000);
});

describe("the release's Undo offer and its moves", () => {
  beforeEach(() => {
    installShellEnv();
    seedRuledSpammer();
    installWorld();
  });
  afterEach(teardownShellEnv);

  it("the window runs from the moment the offer appears, not from the press", async () => {
    w.moveDelayMs = 3000;
    const c = await openSegment("spam");
    await selectRow(c, REP);
    releaseScreenerRow(c, "ohbox");
    await tick(3200);
    expect(toastText(), "no Undo offer once the move landed").toContain("Undo");
    expect(w.patches).toEqual([`rule ${SPAM_RULE} → INBOX`]);
    // Inside the offer's window even though the time since the original press exceeds it.
    await tick(6000);
    await act(() => {
      const report = document.querySelector('.fr-report [role="status"]:not([data-leaving])')!;
      (report.querySelector("button") as HTMLElement).click();
    });
    await tick(3200);
    expect(w.patches).toEqual([`rule ${SPAM_RULE} → INBOX`, `rule ${SPAM_RULE} → ${QUARANTINE}`]);
    expect(w.rules.get(SPAM_RULE)?.destination).toBe(QUARANTINE);
    expect(w.msgs.get(QUARANTINED)?.folder).toBe(QUARANTINE);
  }, 30000);

  it("a refused move offers no Undo, and the rule change is never written", async () => {
    w.refuseMove = true;
    const c = await openSegment("spam");
    await selectRow(c, REP);
    releaseScreenerRow(c, "ohbox");
    await tick(200);
    expect(toastText(), "no toast reported the refusal").toContain("could not be saved");
    expect(toastText(), "an Undo was offered over a release that did not happen").not.toContain("Undo");
    await tick(9000);
    expect(w.patches).toEqual([`rule ${SPAM_RULE} → INBOX`]);
    expect(w.rules.get(SPAM_RULE)?.destination).toBe(QUARANTINE);
    expect(w.msgs.get(QUARANTINED)?.folder).toBe(QUARANTINE);
    expect(rowIds(c)).toContain(REP);
  }, 30000);
});

describe("releasing a sender a RULE holds in Screened out", () => {
  beforeEach(() => {
    installShellEnv();
    w = new World();
    w.add({ id: "s-rep", from: SENDER, folder: "INBOX", date: "2026-08-04T09:00:00.000Z", subject: "WG: Herbstaktion" });
    w.add({ id: "s-filed", from: SENDER, folder: SCREENED, date: "2026-08-01T09:00:00.000Z" });
    w.addRule({ id: "rule-screenout", kind: "sender", match: SENDER, destination: SCREENED });
    installWorld();
  });
  afterEach(teardownShellEnv);

  it("'Allow → Ohbox' retargets the screen-out rule and moves only the filed mail", async () => {
    const c = await openSegment("screened");
    expect(rowIds(c), "the rule-held sender did not present in Screened out").toContain("s-rep");

    await selectRow(c, "s-rep");
    releaseScreenerRow(c, "ohbox");
    await tick(200);

    expect(w.patches, "the screen-out rule was not retargeted").toEqual(["rule rule-screenout → INBOX"]);
    expect(w.posts, "the release moved mail the rule change already covers").toEqual([`move s-filed → INBOX`]);
    expect(rowIds(c)).not.toContain("s-rep");
    expect(c.textContent).not.toContain("Not saved");
    expect(toastText()).not.toContain("could not be saved");
    // Claims are contracts: the rule WAS rewritten, so the no-rule sentence would be false here.
    expect(toastText(), "the toast denies the rule rewrite it just made").not.toContain("future mail is unchanged");
  }, 30000);
});
