/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ISO, goTo, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
  liveAccountResponse,
} from "./fixtures/live-walk-shell";
import {
  decideScreenerRow,
  releaseScreenerRow,
  screenerRow,
  screenerReport as toastText,
  screenerRowIds as rowIds,
  selectScreenerRow as selectRow,
} from "./fixtures/live-screener";

/**
 * UNDOING A SCREENING DECISION REPORTS FAILURE — it does not pretend.
 *
 * ## THE SHAPE, AND WHERE IT CAME FROM
 *
 * `screener-decision-holds.test.ts` pinned this defect on the DECIDE paths: `commit` fired
 * `void engine.mutate(…)`, a refusal rolled the overlay back, and the sender reappeared in the
 * queue with the optimistic toast still on screen claiming the decision. The same three controls on
 * the two adjacent segments were left carrying it, deliberately and out of that slice's scope:
 *
 *  · **Screened out → "Allow"** (`allowScreened`) — `moveAll`, or a fixture decide;
 *  · **Spam → "Not spam → Ohbox"** (`notSpamToOhbox`) — three branches, all unwatched;
 *  · **Spam → "Not spam → Screener"** (`notSpamToWaiting`) — `moveAll`.
 *
 * Every one of them raised its toast at press time and threw the result away. It is WORSE here than
 * on the decide, for one reason: a decision has an 8-second undo window and a second toast when the
 * window closes, so a reader has two chances to notice. These presses have neither. The toast was
 * the only account of them that ever existed, and on a refusal it was a false one.
 *
 * ## THE ONE THAT NEEDED MORE THAN A `.then`
 *
 * A PINNED spam row — a sender marked spam in this session, remembered in `s.pins` because the
 * mirror has no other record that the reader made that call. Every other refusal is rolled back for
 * us: the engine drops its overlay, `/sync` goes on reporting the mail where it is, and the derived
 * row reappears. The pin is the client's own state, so dropping it on the press and never restoring
 * it left the surface PERMANENTLY out of step with the mirror — the mail still in Quarantine, and
 * no row naming it until a reload. That branch restores the pin at its own index.
 *
 * ## AND THE PARTIAL RELEASE, which is why the mark is keyed on the whole bag
 *
 * A derived row's id is the sender's NEWEST message in the folder. Release five and have the newest
 * land while an older one is refused, and the row that comes back is minted on a different message —
 * so a mark on the pressed id would be a mark nothing asks about. The last case below is exactly
 * that: two messages, only the older one refused, the row back under a new id and marked.
 *
 * ## THE HARNESS
 *
 * A `/sync` world that serves changes after the client's cursor and applies `POST
 * /messages/:id/move` the way the service does. `refuseMove` flips the move to a 404 — the live
 * shape of it being a message this mirror still believes is in Quarantine while the server has
 * already moved it on. `refuseMoveOf` refuses one id, for the partial case; `holdMove` leaves the
 * request in flight for ever, which is the only way to observe a press CLEARING a note before the
 * wire has answered. The controls are driven through the previews' own confirm strips ("Not spam…"
 * → "→ Ohbox"), never by calling state directly: the whole defect was in what the surface said, so
 * the surface is what is pressed.
 *
 * ── AND IT EMITS NO RULES, WHICH IS A DELIBERATE CHOICE AND WAS NOT THE FIRST ONE ──────────
 *
 * `live-walk-shell`'s own `page` helper pairs every INBOX message with a consent rule, because the
 * shell partitions mail by sender and an INBOX message from a stranger presents at the gate. Mail in
 * `ohmail/Quarantine` and `ohmail/Screened` needs no such help: neither folder is an
 * UNDECIDED_RESIDENCE (`consent-cutline.ts` — only `INBOX` and `ohmail/Screener` are), so an
 * explicit placement is already an answer and the projection keeps its hands off it.
 *
 * Emitting one is worse than unnecessary — it breaks the guard. A rule whose destination is
 * `ohmail/Quarantine` makes the cutline present the sender's INBOX mail back in Spam, so a release
 * that SUCCEEDED left the row exactly where a refused one does and the control case could not tell
 * the two apart. Measured while writing this file, and worth stating: what the fixture must not do
 * is give the success and the failure the same appearance.
 */

const QUARANTINE = "ohmail/Quarantine";
const SCREENED = "ohmail/Screened";

interface Msg { id: string; from: string; folder: string; date: string }
interface Change { type: string; op: string; id: string; seq: number; updatedAt: string; entity: unknown }

class World {
  seq = 0;
  msgs = new Map<string, Msg>();
  log: Change[] = [];
  posts: string[] = [];
  /** 404 every move — the live "that mail is not where you think it is" refusal. */
  refuseMove = false;
  /** …or just one of them, which is the partial release. */
  refuseMoveOf: string | null = null;
  /** Never answer a move at all, so a press can be observed with nothing settled behind it. */
  holdMove = false;
  /**
   * …or RECORD it for the install that organizes this mailbox — `202 {pending: true}`, the
   * reader-mailbox door. Neither a success nor a refusal: nothing moved, and the release counted
   * it as landed for as long as `moveAll` answered landed-or-not.
   */
  queueMove = false;

  private entityOf(m: Msg): unknown {
    return {
      id: m.id, accountId: "acct_live_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
      subject: `subject of ${m.id}`,
      from: { name: `Sender ${m.id}`, address: m.from },
      to: [], cc: [], date: m.date, folder: m.folder, snippet: `snippet of ${m.id}`,
      unread: true, hasAttachments: false, attachmentCount: 0, sensitivity: {},
      triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
    };
  }

  add(m: Msg): void {
    this.msgs.set(m.id, m);
    this.log.push({ type: "message", op: "create", id: m.id, seq: ++this.seq, updatedAt: ISO, entity: this.entityOf(m) });
  }

  private move(id: string, folder: string): void {
    const m = this.msgs.get(id);
    if (!m) return;
    m.folder = folder;
    this.log.push({ type: "message", op: "move", id, seq: ++this.seq, updatedAt: ISO, entity: this.entityOf(m) });
  }

  /**
   * `POST /screener/:id`, enough of it to get a sender genuinely INTO Quarantine.
   *
   * Only the pinned-row guard needs it, and it needs the decide to WORK: the pin is this session's
   * memory of a decision whose mail the mirror reports quarantined, so a decide that 404s produces a
   * pin over mail still at the gate — a different state, and one that would raise the decide's own
   * refusal note and mask what the guard is looking for. No rule is promoted; see the header.
   */
  decide(repId: string, dest: string): Response {
    const rep = this.msgs.get(repId);
    if (!rep) {
      return new Response(JSON.stringify({ error: { code: "not_found", message: "not held" } }),
        { status: 404, headers: { "content-type": "application/json" } });
    }
    for (const m of [...this.msgs.values()]) {
      if (m.from === rep.from && m.folder === "ohmail/Screener") this.move(m.id, dest);
    }
    return new Response(JSON.stringify({ messageId: rep.id, appliedFolder: dest, createdRuleId: null }),
      { status: 200, headers: { "content-type": "application/json", "X-Sync-Seq": String(this.seq) } });
  }

  moveOne(id: string, folder: string): Response {
    if (this.queueMove) {
      const m = this.msgs.get(id);
      /* THE BODY AS `MessageService.requestMove` SENDS IT — `dto` included and UNCHANGED, the
         message still where it was. A double that answers a queued state differently from
         production is how this defect stayed hidden on the phone for a release. */
      return new Response(JSON.stringify({
        pending: true, requestId: "req-1",
        holder: { kind: "local", name: "the laptop" },
        dto: m ? this.entityOf(m) : null,
      }), { status: 202, headers: { "content-type": "application/json" } });
    }
    if (this.refuseMove || this.refuseMoveOf === id) {
      return new Response(JSON.stringify({ error: { code: "not_found", message: "message not found" } }),
        { status: 404, headers: { "content-type": "application/json" } });
    }
    const m = this.msgs.get(id);
    if (!m) {
      return new Response(JSON.stringify({ error: { code: "not_found", message: "message not found" } }),
        { status: 404, headers: { "content-type": "application/json" } });
    }
    this.move(id, folder);
    return new Response(JSON.stringify(this.entityOf(m)),
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
        deletes: [],
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
        counts: { decidedSenders: 0, activeUndecidedSenders: 1, dormantUndecidedSenders: 0 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const mv = /\/messages\/([^/?]+)\/move$/.exec(url);
    if (mv && method === "POST") {
      const folder = (JSON.parse(String(init?.body ?? "{}")) as { folder?: string }).folder ?? "";
      w.posts.push(`move ${mv[1]} → ${folder}`);
      // Held open, never answered — see `holdMove`. `await` on this promise never returns, which is
      // exactly the state a press has to be observable in.
      if (w.holdMove) return new Promise<Response>(() => {});
      return w.moveOne(mv[1]!, folder);
    }
    const scn = /\/screener\/([^/?]+)$/.exec(url);
    if (scn && method === "POST") {
      const dest = (JSON.parse(String(init?.body ?? "{}")) as { dest?: string }).dest ?? "INBOX";
      w.posts.push(`decide ${scn[1]} → ${dest}`);
      return w.decide(scn[1]!, dest);
    }
    return new Response("{}", { status: 200 });
  };
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    liveAccountResponse(await respond(input, init)));
}

const noteOf = (c: HTMLElement, id: string): string => screenerRow(c, id)?.textContent ?? "";

const SPAMMER = "spam1";
const SCREENED_ONE = "scrn1";

function seedDecidedSenders(): void {
  w = new World();
  w.add({ id: SPAMMER, from: "junk@example.invalid", folder: QUARANTINE, date: "2026-08-03T09:00:00.000Z" });
  w.add({ id: SCREENED_ONE, from: "nope@example.invalid", folder: SCREENED, date: "2026-08-02T09:00:00.000Z" });
}

/** Mount, drain, and land on one screener segment with its rows derived from the mirror. */
async function openSegment(segment: "spam" | "screened"): Promise<HTMLElement> {
  const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
  await tick(0);
  await goTo(`screener/${segment}`);
  await tick(200);
  return c;
}

describe("a reversal the wire TAKES behaves exactly as before", () => {
  beforeEach(() => {
    installShellEnv();
    seedDecidedSenders();
    installWorld();
  });
  afterEach(teardownShellEnv);

  it("'Not spam → Ohbox' moves the mail, drops the row and says nothing about failure", async () => {
    const c = await openSegment("spam");
    expect(rowIds(c), "the spam segment did not derive its row").toContain(SPAMMER);

    await selectRow(c, SPAMMER);
    releaseScreenerRow(c, "ohbox");
    await tick(200);

    expect(w.posts).toEqual([`move ${SPAMMER} → INBOX`]);
    expect(rowIds(c), "the released sender is still listed in Spam").not.toContain(SPAMMER);
    expect(c.textContent, "a successful release claimed a failure").not.toContain("Not saved");
    expect(toastText(), "a successful release raised the refusal sentence").not.toContain("could not be saved");
  }, 30000);

  it("'Allow' on a screened-out sender releases their mail and marks nothing", async () => {
    const c = await openSegment("screened");
    expect(rowIds(c), "the screened-out segment did not derive its row").toContain(SCREENED_ONE);

    await selectRow(c, SCREENED_ONE);
    releaseScreenerRow(c, "ohbox");
    await tick(200);

    expect(w.posts).toEqual([`move ${SCREENED_ONE} → INBOX`]);
    expect(rowIds(c)).not.toContain(SCREENED_ONE);
    expect(c.textContent).not.toContain("Not saved");
  }, 30000);
});

describe("a reversal the wire RECORDS for the organizer is a wait, never a release", () => {
  beforeEach(() => {
    installShellEnv();
    seedDecidedSenders();
    w.queueMove = true;
    installWorld();
  });
  afterEach(teardownShellEnv);

  /**
   * MUTATION WATCHED: put `moveAll` back to `.then((landed) => landed.every(Boolean))` over
   * `r.status !== "rolled_back"` — the shipped shape — and this case fails on the row and on the
   * toast together, with *"Released 1 held message to Ohbox"* the only thing on screen beside
   * mail that is still in Quarantine. Counting landed-or-not is what put a recorded request on
   * the landed side.
   */
  it("'Not spam → Ohbox' leaves the sender in Spam and says what it is waiting for", async () => {
    const c = await openSegment("spam");
    await selectRow(c, SPAMMER);
    releaseScreenerRow(c, "ohbox");
    await tick(200);

    expect(w.posts, "the move was never attempted").toEqual([`move ${SPAMMER} → INBOX`]);
    // Nothing moved, so the sender is still here…
    expect(rowIds(c), "a sender whose release nobody carried out left the segment").toContain(SPAMMER);
    // …and the sentence names the wait rather than reporting a release.
    const toast = toastText();
    expect(toast, "the release was reported as done over a recorded request").not.toContain("Released");
    expect(toast, "no toast named the wait").toContain("queued for the laptop");
    expect(toast, "a wait was reported as a refusal").not.toContain("could not be saved");
  }, 30000);
});

describe("a reversal the wire REFUSES is reported, never swallowed", () => {
  beforeEach(() => {
    installShellEnv();
    seedDecidedSenders();
    w.refuseMove = true;
    installWorld();
  });
  afterEach(teardownShellEnv);

  /**
   * MUTATION WATCHED (2026-08-13): restore `release`'s body to the shipped
   * `moveAll(heldMessageIds(sender), FOLDER_OF_VIEW[dest]);` with `moveAll` back to its
   * `for (…) void engine.mutate(…)` loop, and this test fails on the note and the toast while the
   * row still comes back exactly as asserted — with the press-time toast
   * *"Not spam — filed to Ohbox. junk@example.invalid is allowed now."* the only thing on screen,
   * beside a row whose mail never left Quarantine. That is the defect, stated by the product.
   */
  it("'Not spam → Ohbox' leaves the sender in Spam, marks the row and names the pile", async () => {
    const c = await openSegment("spam");
    await selectRow(c, SPAMMER);
    releaseScreenerRow(c, "ohbox");
    await tick(200);

    expect(w.posts, "the move was never attempted").toEqual([`move ${SPAMMER} → INBOX`]);
    // The honest outcome: the mail did not move, so the sender is still here…
    expect(rowIds(c)).toContain(SPAMMER);
    // …and the product says so, on the row, where it outlives the toast.
    expect(noteOf(c, SPAMMER), "the returned row carries no refusal note").toContain("Not saved");
    const toast = toastText();
    expect(toast, "no toast reported the refusal").toContain("could not be saved");
    expect(toast, "the toast does not say whose change was lost").toContain(`Sender ${SPAMMER}`);
    // It names the pile the sender is STILL in — never "back in the queue", which is the decide's
    // sentence and would send the reader to a segment this row is not in.
    expect(toast, "the toast does not name the pile the sender is still in").toContain("Spam");
  }, 30000);

  it("'Not spam → Screener' leaves the sender in Spam and reports it the same way", async () => {
    const c = await openSegment("spam");
    await selectRow(c, SPAMMER);
    releaseScreenerRow(c, "waiting");
    await tick(200);

    expect(w.posts).toEqual([`move ${SPAMMER} → ohmail/Screener`]);
    expect(rowIds(c)).toContain(SPAMMER);
    expect(noteOf(c, SPAMMER)).toContain("Not saved");
    expect(toastText()).toContain("could not be saved");
  }, 30000);

  it("'Allow' on a screened-out sender leaves them screened out and marks the row", async () => {
    const c = await openSegment("screened");
    await selectRow(c, SCREENED_ONE);
    releaseScreenerRow(c, "reads");
    await tick(200);

    expect(w.posts).toEqual([`move ${SCREENED_ONE} → ohmail/News`]);
    expect(rowIds(c)).toContain(SCREENED_ONE);
    expect(noteOf(c, SCREENED_ONE), "the returned row carries no refusal note").toContain("Not saved");
    const toast = toastText();
    expect(toast).toContain("could not be saved");
    // The Screened-out segment's own name, not Spam's.
    expect(toast, "the refusal named the wrong pile").toContain("Screened out");
  }, 30000);

  /**
   * THE NOTE OUTLIVES THE TOAST AND THE VIEW — the reason it is a state and not a sentence.
   *
   * A capsule that has faded cannot be the only record of something that did not happen, and the
   * reader's next act after a press is usually to go and look somewhere else.
   */
  it("the note is still on the row after leaving the Screener and coming back", async () => {
    const c = await openSegment("spam");
    await selectRow(c, SPAMMER);
    releaseScreenerRow(c, "ohbox");
    await tick(200);
    expect(noteOf(c, SPAMMER)).toContain("Not saved");

    await goTo("ohbox");
    await tick(200);
    await goTo("screener/spam");
    await tick(200);

    expect(rowIds(c)).toContain(SPAMMER);
    expect(noteOf(c, SPAMMER), "the refusal note did not survive the round trip").toContain("Not saved");
  }, 30000);

  /**
   * PRESSING AGAIN CLEARS IT BEFORE THE WIRE HAS ANSWERED — the note is about the LAST attempt, so
   * a row the reader has just retried may not still be accusing the new one of having failed.
   *
   * `holdMove` is what makes the claim observable rather than merely consistent with a success: with
   * the request in flight for ever, NOTHING but the press itself can have cleared the note. A retry
   * against a recovered server would clear it twice and prove which of the two did it.
   */
  it("a fresh press drops the note before the wire answers", async () => {
    const c = await openSegment("spam");
    await selectRow(c, SPAMMER);
    releaseScreenerRow(c, "ohbox");
    await tick(200);
    expect(noteOf(c, SPAMMER)).toContain("Not saved");

    w.refuseMove = false;
    w.holdMove = true;
    releaseScreenerRow(c, "ohbox");
    await tick(0);
    expect(noteOf(c, SPAMMER), "the note survived the retry press").not.toContain("Not saved");
    // Still nothing answered, and still nothing claimed.
    await tick(400);
    expect(noteOf(c, SPAMMER), "a note appeared with no answer behind it").not.toContain("Not saved");
  }, 30000);

  /** A release that WORKS after a refused one leaves no note behind for the next row. */
  it("a retry that lands releases the sender and clears the mark", async () => {
    const c = await openSegment("spam");
    await selectRow(c, SPAMMER);
    releaseScreenerRow(c, "ohbox");
    await tick(200);
    expect(noteOf(c, SPAMMER)).toContain("Not saved");

    w.refuseMove = false;
    releaseScreenerRow(c, "ohbox");
    await tick(300);

    expect(rowIds(c), "the retry did not release the sender").not.toContain(SPAMMER);
    expect(c.textContent, "a stale note outlived the release it was about").not.toContain("Not saved");
  }, 30000);
});

describe("a PINNED spam row — the one piece of state the engine cannot roll back for us", () => {
  beforeEach(() => {
    installShellEnv();
    w = new World();
    /*
     * ONE SENDER, MAIL IN TWO PLACES, AND THE DATES ARE THE WHOLE POINT.
     *
     * `gate1` waits at the gate with no rule — an active undecided stranger, which is what the
     * waiting queue is — and marking them spam pins that row.
     *
     * `older_decision` is mail from the SAME sender already in Quarantine from an earlier decision,
     * and it is dated NEWER than the gate row. That is what makes this guard able to see the pin
     * restore at all: a derived Spam row is minted on the sender's newest quarantined message, so
     * without the pin the row that surfaces after a refused release is `older_decision` — an id this
     * press never named. With one quarantined message the derived row carries the pressed id anyway
     * and the restore is invisible; the first version of this test had exactly that seed and stayed
     * green with the restore deleted.
     */
    w.add({ id: "older_decision", from: "stranger@example.invalid", folder: QUARANTINE, date: "2026-08-05T09:00:00.000Z" });
    w.add({ id: "gate1", from: "stranger@example.invalid", folder: "ohmail/Screener", date: "2026-08-03T09:00:00.000Z" });
    installWorld();
  });
  afterEach(teardownShellEnv);

  /**
   * MUTATION WATCHED (2026-08-13), both halves separately:
   *
   *  · delete the `s.pins` splice and keep the `.then` — the pinned row is replaced by the derived
   *    row for `older_decision`, so `rowIds` no longer holds `gate1` and the refusal renders nowhere;
   *  · put `moveAll` back to its `for (…) void engine.mutate(…)` loop — no note, no toast, and the
   *    pin stays dropped, with the release toast the only account of a release that did not happen.
   *
   * The pin is reached the way a reader reaches it: mark the waiting stranger spam, let the undo
   * window close so the decide commits, then release them from the Spam segment with the moves
   * refused.
   */
  it("restores the pin and marks it when the release is refused", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("screener");
    await tick(200);
    expect(rowIds(c), "the stranger is not waiting at the gate").toContain("gate1");

    await selectRow(c, "gate1");
    await decideScreenerRow(c, "gate1", "spam");
    // Past the undo window, so the decision commits and the sender is pinned into Spam.
    await tick(9000);
    expect(w.posts, "the spam decision never reached the wire")
      .toEqual([`decide gate1 → ${QUARANTINE}`]);
    expect(w.msgs.get("gate1")?.folder, "the decided mail is not in Quarantine").toBe(QUARANTINE);

    await goTo("screener/spam");
    await tick(200);
    // The pin, and NOT the derived row for the same address — `pinnedKeys` holds that one out.
    expect(rowIds(c), "the sender marked spam is not listed under the row that was pressed")
      .toEqual(["gate1"]);

    // The mail really is in Quarantine now, and the release of it is refused.
    w.refuseMove = true;
    w.posts = [];
    await selectRow(c, "gate1");
    releaseScreenerRow(c, "ohbox");
    await tick(200);

    expect(w.posts.some((p) => p.startsWith("move gate1 → INBOX")), "no move was attempted").toBe(true);
    expect(rowIds(c), "the pinned row was replaced by one this press never named")
      .toEqual(["gate1"]);
    expect(noteOf(c, "gate1"), "the restored pin carries no refusal note").toContain("Not saved");
    expect(toastText()).toContain("could not be saved");
  }, 30000);
});

describe("a PARTIAL release — the case a mark on the pressed id would miss", () => {
  beforeEach(() => {
    installShellEnv();
    w = new World();
    // Two messages from one sender in Quarantine. The NEWEST is the derived row's id.
    w.add({ id: "old1", from: "junk@example.invalid", folder: QUARANTINE, date: "2026-08-01T09:00:00.000Z" });
    w.add({ id: "new1", from: "junk@example.invalid", folder: QUARANTINE, date: "2026-08-03T09:00:00.000Z" });
    // Only the OLDER one is refused, so the row comes back minted on a DIFFERENT message.
    w.refuseMoveOf = "old1";
    installWorld();
  });
  afterEach(teardownShellEnv);

  /**
   * MUTATION WATCHED (2026-08-13): narrow `refusalKeys` to `[sender.id]` — the shape a
   * `markRefused(id)` on the pressed row would have — and the row comes back under `old1` with NO
   * note, because the mark went on `new1`, which is now in the Ohbox and asked about by nothing.
   * Silent again, in exactly the case a partial failure produces.
   */
  it("the row that comes back under a new id still carries the note", async () => {
    const c = await openSegment("spam");
    expect(rowIds(c), "the derived row is not on the newest quarantined message").toEqual(["new1"]);

    await selectRow(c, "new1");
    releaseScreenerRow(c, "ohbox");
    await tick(300);

    // One landed, one did not — so the sender is still in Spam, on the message that stayed.
    expect(rowIds(c), "the partially released sender is listed on the wrong message").toEqual(["old1"]);
    expect(noteOf(c, "old1"), "the row that came back carries no refusal note").toContain("Not saved");
    expect(toastText(), "a partial release said nothing about the half that failed")
      .toContain("could not be saved");
  }, 30000);
});
