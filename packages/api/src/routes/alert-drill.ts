import { createHash } from "node:crypto";
import {
  ackDrill, deliverDrill, drillAckState, drillKinds, isDrillToken, listDrillRuns, recordDrillOutcomes,
  startDrillRun, usableAckBase,
  type AlertDriver, type AlertKind, type DrillAckState,
} from "@trafficflow/db/cloud";
import { silentLogger } from "@trafficflow/core";
import type { Tx } from "@trafficflow/db";
import type { AdminDb } from "@trafficflow/services";
import { presentsSecret, secretRouteJson as json } from "../secret-auth.js";
import type { AlertsConfig } from "../deps-cloud.js";
import type { Route } from "../router.js";

/**
 * ALERT DRILLS over HTTP (cloud 0051), four routes beside `/internal/alerts`:
 *
 * - `POST /internal/alerts/drill` (`TF_ALERT_SECRET` only): start a run. The API driver delivers at
 *   once through this host's sinks; the worker driver's rows wait for the worker's next pass. One run
 *   per hour per deployment. The answer carries closed outcome codes and the sinks' redacted errors,
 *   never a token or a hash.
 * - `GET /internal/alerts/drill` (the same secret): the last five runs.
 * - `GET /internal/alerts/drill/ack?t=`: the page an ack link opens. It writes nothing, so a mail
 *   link scanner that fetches it acknowledges nothing; a person presses its button.
 * - `POST /internal/alerts/drill/ack?t=`: the press. One token acknowledges its message once,
 *   within 24 h of delivery.
 *
 * The press is a same-origin JSON POST from the page's one hashed script: every pipeline's request
 * guard refuses a form-encoded body, and a page with no script cannot send JSON. All four answer
 * 404 where alerts are not configured and 503 where they have no database, through `internal.ts`'s
 * own gate, handed in so the arming facts stay in one place.
 */

type DrillGate = (cfg: AlertsConfig | undefined, staff: (() => Promise<AdminDb>) | undefined) =>
  | { armed: true; cfg: AlertsConfig; db: () => Promise<Tx> }
  | { armed: false; res: Response };

const ALERT_DRILL_PATH = "/internal/alerts/drill";
/** `DRILL_ACK_PATH`, the path the links are built on, spelled as a literal for the route scans. */
const ALERT_DRILL_ACK_PATH = "/internal/alerts/drill/ack";
const DRIVERS: readonly AlertDriver[] = ["api", "worker"];
/** How many runs the list answers. */
const LISTED_RUNS = 5;

/** The drill request's body: every field optional, anything else refused. */
function parseDrillRequest(raw: unknown): { kinds: AlertKind[]; drivers: AlertDriver[] } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some((k) => k !== "kinds" && k !== "drivers")) return null;
  const all = drillKinds();
  const pick = <T extends string>(field: unknown, from: readonly T[]): T[] | null => {
    if (field === undefined) return [...from];
    if (!Array.isArray(field) || field.length === 0 || field.length > from.length) return null;
    if (!field.every((v) => typeof v === "string" && (from as readonly string[]).includes(v))) return null;
    return from.filter((v) => field.includes(v));
  };
  const kinds = pick(body.kinds, all);
  const drivers = pick(body.drivers, DRIVERS);
  return kinds && drivers ? { kinds, drivers } : null;
}

const escHtml = (v: string): string => v
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The page's one script: on a press, POST to this very URL and say what came back. */
const ACK_SCRIPT = [
  'document.getElementById("ack").addEventListener("click", function () {',
  '  var button = this, out = document.getElementById("out");',
  "  button.disabled = true;",
  '  fetch(location.href, { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: "{}" })',
  "    .then(function (r) { return r.status; }, function () { return 0; })",
  "    .then(function (s) {",
  '      out.textContent = s === 200 ? "Acknowledged. Thank you." : s === 409 ? "This message was already acknowledged."',
  '        : s === 404 ? "This link is not valid, or has expired." : "It could not be recorded. Try again.";',
  "      if (s !== 200 && s !== 409 && s !== 404) button.disabled = false;",
  "    });",
  "});",
].join("\n");
const ACK_SCRIPT_HASH = `sha256-${createHash("sha256").update(ACK_SCRIPT, "utf8").digest("base64")}`;

const BASE_CSP = "default-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";
/** The open page's policy: its one script, and a request back to this origin. */
const ACK_PAGE_CSP = `${BASE_CSP}; script-src '${ACK_SCRIPT_HASH}'; connect-src 'self'`;

function page(status: number, body: string, csp: string = BASE_CSP): Response {
  const html = [
    "<!doctype html>", '<html lang="en">', "<head>", '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">', '<meta name="robots" content="noindex">',
    "<title>ohmail alert drill</title>", "</head>", "<body>", "<h1>ohmail alert drill</h1>", body, "</body>", "</html>", "",
  ].join("\n");
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": csp,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex",
    },
  });
}

/** ONE answer for a malformed, unknown or expired token: nothing tells them apart. */
const notFoundPage = (): Response => page(404, "<p>This acknowledgement link is not valid, or has expired.</p>");

function ackPage(s: Exclude<DrillAckState, { state: "unknown" | "expired" }>): Response {
  const what = `run ${escHtml(s.runId.slice(0, 8))}, sent by the ${escHtml(s.driver)} alert driver through ` +
    `${escHtml(s.sink)}, covering ${s.kinds} alert kinds`;
  if (s.state === "acked") {
    return page(200, `<p>This alert drill message (${what}) was acknowledged at ${escHtml(s.ackedAt!.toISOString())}.</p>`);
  }
  return page(200, [
    `<p>This link acknowledges one alert drill message: ${what}.</p>`,
    "<p>Acknowledge it if the message reached you. Opening this page records nothing.</p>",
    '<p><button type="button" id="ack">Acknowledge</button></p>',
    '<p id="out" role="status"></p>',
    "<noscript><p>Acknowledging needs JavaScript on this page.</p></noscript>",
    `<script>${ACK_SCRIPT}</script>`,
  ].join("\n"), ACK_PAGE_CSP);
}

export function alertDrillRoutesWith(gate: DrillGate): Route[] {
  return [
    {
      method: "POST",
      pattern: ALERT_DRILL_PATH,
      relay: false,  /* the hosted service's shared-secret intake */
      cost: "unauthenticated",
      options: { public: true, anonymous: true, raw: true },
      handler: async (req, deps) => {
        const log = (deps.logger ?? silentLogger).child({ route: ALERT_DRILL_PATH });
        const g = gate(deps.alerts, deps.adminDb);
        if (!g.armed) return g.res;
        // The alert secret alone: the platform scheduler's credential starts no drill.
        if (!presentsSecret(req, g.cfg.secret)) {
          log.warn("alert_drill_unauthorized", {});
          return json(401, { error: { code: "unauthorized" } });
        }
        // Held to the rule the worker holds the copied base to, so neither driver links elsewhere.
        const ackBase = usableAckBase(g.cfg.drillAckBase);
        if (!ackBase) return json(503, { error: { code: "drill_ack_unarmed" } });
        let raw: unknown;
        try {
          const text = await req.text();
          raw = text.trim() === "" ? {} : JSON.parse(text);
        } catch {
          return json(400, { error: { code: "invalid_drill" } });
        }
        const asked = parseDrillRequest(raw);
        if (!asked) return json(400, { error: { code: "invalid_drill" } });
        const { kinds, drivers } = asked;
        try {
          const db = await g.db();
          const now = deps.now();
          const usable = (g.cfg.sinks ?? []).filter((s) => !s.unusable);
          const run = await startDrillRun(db, {
            kinds, drivers, apiSinkNames: usable.map((s) => s.name), ackBase, now,
          });
          if (run.state === "too_soon") {
            log.info("alert_drill_too_soon", { retryAt: run.retryAt.toISOString() });
            return new Response(JSON.stringify({ error: { code: "drill_too_soon" }, retryAt: run.retryAt.toISOString() }), {
              status: 429,
              headers: {
                "content-type": "application/json", "cache-control": "no-store",
                "retry-after": String(Math.max(1, Math.ceil((run.retryAt.getTime() - now.getTime()) / 1000))),
              },
            });
          }
          let api: Record<string, unknown> | null = null;
          if (drivers.includes("api")) {
            if (usable.length === 0) {
              api = { unarmed: true, delivered: [], failedSinks: [], sinkErrors: [], outcomes: [] };
            } else {
              const report = await deliverDrill(usable, {
                runId: run.runId, kinds, tokens: run.tokens, ackBase, source: "api",
                environment: g.cfg.environment ?? "production", now,
              });
              await recordDrillOutcomes(db, run.runId, "api", report.outcomes);
              api = {
                unarmed: false, delivered: report.delivered, failedSinks: report.failed,
                // Redacted by each sink before it gets here, as on `POST /internal/alerts`.
                sinkErrors: report.errors,
                outcomes: report.outcomes.map((o) => ({ sink: o.sink, outcome: o.outcome })),
              };
            }
          }
          log.info("alert_drill_started", {
            count: kinds.length,
            delivered: (api?.delivered as string[] | undefined) ?? [],
            failedSinks: (api?.failedSinks as string[] | undefined) ?? [],
            sinkErrors: (api?.sinkErrors as string[] | undefined) ?? [],
          });
          return json(200, {
            runId: run.runId, requestedAt: run.requestedAt.toISOString(), kinds: kinds.length, drivers, api,
            worker: drivers.includes("worker") ? { queued: kinds.length } : null,
          });
        } catch (err) {
          log.error("alert_drill_failed", { err });
          return json(503, { error: { code: "alert_drill_failed" } });
        }
      },
    },
    {
      method: "GET",
      pattern: ALERT_DRILL_PATH,
      relay: false,  /* the hosted service's shared-secret intake */
      cost: "unauthenticated",
      options: { public: true, anonymous: true, raw: true },
      handler: async (req, deps) => {
        const g = gate(deps.alerts, deps.adminDb);
        if (!g.armed) return g.res;
        if (!presentsSecret(req, g.cfg.secret)) return json(401, { error: { code: "unauthorized" } });
        try {
          const runs = await listDrillRuns(await g.db(), LISTED_RUNS);
          return json(200, { now: deps.now().toISOString(), runs });
        } catch {
          return json(503, { error: { code: "alert_drill_read_failed" } });
        }
      },
    },
    {
      method: "GET",
      pattern: ALERT_DRILL_ACK_PATH,
      relay: false,  /* the hosted service's shared-secret intake */
      cost: "unauthenticated",
      options: { public: true, anonymous: true, raw: true },
      handler: async (req, deps) => {
        const g = gate(deps.alerts, deps.adminDb);
        if (!g.armed) return g.res;
        const token = new URL(req.url).searchParams.get("t");
        if (!isDrillToken(token)) return notFoundPage();
        try {
          const state = await drillAckState(await g.db(), token, deps.now());
          if (state.state === "unknown" || state.state === "expired") return notFoundPage();
          return ackPage(state);
        } catch {
          return page(503, "<p>The acknowledgement could not be read. Try again later.</p>");
        }
      },
    },
    {
      method: "POST",
      pattern: ALERT_DRILL_ACK_PATH,
      relay: false,  /* the hosted service's shared-secret intake */
      cost: "unauthenticated",
      options: { public: true, anonymous: true, raw: true },
      handler: async (req, deps) => {
        const log = (deps.logger ?? silentLogger).child({ route: ALERT_DRILL_ACK_PATH });
        const g = gate(deps.alerts, deps.adminDb);
        if (!g.armed) return g.res;
        const token = new URL(req.url).searchParams.get("t");
        if (!isDrillToken(token)) return json(404, { error: { code: "not_found" } });
        try {
          const db = await g.db();
          const now = deps.now();
          const stamped = await ackDrill(db, token, now);
          if (stamped > 0) {
            log.info("alert_drill_acked", { count: stamped });
            return json(200, { acknowledged: true, kinds: stamped });
          }
          const state = await drillAckState(db, token, now);
          if (state.state === "acked") return json(409, { error: { code: "already_acknowledged" } });
          return json(404, { error: { code: "not_found" } });
        } catch (err) {
          log.error("alert_drill_ack_failed", { err });
          return json(503, { error: { code: "alert_drill_ack_failed" } });
        }
      },
    },
  ];
}
