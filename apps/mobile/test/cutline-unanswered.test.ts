/**
 * THE FIRST PAINT MAY NOT SHOW MAIL THAT THEN VANISHES.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────────────────────
 *
 * Which senders are still worth a decision is the ACCOUNT's setting, read once per session over
 * `GET /consent`. Until that read lands there is no window to partition by, and `presentedWorld`
 * answered the gap with `all_time` — the mode that retires NOBODY. So the Screener's derived
 * shelf opened holding every undecided sender the mirror knows and History opened empty, and the
 * moment the answer arrived the shelf shrank to the senders the account's own window admits and
 * the rest reappeared under History. One shrink per boot, on the first screen, about mail.
 *
 * `null` was carrying two different facts to make that happen: "the read has not landed YET" and
 * "there is no answer to be had" (a server with none of the three fields, or the standalone door,
 * which has no server to ask). The second is settled and `all_time` is its right answer. The
 * first is UNKNOWN, and the only honest rendering of an unknown list is not to state it.
 *
 * ── WHAT IS DRIVEN HERE ───────────────────────────────────────────────────────────────────
 *
 * Real senders' mail in the gate folder on a real loopback server, drained by the real engine
 * through `bootEngine`, read through the screens' own selectors — `history-surface.test.ts`'s
 * harness. The surfaces themselves are asserted over their source: there is no React Native
 * renderer in this workspace.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FOLDER_OF_VIEW, IMPORT_FLOOR_MAX_MS, type EngineMessage } from "@ohmail/client-engine";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import {
  liveHistory,
  liveScreener,
  presentedWorld,
  screeningAnswered,
  SCREENING_UNANSWERED,
  SCREENING_UNSUPPLIED,
  type WorldView,
} from "../src/state/live";
import { listSurface, metaWhen } from "../src/state/surface";
import { firstPassWithholds } from "../src/state/seed-offer";
import type { ServerWaitingSender } from "../src/net/screener";
import { DECKS } from "../src/copy";
import { LOCALES } from "../src/i18n/locale";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const NOW = new Date("2026-09-11T12:00:00.000Z");

/** The account's own answer: a real baseline and the window mode, so it retires somebody. */
const ANSWER = { dormancyDays: 60, baselineAt: "2026-01-01T00:00:00.000Z", scope: "window" } as const;
const ANSWERED = screeningAnswered(ANSWER);

/** Recent and unread: active under this window, so its sender waits at the gate. */
const RECENT = "2026-08-20T08:00:00.000Z";
/** Old and read: before `baseline - 60d` (2025-11-02), so its sender is retired to History. */
const OLD = "2024-02-01T08:00:00.000Z";

const world = sqlWorld();
const deps: MobileEngineDeps = {
  openExecutor: world.open,
  deleteDatabase: world.drop,
  uuid: (() => {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  })(),
};

function at(fake: ReturnType<typeof mailServer>, id: string, sender: number, date: string, unread: boolean): void {
  fake.addMessage(dto(id, {
    subject: id,
    folder: FOLDER_OF_VIEW.screener,
    from: { name: `Stranger ${sender}`, address: `stranger${sender}@fake.test` },
    date,
    unread,
  }));
}

async function bootOn(fake: ReturnType<typeof mailServer>, origin: string) {
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error(`boot refused: ${boot.kind === "refused" ? boot.reason : ""}`);
  await boot.verifyIdentity();
  await boot.engine.start();
  return boot;
}

/**
 * SIX SENDERS AT THE GATE — two the account's window keeps waiting, four it retires. The split is
 * what makes the superset visible: the posture with no answer behind it admits all six.
 */
function sixAtTheGate(fake: ReturnType<typeof mailServer>): void {
  at(fake, "w-1", 1, RECENT, true);
  at(fake, "w-2", 2, RECENT, true);
  at(fake, "h-3", 3, OLD, false);
  at(fake, "h-4", 4, OLD, false);
  at(fake, "h-5", 5, OLD, false);
  at(fake, "h-6", 6, OLD, false);
}

/** Both arms of one partition under one posture, the way the world layer derives them. */
function paint(
  reader: Parameters<typeof presentedWorld>[0],
  screening: Parameters<typeof presentedWorld>[3],
  server: readonly ServerWaitingSender[] | null = null,
) {
  const v: WorldView = { now: NOW, zone: "UTC", screening };
  const parted = presentedWorld(reader, NOW, false, screening);
  const screener = liveScreener(parted.reader, v, {}, server);
  return {
    cutlinePending: parted.cutlinePending,
    waiting: screener.waiting.map((r) => r.address).sort(),
    waitingPending: screener.waitingPending,
    screened: screener.screened.length,
    spam: screener.spam.length,
    history: liveHistory(reader, parted.history, v),
    projected: parted.reader.list<EngineMessage>("message").length,
  };
}

describe("an unanswered cutline is a third state, and it is narrower than either answer", () => {
  it("THE MEASUREMENT: the answerless posture's shelf is a strict SUPERSET of the answered one", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      sixAtTheGate(fake);
      const boot = await bootOn(fake, origin);
      const reader = boot.engine.read();

      /* `all_time` is what BOTH answerless postures must partition by — it is the only one that
         deletes no row — and it is therefore also the widest queue any answer can produce. */
      const wide = paint(reader, SCREENING_UNSUPPLIED);
      const answered = paint(reader, ANSWERED);
      expect(wide.waiting).toHaveLength(6);
      expect(answered.waiting).toEqual(["stranger1@fake.test", "stranger2@fake.test"]);

      /* THE SUPERSET, NAMED: four senders are on the wide shelf and not on the answered one. Paint
         the wide shelf while the answer is in flight and those four are mail on the first screen
         that leaves it again — which is why the unanswered posture may not use it. */
      const vanish = wide.waiting.filter((a) => !answered.waiting.includes(a));
      expect(vanish).toEqual(
        [3, 4, 5, 6].map((n) => `stranger${n}@fake.test`),
      );
      // …and they are not lost, they MOVE: the other arm of the same partition takes them.
      expect(answered.history.items.map((m) => m.from.address).sort()).toEqual(vanish);
      expect(wide.history.total).toBe(0);
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("UNANSWERED WITHHOLDS both piles and marks them — never the wider scope, never a silent empty", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      sixAtTheGate(fake);
      const boot = await bootOn(fake, origin);
      const reader = boot.engine.read();

      const pending = paint(reader, SCREENING_UNANSWERED);
      expect(pending.cutlinePending).toBe(true);
      // The shelf the account's window decides: withheld, and SAID to be.
      expect(pending.waiting).toEqual([]);
      expect(pending.waitingPending).toBe(true);
      // History's other half: empty because nothing is decided yet, and it says that too.
      expect(pending.history.items).toEqual([]);
      expect(pending.history.total).toBe(0);
      expect(pending.history.pending).toBe(true);

      /* WITHHELD IS NOT NARROWED: no row is deleted from the projection while the answer is in
         flight, so nothing anywhere else on the phone loses mail for this wait — the Ohbox, the
         folders and the reading screen all read this reader. */
      expect(pending.projected).toBe(6);
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("MONOTONE: when the answer lands, membership only GROWS", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      sixAtTheGate(fake);
      const boot = await bootOn(fake, origin);
      const reader = boot.engine.read();

      const before = paint(reader, SCREENING_UNANSWERED);
      const after = paint(reader, ANSWERED);

      // Nothing on the first paint is missing from the second — the transition adds, never removes.
      expect(before.waiting.filter((a) => !after.waiting.includes(a))).toEqual([]);
      const beforeHistory = before.history.items.map((m) => m.id);
      const afterHistory = after.history.items.map((m) => m.id);
      expect(beforeHistory.filter((id) => !afterHistory.includes(id))).toEqual([]);
      expect(after.waiting.length).toBeGreaterThan(before.waiting.length);
      expect(afterHistory.length).toBeGreaterThan(beforeHistory.length);

      // …and the answered paint is the ANSWER's own scope, not a narrowed one: the withholding
      // ends with the read rather than lingering as a smaller list.
      expect(after.waiting).toEqual(["stranger1@fake.test", "stranger2@fake.test"]);
      expect(afterHistory.sort()).toEqual(["h-3", "h-4", "h-5", "h-6"]);
      expect(after.cutlinePending).toBe(false);
      expect(after.waitingPending).toBe(false);
      expect(after.history.pending).toBe(false);
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("UNSUPPLIED is not a wait: nobody can answer, so the shelf stands and nothing is marked", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      sixAtTheGate(fake);
      const boot = await bootOn(fake, origin);
      const reader = boot.engine.read();

      /* A server carrying none of the three fields, and the standalone door, are both here: the
         read has happened (or can never happen) and "retire nobody" is the ANSWER, not a guess
         standing in for one. Withholding here would empty the Screener for the life of the
         session. An absent argument is the same state under its own name. */
      const settled = paint(reader, SCREENING_UNSUPPLIED);
      expect(settled.cutlinePending).toBe(false);
      expect(settled.waiting).toHaveLength(6);
      expect(settled.waitingPending).toBe(false);
      expect(settled.history.pending).toBe(false);
      expect(paint(reader, undefined).waiting).toHaveLength(6);
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("the SERVER's shelf is never withheld — its set is the account's own cutline already", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      sixAtTheGate(fake);
      const boot = await bootOn(fake, origin);
      const reader = boot.engine.read();

      /* `GET /screener` answered before `GET /consent` did. There is nothing unknown about that
         list — the server holds the setting and applied it — so the wait for the consent read
         must not blank a shelf that is already the account's own answer. */
      const server: ServerWaitingSender[] = [1, 2, 3].map((n) => ({
        messageId: n <= 2 ? `w-${n}` : `h-${n}`,
        address: `stranger${n}@fake.test`,
        name: `Stranger ${n}`,
        receivedAt: RECENT,
        subject: `From stranger ${n}`,
        snippet: "",
      }));
      const routed = paint(reader, SCREENING_UNANSWERED, server);
      expect(routed.waiting).toEqual(
        [1, 2, 3].map((n) => `stranger${n}@fake.test`),
      );
      expect(routed.waitingPending).toBe(false);
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("the two shelves the window does not decide are untouched by the wait", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      sixAtTheGate(fake);
      const boot = await bootOn(fake, origin);
      const reader = boot.engine.read();
      /* Screened-out and spam are decided by RULES, not by the cutline, so they are the control
         on the withholding's reach: a blanket "show nothing until the answer lands" would take
         them with it. */
      const pending = paint(reader, SCREENING_UNANSWERED);
      const answered = paint(reader, ANSWERED);
      expect(pending.screened).toBe(answered.screened);
      expect(pending.spam).toBe(answered.spam);
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });
});

/* ── the surface rule, and the screens that render it ─────────────────────────────────────── */

describe("a withheld list is a surface of its own, and it speaks", () => {
  it("listSurface separates the three ways a list can be empty", () => {
    // The mirror has never drained: the silhouette, as before.
    expect(listSurface({ settled: false, count: 0, pending: true })).toBe("skeleton");
    // Settled, and the cutline answer is in flight: withheld, not empty.
    expect(listSurface({ settled: true, count: 0, pending: true })).toBe("pending");
    // Settled, nothing outstanding: emptiness is a fact and the empty state may speak.
    expect(listSurface({ settled: true, count: 0, pending: false })).toBe("empty");
    expect(listSurface({ settled: true, count: 0 })).toBe("empty");
    // Rows beat every wait — real mail is never hidden behind a marker.
    expect(listSurface({ settled: true, count: 2, pending: true })).toBe("content");
  });

  const NOW = Date.parse("2026-09-22T09:00:00.000Z");
  const FRESH = new Date(NOW - 3_600_000).toISOString();
  const STALE = new Date(NOW - IMPORT_FLOOR_MAX_MS - 3_600_000).toISOString();
  const row = (initialImportCompletedAt: string | null, organizerRole: "organizer" | "reader" = "organizer", createdAt = FRESH) =>
    ({ status: "connected", organizerRole, initialImportCompletedAt, createdAt });

  it("an organized mailbox still on its first pass withholds the waiting shelf: nobody is said to wait yet", () => {
    expect(firstPassWithholds(0, { known: true, rows: [row(null)] }, NOW)).toBe(true);
    expect(firstPassWithholds(0, { known: true, rows: [row("2026-09-11T11:00:00.000Z")] }, NOW)).toBe(false);
    expect(firstPassWithholds(0, { known: true, rows: [row(null, "reader")] }, NOW), "a reader screens nothing").toBe(false);
    expect(firstPassWithholds(0, { known: false, rows: [] }, NOW)).toBe(false);
    for (const deck of LOCALES.map((l) => DECKS[l])) expect(deck.waitingFirstPass).toMatch(/\S/);
    expect(DECKS.en.waitingFirstPass).not.toBe(DECKS.en.waitingEmptyTitle);
  });

  it("the first pass is bounded: a stamp still unwritten a day after connecting withholds nothing", () => {
    // The worker stamps only on a no-backlog cycle; an unwritten stamp past the window is no import.
    const stale = { known: true, rows: [row(null, "organizer", STALE)] };
    expect(firstPassWithholds(0, stale, NOW)).toBe(false);
    expect(listSurface({ settled: true, count: 0, pending: firstPassWithholds(0, stale, NOW) }), "Nobody is waiting").toBe("empty");
    const { createdAt: _clock, ...clockless } = row(null);
    expect(firstPassWithholds(0, { known: true, rows: [clockless] }, NOW), "no clock, no claim").toBe(false);
  });

  it("a sibling's first pass withholds only an empty shelf: rows on it are counted, as every badge counts them", () => {
    const mailboxes = { known: true, rows: [row("2026-09-11T11:00:00.000Z", "organizer", STALE), row(null)] };
    expect(firstPassWithholds(3, mailboxes, NOW)).toBe(false);
    expect(listSurface({ settled: true, count: 3, pending: firstPassWithholds(3, mailboxes, NOW) })).toBe("content");
    expect(firstPassWithholds(0, mailboxes, NOW)).toBe(true);
  });

  it("the count line is silenced while the list is withheld", () => {
    // "0 first-time senders waiting" over a shelf this phone declined to work out is not a small
    // number, it is the wrong one — `metaWhen`'s own rule, one state further on.
    expect(metaWhen("pending", "0 first-time senders waiting")).toBeUndefined();
    expect(metaWhen("skeleton", "0 first-time senders waiting")).toBeUndefined();
    expect(metaWhen("empty", "0 first-time senders waiting")).toBe("0 first-time senders waiting");
  });
});

const src = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");

describe("the screens render the marker, and only where the answer decides the list", () => {
  it("the Screener marks the WAITING shelf alone", () => {
    const screen = src("app/(tabs)/screener.tsx");
    expect(screen).toContain("const { waiting, screened, spam, meta, waitingPending } = w.screener;");
    // Only the waiting shelf: screened-out and spam are decided by rules, not by the window.
    expect(screen).toContain('pending: seg === "waiting" && (waitingPending || firstPass),');
    expect(screen).toContain('surface === "pending" ? { note: firstPass ? Copy.waitingFirstPass : Copy.cutlinePending }');
  });

  it("History is the store's timeline, so the cutline answer withholds nothing there (ARCHIVE-024)", () => {
    const route = src("app/history.tsx");
    /* Every message you own is History now: the list is the store's, not the partition's, and no
       screening answer decides it — so there is no marker to render and none may be read. */
    expect(route).toContain("useStoreHistory()");
    expect(route).not.toContain("w.history");
    expect(route).not.toContain("Copy.cutlinePending");
    /* The empty state is said only once the store answered, or over a settled mirror without one. */
    expect(route).toContain('h.state === "ready" || (h.state === "unavailable" && w.boot.settled) ?');
  });

  it("the silhouette carries the sentence — a shape alone would say nothing", () => {
    const sk = src("src/ui/Skeleton.tsx");
    // One slot, the refusal first: a surface never carries both, and if one ever does the
    // failure is the more important thing to read.
    expect(sk).toContain("const say = stalled ? sayArg(stalled) : (note ?? null);");
    expect(sk).toContain("{say ? (");
  });
});

describe("the world layer names both states, and neither by accident", () => {
  const world = src("src/state/world.tsx");

  it("a session starts UNANSWERED, and a read with no cutline fields settles it UNSUPPLIED", () => {
    expect(world).toContain("useState<ScreeningPosture>(SCREENING_UNANSWERED)");
    expect(world).toContain(
      "setScreening(ans.screening === null ? SCREENING_UNSUPPLIED : screeningAnswered(ans.screening));",
    );
    // A session swap goes back to the state a session that has asked nothing is really in.
    expect(world).toContain("setScreening(SCREENING_UNANSWERED);");
  });

  it("the STANDALONE door is unsupplied, not waiting — unless its own engine sends each mailbox's window", () => {
    /* An `unanswered` posture there would withhold the Screener for the whole session. Its own
       engine's answer carrying `screeningByMailbox` (RULING-026) names every mailbox's window, so
       that answer partitions; `answersPerMailbox` is driven in `screener-says-whose-window.test.ts`. */
    expect(world).toContain("const posture: ScreeningPosture = !session.standalone || answersPerMailbox(screening)");
    expect(world).toContain("? screening : SCREENING_UNSUPPLIED;");
  });

  it("ONE posture reaches the partition, the shelves and the reading screen", () => {
    // The provider hands the projector the one posture; the projector's view and the reader's take it.
    expect(world).toContain("signatures, resurfaceTime, rememberResurfaceTime, posture, scopes,");
    const projection = src("src/state/world-projection.ts");
    expect(projection).toContain("presentedWorld(base, v.now, foldersOn, posture, inp.ownAddresses, imports)");
    // Two different postures in one render would be one rule read two ways.
    expect(projection.match(/screening: posture/g) ?? []).toHaveLength(2);
  });
});

describe("the marker sentence is in every catalogue", () => {
  it("each deck says it, in its own words", () => {
    const said = LOCALES.map((l) => DECKS[l].cutlinePending);
    for (const sentence of said) {
      expect(typeof sentence).toBe("string");
      expect(sentence.trim().length).toBeGreaterThan(20);
    }
    // A German reader must not meet the English sentence: the deck's type cannot see that.
    expect(new Set(said).size).toBe(LOCALES.length);
  });
});
