import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createApp, apiRoutes, ERASED_ANSWER_HEADER, type ApiDeps } from "@trafficflow/api";
import { pipelineFor } from "../src/app.js";
import { withSession } from "../src/middleware.js";
import { withoutComments, bracketSpan } from "../../../scripts/lib/source-scan.mjs";
import { makeDeps, req, seedSession, seedMailbox, FIXED_NOW } from "./helpers.js";

/**
 * EVERY HOSTED ROUTE A PAIRED DESKTOP PULLS PASSES THE ERASURE FENCE. The pull set is READ from
 * the desktop's own call sites — each `fetchCloud(…)` in the mirror, the wake's `/events` and the
 * refresh door — so a read added there is in this census the day it is written. Each must be a
 * route here that runs `withSession` (the fence's door; the refresh door carries its own arm),
 * and each must answer an erased account's declared bearer `410 account_erased`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SIDECAR = join(HERE, "..", "..", "..", "apps", "sidecar", "src");
const MIRROR = "apps/sidecar/src/cloud-mirror.ts";
const WAKE = "apps/sidecar/src/cloud-wake.ts";
const AUTH = "apps/sidecar/src/cloud-auth.ts";

const source = (file: string): string =>
  withoutComments(readFileSync(join(SIDECAR, file.split("/").pop()!), "utf8"));

/** Every path literal inside each call's argument list, cut at its query or template hole; a hole
 *  right after a slash is the route's `:id` (`/messages/${id}` is GET /messages/:id). */
function callPaths(file: string, callee: RegExp): { sites: number; paths: Set<string> } {
  const src = source(file);
  const paths = new Set<string>();
  let sites = 0;
  for (const m of src.matchAll(callee)) {
    const open = m.index! + m[0].length - 1;
    const args = bracketSpan(src, open);
    expect(args.closed, `${file}: an unclosed call at ${m.index}`).toBe(true);
    sites += 1;
    for (const lit of src.slice(args.start, args.end).matchAll(/["`](\/[a-z][a-z/]*)(\$\{)?/g)) {
      paths.add(lit[2] && lit[1]!.endsWith("/") ? `${lit[1]}:id` : lit[1]!);
    }
  }
  return { sites, paths };
}

const mirror = callPaths(MIRROR, /\bfetchCloud\(/g);
const wake = callPaths(WAKE, /\.authedFetch\(/g);
// The renewal goes out through the session's bounded `send` door (desktop sign-out row), which hands it
// to `fetchImpl` with a deadline and the stop; either spelling is the one refresh site.
const refreshSites = [...source(AUTH).matchAll(/\b(?:fetchImpl|send)\(`\$\{base\}\/auth\/refresh`/g)].length;
const PULL = [...new Set([...mirror.paths, ...wake.paths])].sort();

describe("the paired desktop's pull set, read from its own call sites", () => {
  it("POSITIVE CONTROL: the scan finds the call sites the mirror, the wake and the refresh make", () => {
    // Eleven hosted reads in the mirror today (the away-reply repair's GET /messages/:id the ninth, the
    // calendar's read when its switch went on, a GET /sync/snapshot, the tenth; the hosted devices'
    // one page at the mirror's start, GET /sync/snapshot again behind the same session door, the
    // eleventh); a scan reading zero, or losing one, is the census measuring nothing, and a twelfth
    // is a read somebody must look at here before it ships.
    expect(mirror.sites).toBe(11);
    expect(wake.sites).toBe(1);
    expect(refreshSites).toBe(1);
    expect(PULL).toEqual(["/events", "/mailboxes", "/messages/:id", "/messages/bodies", "/sync", "/sync/snapshot"]);
  });

  it("every path is a hosted route that runs the session door, never an anonymous or public one", () => {
    const unfenced: string[] = [];
    for (const path of PULL) {
      const route = apiRoutes.find((r) => r.method === "GET" && r.pattern === path);
      if (!route) { unfenced.push(`${path}: no hosted route`); continue; }
      if (route.options?.public || route.options?.anonymous) unfenced.push(`${path}: public`);
      if (!pipelineFor(route).includes(withSession)) unfenced.push(`${path}: no withSession`);
    }
    expect(unfenced).toEqual([]);
  });
});

describe("each of them answers an erased account's declared bearer 410 account_erased", () => {
  it("every pulled route, and the refresh door", async () => {
    const app = createApp(apiRoutes);
    const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    await seedMailbox(db, { accountId: s.accountId });
    const minted = await (await H(req("POST", "/pair", {
      bearer: s.token, body: JSON.stringify({ grant: "device-pair", label: "Desk" }),
    }), deps)).json() as { token: string };
    const pair = ((await (await H(req("POST", "/pair/redeem", {
      body: JSON.stringify({ grant: "device-pair", token: minted.token }),
    }), deps)).json()) as { tokens: { accessToken: string; refreshToken: string } }).tokens;
    expect((await H(req("DELETE", "/account", { bearer: s.token }), deps)).status).toBe(200);

    const declared = { [ERASED_ANSWER_HEADER]: "account_erased" };
    const answers: string[] = [];
    for (const path of PULL) {
      const url = path.replace(":id", "00000000-0000-4000-8000-000000000000");
      const res = await H(req("GET", url, { bearer: pair.accessToken, headers: declared }), deps);
      const code = ((await res.json().catch(() => ({}))) as { error?: { code?: string } }).error?.code;
      answers.push(`${path} ${res.status} ${code ?? ""}`);
    }
    const r = await H(req("POST", "/auth/refresh", {
      headers: declared, body: JSON.stringify({ refreshToken: pair.refreshToken }),
    }), deps);
    answers.push(`/auth/refresh ${r.status} ${((await r.json()) as { error?: { code?: string } }).error?.code ?? ""}`);
    expect(answers).toEqual([...PULL, "/auth/refresh"].map((p) => `${p} 410 account_erased`));
  });
});
