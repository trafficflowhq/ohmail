import type { Tx } from "@trafficflow/db";
import { makeOwnedDb, makeChangeWakeHub, type OwnedDb } from "@trafficflow/db/cloud";
import { sendConnections, type ApiDeps, type ApiServices, type ChangeWakeHub } from "@trafficflow/api";
import type { MailService } from "@trafficflow/services";
import { startClocks, type ClockHandle, type ClockRow } from "./clocks.js";
import {
  alertHeartbeat, alertReadersFor, buildServices, customerMailFor, depsFor, oauthProvider, ownedDbPort,
  pagerArms, pooledDbPort, staffDbFor,
  type BillingTransport, type DoorInput, type Runtime,
} from "./deps.js";
import { DIFFERENCES, wiringOf, type Chosen } from "./differences.js";
import { makeDispatch } from "./handler.js";
import type { Settings } from "./settings.js";

/**
 * THE API PROGRAM, built once from its settings: the one wiring behind every door.
 *
 * A door reads the settings (`loadSettings`), says what it is ({@link DoorInput}), and serves
 * {@link Program.dispatch}. The self-hosted server's process (`index.ts`) and the function door
 * (`apps/api-vercel`) are the two doors there are; what the managed service does differently is
 * the list in `differences.ts`. A new service is wired once, in `deps.ts`.
 */
export interface Program {
  settings: Settings;
  /** What the marker chose (`differences.ts`). */
  chosen: Chosen;
  differences: typeof DIFFERENCES;
  services: ApiServices;
  /** Everything with the program's lifetime: the doors' boot steps and the tests read it. */
  runtime: Runtime;
  /** The per-request container for an ALREADY-NORMALIZED request. */
  buildDeps(req: Request): ApiDeps;
  /** `Request` in, `Response` out: the whole pipeline, normalization included. Never throws. */
  dispatch(req: Request): Promise<Response>;
  /** Start the program's own clocks (`clocks.ts`), or null where it keeps none. */
  startClocks(seams?: { rows?: readonly ClockRow[]; retryMs?: number; lockKey?: bigint }): ClockHandle | null;
  /** Release what the program holds: kept IMAP connections, the LISTEN, an owned pool. Clocks stop first. */
  close(): Promise<void>;
}

export type { DoorInput } from "./deps.js";

export function buildProgram(settings: Settings, door: DoorInput): Program {
  const cfg = wiringOf(settings);
  const { logger } = door;

  // The handle: one pool this program owns, or the pooled handle, which is module-cached per
  // connection string and therefore never held here.
  let owned: OwnedDb | null = null;
  const db = cfg.database.kind === "owned"
    ? ownedDbPort((owned = makeOwnedDb(cfg.database.url)).db)
    : pooledDbPort(cfg.database.url);

  // ONE customer mailer for the program: auth's ceremonies, the funnel and the lifecycle mails share it.
  let mail: { value: MailService | null } | null = null;
  const customerMail = (): MailService | null => (mail ??= { value: customerMailFor(cfg, logger) }).value;

  const billing: BillingTransport = { transport: null };
  const services = buildServices(cfg, door, { db, logger, billing, customerMail });

  // ONE LISTEN for the program. Built only where streams are held AND a session-capable connection
  // can hold the LISTEN; in every other state the `/events` poll loop is the only wake source.
  let hub: ReturnType<typeof makeChangeWakeHub> | null | undefined;
  const changeWake = (): ChangeWakeHub | null => {
    if (hub === undefined) {
      hub = cfg.sse.enabled !== false && cfg.sse.holds !== false && cfg.database.listenUrl
        ? makeChangeWakeHub(cfg.database.listenUrl, logger)
        : null;
    }
    return hub;
  };

  const pager = pagerArms(cfg, logger, () => db.request());
  const ownPool = owned;
  const runtime: Runtime = {
    cfg,
    door,
    db,
    services,
    changeWake,
    oauth: oauthProvider(cfg, () => db.request()),
    logger,
    alertSinks: pager.sinks,
    alertLastResortSinks: pager.lastResort,
    ...(cfg.alerts ? { alertHeartbeat: alertHeartbeat(cfg, logger) } : {}),
    // The alert pass's own handle: this program's pool, where it is the one role there is.
    alertDb: cfg.chosen.staffDoor === "none" && ownPool
      ? () => Promise.resolve(ownPool.db as unknown as Tx)
      : null,
    alertReaders: alertReadersFor(cfg, () => services, logger),
    // Armed by `DATABASE_URL_ADMIN` ALONE: an unarmed console leaves the pager its handle.
    staffDb: cfg.chosen.staffDoor === "blind-role" && cfg.staff?.db ? staffDbFor(cfg.staff.db.url) : null,
    customerMail,
    billing,
  };

  const dispatch = makeDispatch({
    routes: cfg.chosen.routes,
    bodyMaxBytes: door.bodyMaxBytes,
    closeUndrained: door.closeUndrained,
    logger,
    buildDeps: (req) => depsFor(req, runtime),
  });

  return {
    settings,
    chosen: cfg.chosen,
    differences: DIFFERENCES,
    services,
    runtime,
    buildDeps: (req) => depsFor(req, runtime),
    dispatch,
    startClocks: (seams) => startClocks(runtime, dispatch, seams),
    async close() {
      // The send door's kept IMAP connections: closed here, never left to their idle clock.
      await sendConnections.closeAll();
      // Streams die before the hub so no wake fires into a torn-down fan-out; the pool goes last.
      if (hub) await hub.end();
      if (ownPool) await ownPool.close();
    },
  };
}

/* What a door needs beside the program itself. */
export { refusalBeforeRouter, json, normalizeOn } from "./handler.js";
export { kekRetirementCheck, resetHandles, processDoorInput } from "./deps.js";
