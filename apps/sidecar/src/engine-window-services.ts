// The engine's OWN resolution of the Ohbox posture, never a second reading of it. `rules.ts` owns
// what an absent or unrecognised value means, and both hosts ask it the same question.
import {
  searchIndexBackfillPass,
} from "@trafficflow/core/mail";
import { type Tx, seqBounds } from "@trafficflow/db";
import { resolveSession, type SearchSupersede } from "@trafficflow/services/mail";
import { COMPOSITION_WINDOW_OUTBOX, runsStorePass, searchFor } from "./composition-passes.js";
/* OLDER HTML-ONLY LETTERS' WORDS, the worker's store-only pass: here the store is the authority. */
import {
  HTML_WORDS_LOCAL_BUDGET_MS, HTML_WORDS_LOCAL_SCAN_ROWS, htmlWordsBackfillPass,
} from "@ohmail/organizer/html-words-backfill";
import { forPerson, forWindow, ingestIsRunning } from "./store-lanes.js";
import { adoptLegacyWindowOutbox, createWindowOutbox, windowOutboxOwnerKey } from "./window-outbox.js";
import { createAttentionClock, isPersonRequest } from "./attention.js";
import { startHtmlWordsBackfill, startSearchIndexBackfill } from "./search-backfill.js";
import { SEARCH_WARMUP_WORD, createSearchWarmup } from "./search-warmup.js";
import { loopTurn } from "./loop-hold.js";
import { createSearchIndexDoor } from "./search-index-door.js";
import { createSearchLanes } from "./search-lanes.js";
import { createFirstSyncReporter } from "./first-sync.js";
import { startEngineVitals } from "./vitals.js";
import type { SidecarConfig } from "./engine-types.js";
import type { EngineScope } from "./engine-scope.js";

/**
 * The desktop's engine, one section: what the window is served beside its requests: the vitals, the attention
 * clock, the outbox, the search backfills and lanes.
 */
export function windowServicesSection(scope: EngineScope, config: SidecarConfig): void {
    // Where the "Opening your mailbox" seconds went — measurement only; nothing above behaves
    // differently for it. The four named phases are the awaited work this constructor is made of,
    // and `totalReadyMs` brackets all of it, so `totalReadyMs` minus the four is the unnamed
    // remainder (AI assembly, key ring, credential resolution, route table). Naming the phases is
    // the point — like `mailbox_attached` in the worker, a single number could not say which phase
    // dominated. Emitted at constructor EXIT, not per phase, so an ordinary launch gets one line.


    scope.log("boot_phases", {
      pgliteOpenMs: scope.opened.timings.pgliteOpenMs,
      adoptBaselineMs: scope.opened.timings.adoptBaselineMs,
      migrateMs: scope.opened.timings.migrateMs,
      treeSyncMs: scope.opened.timings.treeSyncMs,
      compactMs: scope.opened.timings.compactMs,
      searchSetupMs: scope.opened.timings.searchSetupMs,
      /* WHICH MIGRATION PAID, beside the pass it cost. `migrateMs` alone said 237 834 on a 1.2 GB
         store and named nothing inside it. `null` — not `0` — where the store did not migrate here
         at all (the phone's, whose schema is the platform's): "none pending" and "not this open's
         business" are different answers and a reader must be able to tell them apart. */
      migrationsPending: scope.opened.migrations?.pending ?? null,
      migrationsApplied: scope.opened.migrations?.applied ?? null,
      slowestMigration: scope.opened.migrations?.slowest?.migration ?? null,
      slowestMs: scope.opened.migrations?.slowest?.ms ?? null,
      worldMs: scope.worldMs,
      totalReadyMs: Date.now() - scope.tBoot,
    });
    /* BESIDE `boot_phases`, and for the same reason it is beside it: that line answers "where did
       the seconds go", and this one answers the question nobody could ask at all until now — how
       much memory this engine holds, and whether it settles. The first sample lands here so a
       launch killed before the first interval still leaves a floor on the record. See
       `startEngineVitals`; no threshold is attached to any of it. */
    const stopVitals = startEngineVitals(scope.log, {
      ...(config.vitalsIntervalMs === undefined ? {} : { intervalMs: config.vitalsIntervalMs }),
      // The store's own heap, so a rise in `rss` can be attributed to the database or to the
      // engine instead of argued about. Read per sample from the live handle, never captured.
      storeBytes: () => scope.opened.storeBytes(),
      storeSyncs: () => scope.opened.storeSyncs(),
      ...(config.loopDelay ? { drainTurns: () => scope.drainTurns.take() } : {}),
    });
    /* ONE PER PROCESS, because the "have I already said this import is running" half is per
       launch — see `first-sync.ts`. Built here rather than inside the drain, which runs per pass. */
    const firstSyncLog = createFirstSyncReporter(scope.log);

    /**
     * ══ A WRITE CAME IN THROUGH A DOOR — the idle ladder's third reset ══
     *
     * The window and a paired device file their moves through the API, and the engine's next drain
     * is what puts them on the mail server. A ladder that slept through that would leave a move the
     * person watched happen up to a ceiling away from IMAP, so every answered non-GET asks ONE
     * question — has the account's change log moved since the last time a door write was noticed —
     * and forces a drain on every runtime if it has. A request that WROTE NOTHING moves no seq and
     * rings nothing, which is what stops a chatty door pinning the cadence at its base.
     */
    /* WHETHER SOMEBODY IS USING THIS INSTALL, and whether the machine is on power — the two
       questions a store-only pass asks before it takes the connection. Every door notes each
       request (`attention.ts`); the power reader is the one the entry injected (`hostPower`). */
    const attention = createAttentionClock();
    /** Does this request carry the install's live launch bearer — the check the window's report door reads. */
    const launchBearerAuthorized = async (r: Request): Promise<boolean> => {
      const header = r.headers.get("authorization");
      const token = header && /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, "").trim() : "";
      return token !== "" && (await resolveSession(scope.db, token, scope.now())) !== null;
    };
    /** The window's queued changes, on this machine — see `window-outbox.ts`. Not on a phone. Owned as
        this door's world is (`ensureLocalWorld`, by its address); an earlier build's file is adopted. */
    const outboxOwner = COMPOSITION_WINDOW_OUTBOX[scope.organizerKind] ? { address: scope.address, base: "local" } : null;
    if (outboxOwner !== null) adoptLegacyWindowOutbox(config.dataDir, windowOutboxOwnerKey(outboxOwner), scope.log);
    const windowOutbox = outboxOwner !== null
      ? createWindowOutbox({
          dataDir: config.dataDir, authorized: launchBearerAuthorized, log: scope.log, scope: () => scope.world.mailboxId,
          owner: outboxOwner,
        })
      : null;
    /* THE SEARCH INDEX FILLS ITSELF IN — the store-only pass, one round per idle tick on power;
       see `search-backfill.ts`. Local door only (`composition-passes.ts`). */
    const searchBackfill = runsStorePass(scope.organizerKind, "search-index-backfill")
      ? startSearchIndexBackfill({
          round: () => searchIndexBackfillPass({ db: scope.db as unknown as Tx, accountId: scope.world.accountId, rounds: 1 }),
          quietForMs: () => attention.quietForMs(),
          ingesting: ingestIsRunning,
          ...(config.hostPower ? { power: config.hostPower } : {}),
          log: scope.log,
          // PGlite has no autovacuum: the statistics of the tables search reads are the store's to keep.
          maintain: () => scope.opened.analyzeSearchIfStale(),
          ...(config.searchBackfillTiming ?? {}),
        })
      : null;
    /* OLDER HTML-ONLY LETTERS GET THEIR WORDS — the same gate, the phone included; one bounded page
       per round, a turn of the event loop between rows (`html-words-backfill.ts`). */
    const htmlWordsBackfill = runsStorePass(scope.organizerKind, "html-words-backfill")
      ? startHtmlWordsBackfill({
          round: async () => {
            const began = performance.now();
            const r = await htmlWordsBackfillPass(scope.db as unknown as Tx, {
              accountId: scope.world.accountId, scanRows: HTML_WORDS_LOCAL_SCAN_ROWS, turn: loopTurn,
              until: () => performance.now() - began >= HTML_WORDS_LOCAL_BUDGET_MS,
            });
            return { ran: r.ran, written: r.filled, marked: r.marked };
          },
          quietForMs: () => attention.quietForMs(),
          ingesting: ingestIsRunning,
          ...(config.hostPower ? { power: config.hostPower } : {}),
          log: scope.log,
          ...(config.searchBackfillTiming ?? {}),
        })
      : null;
    /* THE FIRST SEARCH'S COLD START, PAID AT LAUNCH IDLE — the same composition as the backfill
       (the desktop's own store); see `search-warmup.ts`. The answer is dropped. */
    scope.searchWarmup = runsStorePass(scope.organizerKind, "search-index-backfill")
      ? createSearchWarmup({
          search: () => searchFor(scope.organizerKind).search({
            db: scope.db as never, accountId: scope.world.accountId, userId: null, now: scope.now, requestId: "search-warmup",
          }, { q: SEARCH_WARMUP_WORD, parts: "page", limit: 50 }),
          ingesting: ingestIsRunning,
          quietForMs: () => attention.quietForMs(),
          log: scope.log,
        })
      : null;
    const searchIndexDoor = createSearchIndexDoor({
      authorized: launchBearerAuthorized, db: scope.db as unknown as Tx, accountId: scope.world.accountId,
    });
    /* THE WINDOW'S SEARCH LANES (`search-lanes.ts`), admitted before the request waits on anything,
       so a newer question marks the older ones while they still queue. This door only. */
    const searchLanes = createSearchLanes();
    const laned = (door: (req: Request, supersede: SearchSupersede | undefined) => Promise<Response>) =>
      async (req: Request): Promise<Response> => {
        attention.note(req.method, new URL(req.url).pathname);
        const lane = searchLanes.admit(req);
        try {
          return await door(req, lane?.supersede);
        } finally {
          lane?.done();
        }
      };

    /* A SEARCH IS A PERSON WAITING, on every door: its statements go ahead of a drain's and the
       drain waits for it (`forPerson`). Only the search — a poll that jumped the queue would starve
       the mail it is polling for. And every person's request holds the store's checkpoint off until
       the window goes quiet (`forWindow`, `db.ts`); a poll does not, or an open window would. */
    const asPerson = (req: Request, run: () => Promise<Response>): Promise<Response> => {
      const path = new URL(req.url).pathname;
      const answer = req.method === "GET" && path === "/search" ? () => forPerson(run) : run;
      return isPersonRequest(req.method, path) ? forWindow(answer) : answer();
    };

    let lastDoorMark: string | null = null;
    let doorKickInFlight = false;
    const noteDoorWrite = (req: Request, res: Response): void => {
      if (req.method === "GET" || req.method === "HEAD" || res.status >= 400) return;
      if (doorKickInFlight) return;
      doorKickInFlight = true;
      void (async () => {
        try {
          const { max } = await seqBounds(scope.db as unknown as Tx, scope.world.accountId);
          const mark = max === null ? "empty" : max.toString();
          if (mark === lastDoorMark) return;
          lastDoorMark = mark;
          /* THE LADDER, NOT A DRAIN — and the restraint is the point. Forcing a pass per write
             would drain on the person's typing rhythm (a draft autosaves as they compose), far
             more often than the fixed cadence this replaced. `noteWorldMoved` promises the next
             drain within ONE BASE INTERVAL, which is the cadence the engine had before it rested,
             so nothing a door writes reaches the mail server later than it used to. */
          for (const rt of scope.runtimes.all()) rt.noteWorldMoved();
        } catch {
          /* An unreadable change log rings nothing. The poll is still the floor. */
        } finally {
          doorKickInFlight = false;
        }
      })();
    };
    scope.stopVitals = stopVitals;
    scope.firstSyncLog = firstSyncLog;
    scope.attention = attention;
    scope.launchBearerAuthorized = launchBearerAuthorized;
    scope.windowOutbox = windowOutbox;
    scope.searchBackfill = searchBackfill;
    scope.htmlWordsBackfill = htmlWordsBackfill;
    scope.searchIndexDoor = searchIndexDoor;
    scope.laned = laned;
    scope.asPerson = asPerson;
    scope.noteDoorWrite = noteDoorWrite;
}
