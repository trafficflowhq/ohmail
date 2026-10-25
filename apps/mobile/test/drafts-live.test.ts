/**
 * ═══ DRAFTS ON THE PHONE ════════════════════════════════════════════════════
 *
 * The hole this closes is not "a list is missing". A send whose verdict never came answers
 * `send_unverified`, the phone says so ONCE in a toast, and the row that holds the only copy of
 * a message that may never have been delivered was then invisible on this surface for ever —
 * the recovery story had a hole on exactly one of the three clients.
 *
 * So what is measured here is the DERIVED OUTPUT a person reads and presses, never a comment:
 *  · the three states a row can be in, told apart (`open` / `held` / `interrupted`) and the
 *    stale cut that separates the last two from an ordinary send still in flight;
 *  · `bodyKnown`, the one predicate that keeps "this mirror never received the text" apart from
 *    "nothing is written yet" — the distinction a recovery surface may not collapse;
 *  · `repliesHere`, measured against THIS mirror, because the row's sentence changes with it;
 *  · the four endings of a discard, including the server's `send_recorded` for a send still
 *    running, which the card says IN THE ROW rather than in a toast;
 *  · what a held row says it knows (checking Sent, not in Sent, interrupted) and the two acts;
 *  · the sentences, in both catalogues, as the webapp's `drafts.*` namespace words them.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EntityReader, MutationResult, WaitingSend } from "@ohmail/client-engine";
import { HELD_SEND_RECHECK_MS, SENDING_STALE_AFTER_MS } from "@ohmail/client-engine";
import { liveActions, liveDrafts, type LiveWorldActions } from "../src/state/live";
import { sayArg } from "../src/refusal";
import { DECKS } from "../src/copy";

const NOW = new Date("2026-09-20T15:00:00.000Z");
const v = { now: NOW, zone: "UTC", locale: "en" };

function readerOf(
  drafts: Record<string, unknown>[],
  messages: Record<string, unknown>[] = [],
): EntityReader {
  const bank: Record<string, Record<string, unknown>[]> = { draft: drafts, message: messages };
  return {
    list: <T,>(type: string): T[] => ((bank[type] ?? []) as unknown as T[]),
    get: <T,>(type: string, id: string): T | undefined =>
      (bank[type] ?? []).find((r) => r.id === id) as T | undefined,
  } as unknown as EntityReader;
}

const draftRow = (over: Record<string, unknown>) => ({
  id: "d-1", mailboxId: "mb-1", threadId: null, inReplyToMessageId: null,
  subject: "Invoice 12", body: "the body", to: [{ name: "Ada", address: "ada@fake.test" }],
  cc: [], bcc: [], rationale: null, status: "draft",
  createdAt: "2026-09-01T09:00:00.000Z", updatedAt: "2026-09-20T14:29:00.000Z",
  ...over,
});

/** A stale `sending` row — past every possible invocation lifetime, so the send died silent. */
const staleAt = new Date(NOW.getTime() - SENDING_STALE_AFTER_MS - 60_000).toISOString();
/** A `sending` row still inside the window: in flight, and deliberately NOT listed. */
const freshAt = new Date(NOW.getTime() - 5_000).toISOString();

describe("liveDrafts — the rows the Drafts screen renders", () => {
  it("lists open drafts, held sends and stale sending rows, most recently touched first", () => {
    const rows = liveDrafts(readerOf([
      draftRow({ id: "open", updatedAt: "2026-09-20T10:00:00.000Z" }),
      draftRow({ id: "held", status: "unverified", updatedAt: "2026-09-20T12:00:00.000Z" }),
      draftRow({ id: "stale", status: "sending", updatedAt: staleAt }),
      draftRow({ id: "inflight", status: "sending", updatedAt: freshAt }),
      draftRow({ id: "sent", status: "sent", updatedAt: "2026-09-20T13:00:00.000Z" }),
      draftRow({ id: "booked", status: "scheduled", updatedAt: "2026-09-20T13:30:00.000Z" }),
    ]), v);

    // A send still inside its window is in flight, not stranded — listing it would invite a
    // person to answer a question nobody has asked yet. `sent` and `scheduled` are elsewhere.
    expect(rows.map((r) => r.id)).toEqual(["stale", "held", "open"]);
    expect(rows.map((r) => r.state)).toEqual(["interrupted", "held", "open"]);
    // The held row was left three hours ago: the looking ended at twenty minutes.
    expect(rows.map((r) => r.heldSays)).toEqual(["interrupted", "notInSent", null]);
  });

  it("says what is known about a held send: checking Sent inside the window, not in Sent past it", () => {
    const at = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
    const rows = liveDrafts(readerOf([
      draftRow({ id: "fresh", status: "unverified", updatedAt: at(60_000) }),
      draftRow({ id: "edge", status: "unverified", updatedAt: at(HELD_SEND_RECHECK_MS) }),
      draftRow({ id: "old", status: "unverified", updatedAt: at(HELD_SEND_RECHECK_MS + 60_000) }),
      draftRow({ id: "garbled", status: "unverified", updatedAt: "not a stamp" }),
    ]), v);
    const says = Object.fromEntries(rows.map((r) => [r.id, r.heldSays]));
    // The server looks in Sent for exactly this long; at the edge it has stopped looking. An
    // unreadable stamp claims less: "it isn't in your Sent folder" never promises a search.
    expect(says).toEqual({ fresh: "checking", edge: "notInSent", old: "notInSent", garbled: "notInSent" });
  });

  it("checks for twenty minutes after the hold, then says it isn't in Sent", () => {
    const at = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
    const rows = liveDrafts(readerOf([
      draftRow({ id: "19", status: "unverified", updatedAt: at(19) }),
      draftRow({ id: "21", status: "unverified", updatedAt: at(21) }),
    ]), v);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.heldSays]))).toEqual({ 19: "checking", 21: "notInSent" });
  });

  it("keeps a body this mirror never received apart from a body with nothing in it", () => {
    const rows = liveDrafts(readerOf([
      draftRow({ id: "unknown", body: null, bodyOmitted: "over_page_budget" }),
      draftRow({ id: "blank", body: "", updatedAt: "2026-09-20T13:00:00.000Z" }),
    ]), v);
    const unknown = rows.find((r) => r.id === "unknown")!;
    const blank = rows.find((r) => r.id === "blank")!;
    expect(unknown.bodyKnown, "a row that arrived without a body is NOT an empty message").toBe(false);
    expect(blank.bodyKnown, "the empty string is a known body — the one edit that empties a message").toBe(true);
    expect(unknown.preview).toBe("");
    expect(blank.preview).toBe("");
  });

  it("answers repliesHere from THIS mirror, and names the parent only where it is held", () => {
    const held = liveDrafts(readerOf(
      [draftRow({ id: "r1", inReplyToMessageId: "m-here" })],
      [{ id: "m-here" }],
    ), v)[0]!;
    expect(held.repliesHere).toBe(true);
    expect(held.inReplyToMessageId).toBe("m-here");

    const absent = liveDrafts(readerOf([draftRow({ id: "r2", inReplyToMessageId: "m-elsewhere" })]), v)[0]!;
    expect(absent.repliesHere, "promising a conversation this device does not hold is worse "
      + "than offering nothing").toBe(false);
    expect(absent.inReplyToMessageId).toBeNull();
  });

  it("renders the row's facts: recipients on one line, the empty subject named, the failure quoted", () => {
    const row = liveDrafts(readerOf([draftRow({
      subject: "   ",
      to: [{ name: "Ada", address: "ada@fake.test" }],
      cc: [{ name: null, address: "cc@fake.test" }],
      bcc: [{ name: "Bee", address: "bee@fake.test" }],
      body: "line one\n\nline  two",
      sendError: "the server said no",
    })]), v)[0]!;
    expect(row.subject).toBe(DECKS.en.scheduledNoSubject);
    expect(row.to).toBe("Ada, cc@fake.test, Bee");
    expect(row.preview).toBe("line one line two");
    expect(row.failure).toBe("the server said no");
    // The stamp is read in the reader's own clock, never the draft's.
    expect(row.when).not.toBe("");
  });
});

/** The engine seam a press crosses — `mutate`, and the waiting sends a discard withdraws first. */
function engineAnswering(answer: MutationResult | Error, waiting: readonly WaitingSend[] = [], withdraw = "withdrawn") {
  const seen: { kind: string; draftId?: string; outcome?: string; key?: string }[] = [];
  const engine = {
    mutate: (m: { kind: string; draftId: string; outcome?: string }) => {
      seen.push(m);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    waitingSends: () => waiting,
    withdrawQueued: (key: string) => { seen.push({ kind: "withdraw", key }); return Promise.resolve(withdraw); },
    read: () => readerOf([draftRow({})]),
    syncOnce: () => Promise.resolve(),
  };
  return { engine, seen };
}

function actionsOver(answer: MutationResult | Error, waiting: readonly WaitingSend[] = [], withdraw = "withdrawn"): {
  actions: LiveWorldActions;
  said: string[];
  seen: { kind: string; draftId?: string; outcome?: string; key?: string }[];
} {
  const { engine, seen } = engineAnswering(answer, waiting, withdraw);
  const said: string[] = [];
  const actions = liveActions({
    engine: engine as never,
    toast: (say) => said.push(sayArg(say)),
    now: () => NOW,
    zone: "UTC",
  });
  return { actions, said, seen };
}

const confirmed: MutationResult = { id: "x", key: "x", status: "confirmed", seq: 1 } as MutationResult;

describe("draftDiscard — four endings, and three of them are not failures", () => {
  it("a confirmed delete is the only silent one", async () => {
    const { actions, said, seen } = actionsOver(confirmed);
    expect(await actions.draftDiscard("d-1")).toBe("discarded");
    expect(seen).toEqual([{ kind: "draft_discard", draftId: "d-1" }]);
    expect(said, "a delete that happened needs no sentence — the row leaves").toEqual([]);
  });

  it("the server's send_recorded is a send still running, said in the row — no toast", async () => {
    const { actions, said } = actionsOver({
      id: "x", key: "x", status: "rolled_back", seq: null,
      error: { code: "send_recorded", message: "a send is on record", status: 409, retryable: false },
    } as unknown as MutationResult);
    expect(await actions.draftDiscard("d-1")).toBe("stillSending");
    expect(said, "a toast pointing somewhere else is the retired shape").toEqual([]);
  });

  it("a wait is told apart by WHO is waiting, and never as done", async () => {
    /* Two engine statuses, not one flag: `queued` is this phone's own outbox and
       `awaiting_organizer` is the SERVER's record on an account another install organizes.
       `pressVerdict` is the one reading, and the sentences differ because the two ask different
       things of the reader — "we will keep trying" against "it happens over there". */
    const mine = actionsOver({ id: "x", key: "x", status: "queued", seq: null } as MutationResult);
    expect(await mine.actions.draftDiscard("d-1")).toBe("queued");
    expect(mine.said).toEqual([DECKS.en.draftsDiscardQueued]);

    const theirs = actionsOver({
      id: "x", key: "x", status: "awaiting_organizer", seq: null, queuedWith: { name: "laptop" },
    } as unknown as MutationResult);
    expect(await theirs.actions.draftDiscard("d-1")).toBe("queued");
    expect(theirs.said).toEqual([DECKS.en.draftsDiscardAwaitingOrganizer]);
  });

  it("a named refusal is quoted; an unnamed one says the draft is still here", async () => {
    const named = actionsOver({
      id: "x", key: "x", status: "rolled_back", seq: null,
      error: { code: "forbidden", message: "not yours", status: 403, retryable: false },
    } as unknown as MutationResult);
    expect(await named.actions.draftDiscard("d-1")).toBe("refused");
    expect(named.said).toEqual([DECKS.en.draftsDiscardRefused("not yours")]);

    const threw = actionsOver(new Error("the client failed"));
    expect(await threw.actions.draftDiscard("d-1")).toBe("refused");
    expect(threw.said).toEqual([DECKS.en.draftsDiscardRefusedUnnamed]);
  });
});

describe("draftResolve — the one way out of a held send", () => {
  it("carries the person's answer to the engine and reports only a CONFIRMED one", async () => {
    const yes = actionsOver(confirmed);
    expect(await yes.actions.draftResolve("d-1", "arrived")).toBe(true);
    expect(yes.seen).toEqual([{ kind: "draft_resolve", draftId: "d-1", outcome: "arrived" }]);
    expect(yes.said).toEqual([]);

    const no = actionsOver({ id: "x", key: "x", status: "queued", seq: null } as MutationResult);
    expect(await no.actions.draftResolve("d-1", "not_arrived"), "a queued answer leaves the "
      + "row held — the row is the only record that a message may be undelivered").toBe(false);
    expect(no.said).toEqual([DECKS.en.draftsResolveFailed]);
  });

  it("a send that may still be running is told as NOT YET, apart from a failure", async () => {
    const running = actionsOver({
      id: "x", key: "x", status: "rolled_back", seq: null,
      error: { code: "send_still_running", message: "running", status: 409, retryable: false },
    } as unknown as MutationResult);
    expect(await running.actions.draftResolve("d-1", "arrived")).toBe(false);
    expect(running.said).toEqual([DECKS.en.draftsResolveStillRunning]);
  });
});

const waitingSend = (over: Partial<WaitingSend> = {}): WaitingSend => ({
  id: "q-1", key: "k-1", draftId: "d-1", paintId: "p-1", wire: false, at: NOW.getTime() - 60_000,
  mutation: {
    kind: "mail_send", inReplyTo: null, mailboxId: "mb-1", subject: "Offline", body: "Written  on a train.",
    to: [{ name: "Bo", address: "bo@fake.test" }], cc: [], bcc: [],
  },
  ...over,
} as WaitingSend);

describe("a waiting send in the list", () => {
  it("is listed first as waiting, newest press first, and hides the row and the placeholder it names", () => {
    const rows = liveDrafts(readerOf([
      draftRow({ id: "d-1", subject: "the row the send names" }),
      draftRow({ id: "p-1", status: "sending", updatedAt: staleAt, subject: "Offline", to: [{ name: "Bo", address: "bo@fake.test" }] }),
      draftRow({ id: "open", updatedAt: "2026-09-20T14:59:00.000Z" }),
    ]), v, [
      waitingSend(),
      waitingSend({ id: "q-2", key: "k-2", draftId: null, paintId: null, at: NOW.getTime() - 5_000, mutation: {
        ...waitingSend().mutation, subject: "  ",
      } }),
    ]);
    expect(rows.map((r) => [r.id, r.state]), "a waiting send is missing, listed twice, or listed after a draft")
      .toEqual([["q-2", "waiting"], ["d-1", "waiting"], ["open", "open"]]);
    expect(rows[0]!.waiting).toEqual({ key: "k-2", wire: false, rowless: true });
    expect(rows[1]).toMatchObject({
      subject: "Offline", to: "Bo", preview: "Written on a train.", edit: null, heldSays: null,
      waiting: { key: "k-1", wire: false, rowless: false },
    });
    expect(rows[0]!.subject).toBe(DECKS.en.scheduledNoSubject);
    expect(rows[2]!.waiting).toBeNull();
  });

  it("the head counts what waits to send apart from what is not confirmed", () => {
    expect(DECKS.en.draftsMeta(3, 1, 2)).toBe("3 drafts · 1 not confirmed · 2 waiting to send");
    expect(DECKS.en.draftsMeta(1, 0, 1)).toBe("1 draft · 1 waiting to send");
    expect(DECKS.en.draftsMeta(2, 0, 0)).toBe("2 drafts");
    expect(DECKS.de.draftsMeta(1, 0, 1)).toBe("1 Entwurf · 1 wartet auf den Versand");
    expect(DECKS.de.draftsMeta(2, 0, 2)).toBe("2 Entwürfe · 2 warten auf den Versand");
  });
});

describe("draftDiscard over a waiting send — the Cancel comes first", () => {
  it("withdraws the send before the delete and says nothing was sent", async () => {
    const { actions, said, seen } = actionsOver(confirmed, [waitingSend()]);
    expect(await actions.draftDiscard("d-1")).toBe("discarded");
    expect(seen.map((x) => x.kind), "the row was deleted under its waiting send").toEqual(["withdraw", "draft_discard"]);
    expect(said).toEqual([DECKS.en.draftsDiscardedNotSent]);
  });

  it("a send with no row yet is only withdrawn", async () => {
    const { actions, said, seen } = actionsOver(confirmed, [waitingSend({ draftId: null })]);
    expect(await actions.draftDiscard("q-1")).toBe("discarded");
    expect(seen.map((x) => x.kind)).toEqual(["withdraw"]);
    expect(said).toEqual([DECKS.en.draftsDiscardedNotSent]);
  });

  it("a send already on its way, or a Cancel nobody answered, deletes nothing and says nothing here", async () => {
    for (const [answer, outcome] of [["on_the_wire", "alreadySent"], ["unknown", "cancelUnknown"]] as const) {
      const { actions, said, seen } = actionsOver(confirmed, [waitingSend()], answer);
      expect(await actions.draftDiscard("d-1")).toBe(outcome);
      expect(seen.map((x) => x.kind), `${answer}: the row was deleted`).toEqual(["withdraw"]);
      expect(said, "the card says it in the row").toEqual([]);
    }
  });
});

const MESSAGES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "webapp", "messages");
const webDrafts = (locale: "en" | "de") =>
  (JSON.parse(fs.readFileSync(path.join(MESSAGES, `${locale}.json`), "utf8")) as { drafts: Record<string, string> }).drafts;

/** Each phone key and the webapp `drafts.*` key it says word for word, in both languages. */
const SAME_AS_WEB = {
  draftsHeldChecking: "heldChecking",
  draftsHeldNotInSent: "heldNotInSent",
  draftsHeldInterrupted: "heldInterrupted",
  draftsSendAgain: "sendAgain",
  draftsItWasSent: "itWasSent",
  draftsDiscardWhat: "discardWhat",
  draftsDiscardConfirm: "discardConfirm",
  draftsDiscardCancel: "discardCancel",
  draftsDiscardStillSending: "discardStillSending",
  draftsResolveStillRunning: "resolveStillRunning",
} as const;

describe("the sentences", () => {
  it("say what the webapp's drafts namespace says, word for word, in English and German", () => {
    for (const locale of ["en", "de"] as const) {
      const web = webDrafts(locale);
      for (const [phone, key] of Object.entries(SAME_AS_WEB)) {
        expect(web[key], `the web catalogue has drafts.${key} (${locale})`).toBeTruthy();
        expect(DECKS[locale][phone as keyof typeof SAME_AS_WEB], `${phone} (${locale})`).toBe(web[key]);
      }
    }
  });

  it("carry nothing of the retired question, in either deck", () => {
    for (const locale of ["en", "de"] as const) {
      const deck = DECKS[locale] as unknown as Record<string, unknown>;
      const said = Object.values(deck).filter((x): x is string => typeof x === "string").join("\n");
      expect(said).not.toMatch(/Did this message arrive|It didn't arrive|Ist diese Nachricht angekommen/);
    }
  });

  it("are in both catalogues, and a refusal renders in the language active at render", async () => {
    for (const key of ["draftsTitle", "draftsHeldChecking", "draftsDiscardWhat", "draftsSendAgainWhat", "draftsEditNote"] as const) {
      expect(DECKS.de[key], `${key} is missing from the German deck`).toBeTruthy();
      expect(DECKS.de[key]).not.toBe(DECKS.en[key]);
    }
    /* The toast carries a REFUSAL, not a sentence (`src/refusal.ts`): raised here and rendered
       at read, so a language switch with one on screen turns it over too. */
    const { actions, said } = actionsOver({
      id: "x", key: "x", status: "rolled_back", seq: null,
      error: { code: "send_still_running", message: "x", status: 409, retryable: false },
    } as unknown as MutationResult);
    expect(await actions.draftResolve("d-1", "arrived")).toBe(false);
    expect(said).toEqual([DECKS.en.draftsResolveStillRunning]);
  });
});
