/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ISO, goTo, installShellEnv, liveAccountFetch, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";
import { decideScreenerRow as fileRow, screenerReport, screenerRow, screenerRowIds as rowIds } from "./fixtures/live-screener";

/**
 * A SCREENING DECISION HOLDS WHILE YOU MOVE AROUND THE APP — and a refusal is never silent.
 *
 * ## THE REPORT
 *
 * *"Screened one sender in and one out, went to the Ohbox, came back — both were back as if
 * undecided."*
 *
 * ## WHAT WAS RULED OUT FIRST, so nobody re-walks it
 *
 * The pending map does NOT die on unmount (it is a ref in `useScreenerState`, which lives in
 * `AppShell`, above the view). The route change DOES flush pending commits (`AppShell`'s
 * route-transition effect calls `screener.flush()`). The desktop door DOES carry the screener
 * routes. And the message DTO reports `desiredFolder` FIRST (`dto/materialize.ts` —
 * `fs?.desiredFolder ?? loc?.folder`), so a decide's folder change is on the wire immediately and
 * does not wait for the worker's IMAP move. Every one of those is fine, and the first case below
 * proves it end-to-end against a faithful server: decide in, decide out, leave, return, both hold.
 *
 * ## THE MECHANISM THAT ACTUALLY PRODUCED IT
 *
 * `screener-state.ts#commit` fired `void engine.mutate({kind:"screener_decide", …})` and never
 * looked at the result. `screener_decide` answers `changes: []`, so the engine drops the optimistic
 * overlay on confirm and the settled facts arrive from a reconciliation drain — but on a REFUSAL it
 * drops the overlay too and reports `rolled_back` to a caller that had thrown the promise away.
 * Nothing restored the row deliberately, nothing marked it, nothing said anything: the sender was
 * simply back in the queue, byte-identical to never having been decided.
 *
 * The live trigger is the server's own 404. `POST /screener/:id` resolves through `heldRowById`,
 * which requires `desired_folder = 'ohmail/Screener'`, so any row this mirror still believes is at
 * the gate while the server has already moved it on — a second device, the retro pass walking a
 * backlog after an `applyRetro` rule — is refused. That is one stale poll interval wide and it hits
 * every decision made inside it, which is why BOTH senders came back together.
 *
 * ## THE HARNESS
 *
 * A `/sync` world that applies the decide server-side the way the service does (re-route the
 * sender's held mail to the chosen folder, promote a rule, record both at fresh seqs) and serves
 * changes after the client's cursor. `refuseDecide` flips it to the 404. The controls driven are
 * the per-row quick-adjust menu — `.scn-act-more` then the nth `.scn-act-dest` — deliberately NOT
 * any bulk "apply suggestions" chip: those apply the MODEL's destination to every waiting row, so a
 * harness that reaches one by text match silently decides for the wrong senders and proves nothing.
 */

const SCREENER = "ohmail/Screener";

interface Msg { id: string; from: string; folder: string; unread: boolean; date: string }
interface Change { type: string; op: string; id: string; seq: number; updatedAt: string; entity: unknown }

/** The server, with just enough of `ScreenerService.decide` to be honest about the client's job. */
class World {
  seq = 0;
  msgs = new Map<string, Msg>();
  log: Change[] = [];
  posts: string[] = [];
  /** 404 every decide — the live "no longer held at the gate" refusal. */
  refuseDecide = false;

  private entityOf(m: Msg): unknown {
    return {
      id: m.id, accountId: "acct_live_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
      subject: `subject of ${m.id}`,
      from: { name: `Sender ${m.id}`, address: m.from },
      to: [], cc: [], date: m.date, folder: m.folder, snippet: `snippet of ${m.id}`,
      unread: m.unread, hasAttachments: false, attachmentCount: 0, sensitivity: {},
      triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
    };
  }

  add(m: Msg): void {
    this.msgs.set(m.id, m);
    this.log.push({ type: "message", op: "create", id: m.id, seq: ++this.seq, updatedAt: ISO, entity: this.entityOf(m) });
  }

  /** `op: "move"` — the change the service records for a re-routed held row. */
  private move(id: string, folder: string): void {
    const m = this.msgs.get(id);
    if (!m) return;
    m.folder = folder;
    this.log.push({ type: "message", op: "move", id, seq: ++this.seq, updatedAt: ISO, entity: this.entityOf(m) });
  }

  private rule(match: string, destination: string): string {
    const id = `rule_${match}_${++this.seq}`;
    this.log.push({
      type: "rule", op: "create", id, seq: this.seq, updatedAt: ISO,
      entity: {
        id, kind: "sender", match, destination, priority: 0, provenance: "promoted", enabled: true,
        stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
      },
    });
    return id;
  }

  decide(repId: string, dest: string): Response {
    if (this.refuseDecide) {
      return new Response(JSON.stringify({ error: { code: "not_found", message: "screener item not found" } }),
        { status: 404, headers: { "content-type": "application/json" } });
    }
    const rep = this.msgs.get(repId);
    // The gate predicate, verbatim in spirit: only a row still held is resolvable.
    if (!rep || rep.folder !== SCREENER) {
      return new Response(JSON.stringify({ error: { code: "not_found", message: "screener item not found" } }),
        { status: 404, headers: { "content-type": "application/json" } });
    }
    for (const m of [...this.msgs.values()]) {
      if (m.from === rep.from && m.folder === SCREENER) this.move(m.id, dest);
    }
    const ruleId = this.rule(rep.from, dest);
    return new Response(JSON.stringify({ messageId: rep.id, appliedFolder: dest, createdRuleId: ruleId }),
      { status: 200, headers: { "content-type": "application/json", "X-Sync-Seq": String(this.seq) } });
  }

  ruleCreate(match: string, destination: string): Response {
    const id = this.rule(match, destination);
    return new Response(JSON.stringify(this.log.find((c) => c.id === id)!.entity),
      { status: 200, headers: { "content-type": "application/json", "X-Sync-Seq": String(this.seq) } });
  }

  moveOne(id: string, folder: string): Response {
    this.move(id, folder);
    const m = this.msgs.get(id);
    return new Response(JSON.stringify(m ? this.entityOf(m) : {}),
      { status: 200, headers: { "content-type": "application/json", "X-Sync-Seq": String(this.seq) } });
  }

  syncFrom(since: string): Response {
    const from = Number(since) || 0;
    const rows = this.log.filter((c) => c.seq > from);
    return new Response(JSON.stringify({
      changes: {
        creates: rows.filter((c) => c.op === "create"),
        updates: rows.filter((c) => c.op === "update"),
        moves: rows.filter((c) => c.op === "move"),
        deletes: [],
      },
      cursor: String(this.seq), hasMore: false, serverTime: ISO,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
}

let w: World;

function installWorld(): void {
  const shellFetch = globalThis.fetch;
  globalThis.fetch = liveAccountFetch(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = (): Record<string, string> => JSON.parse(String(init?.body ?? "{}")) as Record<string, string>;

    if (url.includes("/sync")) {
      return w.syncFrom(new URL(url, "http://x").searchParams.get("since") ?? "0");
    }
    if (url.includes("/consent")) {
      return new Response(JSON.stringify({
        seedConfirmedAt: ISO, screeningResetAt: null, dormancyDays: 60,
        counts: { decidedSenders: 0, activeUndecidedSenders: 0, dormantUndecidedSenders: 0 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const scn = /\/screener\/([^/?]+)$/.exec(url);
    if (scn && method === "POST") {
      const b = body();
      w.posts.push(`decide ${scn[1]} → ${b.dest ?? "(default)"}`);
      return w.decide(scn[1]!, b.dest ?? (b.decision === "yes" ? "INBOX" : "ohmail/Screened"));
    }
    if (url.includes("/rules") && method === "POST") {
      const b = body();
      w.posts.push(`rule ${b.match} → ${b.destination}`);
      return w.ruleCreate(b.match!, b.destination!);
    }
    const mv = /\/messages\/([^/?]+)\/move$/.exec(url);
    if (mv && method === "POST") {
      w.posts.push(`move ${mv[1]} → ${body().folder}`);
      return w.moveOne(mv[1]!, body().folder!);
    }
    return shellFetch(input, init);
  });
}

/** Whether this sender's row has begun the visible exit animation. */
const isExiting = (c: HTMLElement, id: string): boolean =>
  Boolean(screenerRow(c, id)?.closest("[data-leaving]"));

const ALPHA = "aaa1";
const BETA = "bbb1";

function seedTwoWaitingSenders(): void {
  w = new World();
  w.add({ id: ALPHA, from: "alpha@example.invalid", folder: SCREENER, unread: true, date: "2026-08-03T09:00:00.000Z" });
  w.add({ id: BETA, from: "beta@example.invalid", folder: SCREENER, unread: true, date: "2026-08-02T09:00:00.000Z" });
}

describe("a decision made in the Screener survives leaving and coming back", () => {
  beforeEach(() => {
    installShellEnv();
    seedTwoWaitingSenders();
    installWorld();
  });
  afterEach(teardownShellEnv);

  /**
   * THE OWNER'S SEQUENCE, EXACTLY: one in, one out, go to the Ohbox, come back.
   *
   * Both halves matter. The FIRST FRAME after each press is asserted (the rows leave immediately —
   * the decision is optimistic and the commit has not even been scheduled yet), and so is the
   * state after the route change flushes both commits, the wire answers and the reconciliation
   * drain lands.
   */
  it("screen one in and one out, leave for the Ohbox, return — both decisions hold", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("screener");
    await tick(50);
    expect(rowIds(c), "the queue did not offer both senders").toEqual([ALPHA, BETA]);

    await fileRow(c, ALPHA, "ohbox");
    expect(isExiting(c, ALPHA), "the screened-in row is not leaving in the first frame").toBe(true);
    await fileRow(c, BETA, "screened");
    expect(isExiting(c, BETA), "the screened-out row is not leaving in the first frame").toBe(true);
    // …and once the exit is spent they are out of the queue, before any commit has fired.
    await tick(400);
    expect(rowIds(c), "a decided row is still listed after its exit").toEqual([]);
    expect(w.posts, "a decision reached the wire before the undo window closed").toEqual([]);
    expect(c.textContent).toContain("2 decided");

    // Leaving flushes both pending commits — this is the gesture the report names.
    await goTo("ohbox");
    await tick(200);
    expect(w.posts).toEqual([
      `decide ${ALPHA} → INBOX`,
      `decide ${BETA} → ohmail/Screened`,
    ]);

    await goTo("screener");
    await tick(200);
    expect(rowIds(c), "the screened-in sender is waiting again").not.toContain(ALPHA);
    expect(rowIds(c), "the screened-out sender is waiting again").not.toContain(BETA);
    expect(c.textContent).toContain("2 decided");
    // Nothing claims a failure, because there was none.
    expect(c.textContent).not.toContain("Not saved");
  }, 30000);

  /** THE OTHER DIRECTION — out first, then in. The order of two decisions may not matter. */
  it("screen one OUT and one IN, in that order — both still hold on return", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("screener");
    await tick(50);

    await fileRow(c, ALPHA, "screened");
    await fileRow(c, BETA, "ohbox");
    await goTo("ohbox");
    await tick(200);
    await goTo("screener");
    await tick(200);

    expect(rowIds(c)).not.toContain(ALPHA);
    expect(rowIds(c)).not.toContain(BETA);
    expect(w.posts).toEqual([
      `decide ${ALPHA} → ohmail/Screened`,
      `decide ${BETA} → INBOX`,
    ]);
  }, 30000);

  /**
   * A LATE DRAIN MAY NOT PUT THEM BACK.
   *
   * The overlay is dropped on confirm and the mirror is then whatever `/sync` says. So keep
   * draining after the decisions have settled: every subsequent poll must go on agreeing.
   */
  it("stays decided across repeated drains, with no view switch to re-derive anything", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("screener");
    await tick(50);
    await fileRow(c, ALPHA, "reads");
    await fileRow(c, BETA, "spam");
    await goTo("ohbox");
    await tick(200);
    await goTo("screener");

    for (let i = 0; i < 3; i++) {
      await tick(300);
      expect(rowIds(c), `sender returned to the queue on drain ${i + 1}`).not.toContain(ALPHA);
      expect(rowIds(c), `sender returned to the queue on drain ${i + 1}`).not.toContain(BETA);
    }
  }, 30000);
});

describe("a decision the wire REFUSES comes back visibly, never silently", () => {
  beforeEach(() => {
    installShellEnv();
    seedTwoWaitingSenders();
    w.refuseDecide = true;
    installWorld();
  });
  afterEach(teardownShellEnv);

  /**
   * THE DEFECT, PINNED. With the server refusing, both senders DO return — that part is correct and
   * unavoidable, because the decision genuinely did not happen. What was wrong is that the product
   * said nothing about it.
   *
   * MUTATION WATCHED (2026-08-13): put `commit`'s gate-physical branch back to a bare
   * `void engine.mutate({kind:"screener_decide", …})` — dropping the `.then` that calls `refuse` —
   * and the rows still come back exactly as below while every assertion about the note and the
   * toast goes red. What the run prints is worth recording, because it is worse than silence: the
   * only toast on screen is the OPTIMISTIC one `decide()` raised at press time —
   *
   *     "Ohbox — filed. Future mail from alpha@example.invalid files there too."
   *
   * — so the product was affirmatively claiming a decision it had just lost, beside a row that was
   * back in the queue. That is the reported bug, and it is the whole reason this file is not
   * satisfied by the queue's contents alone.
   */
  it("both senders return AND the rows say their decision was not saved", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("screener");
    await tick(50);

    await fileRow(c, ALPHA, "ohbox");
    await fileRow(c, BETA, "screened");
    await goTo("ohbox");
    await tick(200);
    await goTo("screener");
    await tick(200);

    // They are back — the honest outcome of a refusal.
    expect(rowIds(c)).toContain(ALPHA);
    expect(rowIds(c)).toContain(BETA);
    // …and the product SAYS so, on the rows themselves, which is the half that was missing.
    const noteOf = (id: string): string =>
      screenerRow(c, id)?.textContent ?? "";
    expect(noteOf(ALPHA), "the returned row carries no refusal note").toContain("Not saved");
    expect(noteOf(BETA), "the returned row carries no refusal note").toContain("Not saved");
  }, 30000);

  /** The toast names the sender, so a reader who was watching knows WHICH decision was lost. */
  it("the refusal is announced as it happens, naming the sender", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("screener");
    await tick(50);

    await fileRow(c, ALPHA, "ohbox");
    await goTo("ohbox");
    await tick(200);

    const toast = screenerReport();
    expect(toast, "no toast reported the refusal").toContain("could not be saved");
    // The sender as a PERSON reads them — `displayAddressee`, so the display name when there is
    // one. The fixture's rows carry `from.name` of "Sender <id>".
    expect(toast, "the toast does not say whose decision was lost").toContain(`Sender ${ALPHA}`);
  }, 30000);

  /**
   * DECIDING AGAIN CLEARS THE NOTE — the note is about the LAST attempt, so a row the reader has
   * just decided again may not still be accusing the new decision of having failed.
   */
  it("a fresh decision on a refused row drops the note in the same frame", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("screener");
    await tick(50);

    await fileRow(c, ALPHA, "ohbox");
    await goTo("ohbox");
    await tick(200);
    await goTo("screener");
    await tick(200);
    expect(screenerRow(c, ALPHA)?.textContent).toContain("Not saved");

    // The server has recovered by the time the reader tries again.
    w.refuseDecide = false;
    await fileRow(c, ALPHA, "ohbox");
    // The note is gone in the SAME frame as the retry — before the wire is asked, because the
    // claim it makes ("your last decision did not land") is no longer about anything on screen.
    expect(isExiting(c, ALPHA), "the row did not start leaving on the retry").toBe(true);
    expect(
      screenerRow(c, ALPHA)?.textContent,
      "the refusal note survived the retry press",
    ).not.toContain("Not saved");
    await tick(400);
    await goTo("ohbox");
    await tick(200);
    await goTo("screener");
    await tick(200);
    expect(rowIds(c)).not.toContain(ALPHA);
    expect(c.textContent, "the stale refusal note outlived the decision it was about")
      .not.toContain("Not saved");
  }, 30000);
});
