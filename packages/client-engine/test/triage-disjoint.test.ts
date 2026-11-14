import { describe, expect, it } from "vitest";
import {
  OhmailEngine,
  isResurfaced,
  ohboxView,
  parkedMessageIds,
  pileOfState,
  triagePiles,
  winningStates,
  type EngineMessage,
  type EntityReader,
  type MessageStateDTO,
} from "@ohmail/client-engine";
import { DEMO_NOW, FixturesAdapter } from "@ohmail/testing/adapter";

/**
 * A MAIL IS IN EXACTLY ONE PILE — asserted over the DERIVATION, not over one fixture.
 *
 * ## THE DEFECT
 *
 * `triagePiles` files a message into a bottom pile from its `message_state` record. `ohboxView`
 * grouped by FOLDER and held out only `isResurfaced` rows, so it knew nothing about that record.
 * Nothing moves a parked message's folder — `TriageService.setState` writes state and never
 * `folder_state` — so EVERY message the reader had put away was listed in a bottom pile AND in an
 * Ohbox group at the same time. Not an edge case: every parked message the product has ever had.
 *
 * The way it was reported is the sharpest form. Deferring an ALREADY-RESURFACED row ("resurface
 * tomorrow" on a row sitting in the pin group) writes `bubbled_up` while the row still carries the
 * forced `unread: true` its resurface put there — `mutations.ts` re-unreads on `resurfaced` only,
 * and nothing takes it back. So the row left the pin group, was filed under Resurface, and came
 * straight back at the TOP OF THE OHBOX under "New for you", bold, as if it had just arrived; when
 * its read state settled it sank into "Earlier", still listed under Resurface the whole time. The
 * reader put it away twice and the product handed it back twice.
 *
 * ## WHY THIS FILE IS STRUCTURAL AND THE OTHER GUARDS ARE NOT ENOUGH
 *
 * `selectors.test.ts` pins the demo world's Ohbox and `triage-pile-parity.test.ts` pins the pile
 * COUNTS through a transition. Both are assertions about one fixture: they go green again the
 * moment somebody adds a triage state neither of them seeds. The bug above was reachable from a
 * state combination no fixture had.
 *
 * So this enumerates the product of {triage states} × {read} × {folder} and asserts a PROPERTY:
 * no message id appears in two of the six piles, whatever put it there. A new triage state, a new
 * Ohbox group, or a mutation that writes an unexpected combination fails here without anybody
 * having to think of it — which is the TRI-F5 lesson one level up. `pileOfState` is the single
 * derivation both sides read; two spellings of it were the whole defect.
 */

const OHBOX = "INBOX";
/** Every folder a message can be presented in that any pile here reads. */
const FOLDERS = [OHBOX, "ohmail/News", "ohmail/Receipts"] as const;
/**
 * Every state the wire can put on a `message_state` row, plus the absence of one.
 *
 * `resurfaced` is on the wire and is deliberately NOT a member of `TriageState`
 * (`selectors.ts#isResurfaced` says why), so it is spelled as a string here exactly as the server
 * sends it. `muted` and `none` are the two that park nothing and are included for that reason: a
 * guard that only seeded the parking states could not tell "held out correctly" from "held out
 * always".
 */
const STATES = [
  null, "none", "muted", "reply_later", "set_aside", "bubbled_up", "resurfaced",
] as const;

function mkMsg(p: Partial<EngineMessage> & { id: string }): EngineMessage {
  return {
    accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `s-${p.id}`, from: { name: "N", address: "n@example.invalid" },
    to: [], cc: [], date: "2026-08-01T09:00:00.000Z", folder: OHBOX,
    snippet: "", unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-01T09:00:00.000Z",
    ...p,
  } as EngineMessage;
}

/** A hand-built reader over a flat entity list — the same shape `selectors.test.ts` uses. */
function readerOf(byType: Record<string, unknown[]>): EntityReader {
  return {
    list: <T,>(type: string) => (byType[type] ?? []) as T[],
    get: <T,>(type: string, id: string) =>
      (byType[type] ?? []).find((e) => (e as { id?: string }).id === id) as T | undefined,
    // `entries` and `version` are not optional members of the interface, and a partial fake is
    // not a reader: `winningStates` caches on the stamp, and these fixtures are frozen.
    entries: <T,>(type: string) => (byType[type] ?? []).map((entity, i) => ({
      id: (entity as { id?: string }).id ?? String(i), entity: entity as T, seq: i,
    })),
    version: () => 1,
  };
}

const stateOf = (messageId: string, state: string): MessageStateDTO => ({
  messageId,
  state: state as MessageStateDTO["state"],
  bubbleUpAt: state === "bubbled_up" ? "2026-09-01T09:00:00.000Z" : null,
  setAt: "2026-08-01T09:00:00.000Z",
  updatedAt: "2026-08-01T09:00:00.000Z",
});

/** Which of the six piles each message id appears in, for one reader. */
function pilesOf(reader: EntityReader): Map<string, string[]> {
  const view = ohboxView(reader);
  const piles = triagePiles(reader);
  const membership = new Map<string, string[]>();
  const note = (id: string | undefined, pile: string): void => {
    if (id == null) return; // a fixture-only `triage_item` orphan has no message
    const held = membership.get(id);
    if (held) held.push(pile);
    else membership.set(id, [pile]);
  };
  for (const m of view.resurfaced) note(m.id, "ohbox:resurfaced");
  for (const m of view.newForYou) note(m.id, "ohbox:newForYou");
  for (const m of view.previouslySeen) note(m.id, "ohbox:previouslySeen");
  for (const e of piles.replyLater) note(e.messageId, "pile:replyLater");
  for (const e of piles.setAside) note(e.messageId, "pile:setAside");
  for (const e of piles.resurface) note(e.messageId, "pile:resurface");
  return membership;
}

/** Every id that landed in more than one pile, with the piles named. */
const doubled = (reader: EntityReader): string[] =>
  [...pilesOf(reader)]
    .filter(([, piles]) => piles.length > 1)
    .map(([id, piles]) => `${id} → ${piles.join(" + ")}`);

describe("the pile derivation is DISJOINT over every triage-state combination", () => {
  /**
   * THE WHOLE PRODUCT, IN ONE MIRROR. 7 states × 2 read states × 3 folders = 42 rows, each a
   * distinct id, all in one reader so a cross-row mistake (an id leaking between piles) shows too.
   *
   * MUTATION WATCHED (2026-08-13): revert `ohboxView`'s `held()` to `!pinned.has(m.id)` and this
   * reports exactly six doubled ids — the three parking states × unread/read, all in the Ohbox
   * folder, each named with both of its piles:
   *
   *   m-reply_later-u-INBOX → ohbox:newForYou       + pile:replyLater
   *   m-set_aside-u-INBOX   → ohbox:newForYou       + pile:setAside
   *   m-bubbled_up-u-INBOX  → ohbox:newForYou       + pile:resurface
   *   m-reply_later-r-INBOX → ohbox:previouslySeen  + pile:replyLater
   *   m-set_aside-r-INBOX   → ohbox:previouslySeen  + pile:setAside
   *   m-bubbled_up-r-INBOX  → ohbox:previouslySeen  + pile:resurface
   *
   * The Reads and Receipts rows do NOT double, which is the scope of the fix stated as data:
   * `ohboxView` is the only surface that holds parked rows out.
   */
  it("no message is ever in two of the six piles", () => {
    const messages: EngineMessage[] = [];
    const states: MessageStateDTO[] = [];
    for (const state of STATES) {
      for (const unread of [true, false]) {
        for (const folder of FOLDERS) {
          const id = `m-${state ?? "nostate"}-${unread ? "u" : "r"}-${folder.replace(/\W/g, "")}`;
          // `message.triage` carries the SAME record the entity does — which is what the server
          // emits (`TriageService.setState` records both) and what the optimistic effect writes.
          const triage = state === null ? null : stateOf(id, state);
          messages.push(mkMsg({ id, folder, unread, triage }));
          if (triage) states.push(triage);
        }
      }
    }
    const reader = readerOf({ message: messages, message_state: states });

    expect(messages).toHaveLength(STATES.length * 2 * FOLDERS.length);
    expect(doubled(reader), "a message is in two piles at once").toEqual([]);
  });

  /**
   * AND EVERY PARKED ROW IS IN A PILE — the other half, because "disjoint" is satisfied by a row
   * that is in NO pile at all, and a message the product loses is worse than one it doubles.
   *
   * The three parking states must each land in exactly one bottom pile; `resurfaced` must land in
   * the Ohbox pin and nowhere else; `none` / `muted` / no-record must stay ordinary Ohbox mail.
   */
  it("every state lands in exactly one pile, and it is the right one", () => {
    const expected: Record<string, string> = {
      reply_later: "pile:replyLater",
      set_aside: "pile:setAside",
      bubbled_up: "pile:resurface",
      resurfaced: "ohbox:resurfaced",
      none: "ohbox:newForYou",
      muted: "ohbox:newForYou",
      nostate: "ohbox:newForYou",
    };
    for (const state of STATES) {
      const key = state ?? "nostate";
      const id = `only-${key}`;
      const triage = state === null ? null : stateOf(id, state);
      const reader = readerOf({
        // Unread and in the Ohbox folder — the row a parked state has to be taken OUT of.
        message: [mkMsg({ id, folder: OHBOX, unread: true, triage })],
        message_state: triage ? [triage] : [],
      });
      const membership = pilesOf(reader).get(id) ?? [];
      expect(membership, `state ${key} is in the wrong number of piles`).toHaveLength(1);
      expect(membership[0], `state ${key} landed in the wrong pile`).toBe(expected[key]);
    }
  });

  /**
   * THE FILTER AND THE LISTER READ ONE FUNCTION, asserted directly rather than through the lists.
   *
   * `parkedMessageIds` is `winningStates` + `pileOfState`, and so is `triagePiles`. If either ever
   * grows its own copy of "which states park", this is the assertion that notices before a surface
   * does: the parked set must be exactly the ids the three bottom piles name.
   */
  it("the parked set is exactly the message ids the bottom piles list", () => {
    const messages: EngineMessage[] = [];
    const states: MessageStateDTO[] = [];
    for (const state of STATES) {
      if (state === null) continue;
      const id = `p-${state}`;
      const triage = stateOf(id, state);
      messages.push(mkMsg({ id, triage }));
      states.push(triage);
    }
    const reader = readerOf({ message: messages, message_state: states });
    const piles = triagePiles(reader);
    const listed = new Set(
      [...piles.replyLater, ...piles.setAside, ...piles.resurface]
        .map((e) => e.messageId)
        .filter((x): x is string => x != null),
    );
    expect([...parkedMessageIds(reader)].sort()).toEqual([...listed].sort());
  });

  /**
   * TWO RECORDS FOR ONE MESSAGE — the live server's row-uuid key beside an overlay's message-id
   * key. The newest claim wins for BOTH readers, so a stale `reply_later` record standing beside a
   * fresh `bubbled_up` one may not put the message in two piles.
   */
  it("a message with two `message_state` records is parked by its NEWEST claim only", () => {
    const id = "twin";
    const stale: MessageStateDTO = { ...stateOf(id, "reply_later"), updatedAt: "2026-08-01T09:00:00.000Z" };
    const fresh: MessageStateDTO = { ...stateOf(id, "bubbled_up"), updatedAt: "2026-08-02T09:00:00.000Z" };
    const reader = readerOf({
      message: [mkMsg({ id, unread: true, triage: fresh })],
      message_state: [stale, fresh],
    });
    expect(winningStates(reader).get(id)?.state).toBe("bubbled_up");
    expect(pilesOf(reader).get(id)).toEqual(["pile:resurface"]);
    expect(doubled(reader)).toEqual([]);
  });

  /** `pileOfState` is the contract both sides read; its arms are the six-pile split itself. */
  it("pileOfState files exactly the three parking states and refuses the rest", () => {
    expect(pileOfState("reply_later")).toBe("replyLater");
    expect(pileOfState("set_aside")).toBe("setAside");
    expect(pileOfState("bubbled_up")).toBe("resurface");
    // `resurfaced` is the Ohbox pin, NOT a bottom pile — widen this and a pinned row doubles.
    expect(pileOfState("resurfaced")).toBeNull();
    expect(pileOfState("muted")).toBeNull();
    expect(pileOfState("none")).toBeNull();
    expect(pileOfState("something-a-later-server-invents")).toBeNull();
  });
});

/**
 * THE DEMO WORLD, WHICH IS THE ONE A READER ACTUALLY SEES on `?demo` — and which SHOWED this bug.
 *
 * The Answer Later pile was `giulia` and `petra`, which were the first two rows of "New for you"
 * at the same time. The synthetic mirror above proves the property; this proves the shipped
 * fixture obeys it, because a demo that displays the defect is the defect.
 *
 * The ids moved once the rule was honoured: parking those two took the demo's opening message and
 * its attachment row off the Ohbox screen, so the fixture parks `nadja` and `jonas` — mail written
 * for the pile — and Giulia and Petra are Ohbox rows again. The assertion is about the STRUCTURE
 * either way: whatever the demo parks is in its pile and in no Ohbox group.
 */
describe("the demo world obeys the same rule", () => {
  it("no fixture message is in two piles, and the parked two are in the pile only", async () => {
    const engine = new OhmailEngine({ adapter: new FixturesAdapter(), now: () => DEMO_NOW });
    await engine.start();
    const r = engine.read();

    expect(doubled(r)).toEqual([]);
    expect(pilesOf(r).get("nadja")).toEqual(["pile:replyLater"]);
    expect(pilesOf(r).get("jonas")).toEqual(["pile:replyLater"]);
    // And the pair that used to be parked is back where the demo wants them: on the Ohbox, once.
    expect(pilesOf(r).get("giulia")).toEqual(["ohbox:newForYou"]);
    expect(pilesOf(r).get("petra")).toEqual(["ohbox:newForYou"]);
  });

  /**
   * RE-RESURFACE, END TO END ON THE DEMO ENGINE: pin a row, then defer it. It must leave the pin
   * group and every other Ohbox group in the SAME read, and be in the Resurface pile alone.
   *
   * The `unread` assertion is the mechanism, kept explicit: the row is STILL `unread: true` after
   * the deferral, because `mutations.ts` re-unreads for `resurfaced` and nothing clears it on the
   * way out. That flag is why the row used to reappear at the top of "New for you", and the point
   * of the fix is that the flag no longer decides anything — the pile does.
   */
  it("deferring an already-resurfaced row leaves the Ohbox entirely, still unread", async () => {
    const engine = new OhmailEngine({ adapter: new FixturesAdapter(), now: () => DEMO_NOW });
    await engine.start();

    await engine.mutate({ kind: "triage_set", messageId: "ben", state: "resurfaced" });
    expect(ohboxView(engine.read()).resurfaced.map((m) => m.id)).toEqual(["ben"]);

    await engine.mutate({
      kind: "triage_set", messageId: "ben", state: "bubbled_up",
      bubbleUpAt: "2026-08-03T09:00:00.000Z",
    });

    const r = engine.read();
    const row = r.get<EngineMessage>("message", "ben")!;
    expect(row.unread, "the resurface's forced unread is still on the row").toBe(true);
    expect(isResurfaced(row), "it is no longer resurfaced — it is re-parked").toBe(false);
    expect(pilesOf(r).get("ben")).toEqual(["pile:resurface"]);
    expect(doubled(r)).toEqual([]);
  });
});
