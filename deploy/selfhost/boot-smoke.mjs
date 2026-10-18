#!/usr/bin/env node
/**
 * THE SELF-HOST BOOT SMOKE — the check that a compose stack in this directory actually boots,
 * migrates, signs in, syncs and stages. It is this project's control for the stack AND the check an
 * operator can run against their own install; the second is why it sits beside the stack.
 *
 * AGAINST YOUR OWN STACK. Everything it needs is an env knob:
 *
 *   SMOKE_BASE=https://mail.example.com \
 *   SMOKE_COMPOSE="docker compose -f docker-compose.yml" SMOKE_ENV_FILE=.env \
 *   SMOKE_MAIL_HOST=<a mail server this stack can reach> SMOKE_MAIL_DOMAIN=<its mail domain> \
 *   node boot-smoke.mjs
 *
 * Run it against a stack with NO account yet — it redeems the single-use setup token. Steps 8 to
 * 12 connect real IMAP mailboxes and put a real message through them, so point SMOKE_MAIL_* at a
 * disposable mail server, never at the mailbox you read your own mail in.
 *
 * If `docker` refuses with a permission error your user is not in the `docker` group, and the one
 * `docker compose logs api` call fails. Run the whole script under the group — NOT inside
 * SMOKE_COMPOSE, which is split on whitespace into an argv:
 *
 *   sg docker -c 'SMOKE_BASE=https://mail.example.com node boot-smoke.mjs'
 *
 * The defaults are the compose stack and the `.env` beside this file, so a plain
 * `node boot-smoke.mjs` runs against the install in this directory. A CI job that boots the stack
 * some other way passes SMOKE_COMPOSE and SMOKE_ENV_FILE.
 *
 * It performs the ENTIRE first-run ceremony a human would, over the proxy origin, with nothing
 * mocked: read the setup token out of `docker compose logs api`, redeem it, register, enroll
 * TOTP, sign in, add two real IMAP mailboxes, watch seeded mail arrive in /sync, and push real
 * bytes through a presigned staging upload.
 *
 * WHY THIS JOB EXISTS — the accepted-risk tripwires it stands guard over. The self-host server
 * is deliberately a SECOND composition root beside the managed one (extraction would churn the
 * managed deploy on every self-host edit), and three of that decision's failure modes are
 * invisible to unit suites because each one is a coherent, compiling program:
 *
 *  1. TWO-SHAPES DRIFT — a service wired into the managed composition and forgotten here.
 *     The ceremony exercises the self-host bag end to end, so a hole in the composition fails a
 *     step instead of a customer.
 *  2. WORKER ROSTER POLARITY — the organizer's duty roster is phrased as a DISABLED list
 *     ("an account with no billing row keeps syncing"). One polarity flip in a refactor kills
 *     every self-host mailbox silently while every hosted test stays green. The seeded-mail
 *     step is the tripwire: mail MUST appear in /sync on a database with zero billing rows.
 *  3. PAID-GATE DEFAULT — loading the full services barrel registers the hosted PAID mailbox
 *     allowance as the process default; the self-host composition overrides it explicitly.
 *     Drop that one argument and `POST /mailboxes` refuses with a subscription error on a
 *     server with no subscriptions. The TWO-mailbox step with zero billing env is the guard.
 *
 * FAILURE DISCIPLINE. Every step exits non-zero with the step name, the expectation and the
 * observed value — no assertion is a pipeline (`cmd | grep` misreports both directions), no
 * exit code comes from anything but the checked call itself, and the readiness wait matches on
 * parsed JSON, never on log text.
 */

import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── Knobs, all env-overridable; the defaults are the stack in this directory ─────────────
const BASE = process.env.SMOKE_BASE ?? "http://localhost:3080";
const ENV_FILE = process.env.SMOKE_ENV_FILE ?? path.join(HERE, ".env");
/* An ARGV ARRAY, not a string. This was a template string split on whitespace at the call
 * site, which broke the first time the checkout's absolute path contained a space — the
 * split handed docker half a path as its subcommand. CI paths never carry spaces, so only a
 * local run could catch it. SMOKE_COMPOSE stays a string knob and inherits the limitation;
 * the default is what has to work everywhere. */
const COMPOSE = process.env.SMOKE_COMPOSE?.split(/\s+/) ?? [
  "docker", "compose",
  "-f", path.join(HERE, "docker-compose.yml"),
  "--env-file", ENV_FILE,
];
/** Where the compose's RustFS (in-network `rustfs:9000`) is published on this host. */
const STORE_HOSTPORT = process.env.SMOKE_STORE ?? "127.0.0.1:3903";
/** Where GreenMail's SMTP (in-network `greenmail:3025`) is published on this host. */
const SMTP_HOSTPORT = process.env.SMOKE_SMTP ?? "127.0.0.1:3026";
const READY_TIMEOUT_MS = Number(process.env.SMOKE_READY_TIMEOUT_MS ?? 420_000);
const SYNC_TIMEOUT_MS = Number(process.env.SMOKE_SYNC_TIMEOUT_MS ?? 240_000);

const OWNER_EMAIL = "smoke-owner@selfhost.example";
/* MINTED PER RUN, never a literal. This check runs against an operator's OWN stack, and the
   account it registers there is a real one: a password written into a published file would be a
   known password on somebody's mail server for as long as they keep the account. */
const PASSWORD = `smoke-${randomUUID()}`;
/* The disposable mail server, as knobs so the mailbox and sync steps run against an install that
 * is not this repository's compose. Defaults are the CI overlay's GreenMail. SMOKE_MAIL_PORT is
 * the IMAP port the API dials from INSIDE the compose network, not the host-published one. */
const MAIL_HOST = process.env.SMOKE_MAIL_HOST ?? "greenmail";
const MAIL_PORT = Number(process.env.SMOKE_MAIL_PORT ?? 143);
const MAIL_DOMAIN = process.env.SMOKE_MAIL_DOMAIN ?? "greenmail.test";
const MAIL_PASS = process.env.SMOKE_MAIL_PASS ?? "smoke";
const MAILBOX_ONE = `smoke-owner@${MAIL_DOMAIN}`;
const MAILBOX_TWO = `smoke-archive@${MAIL_DOMAIN}`;

// ── Tiny harness: hard steps, loud failures, no silent green ─────────────────────────────
let stepNo = 0;
function step(name) {
  stepNo += 1;
  process.stdout.write(`\n[${stepNo}] ${name}\n`);
}
function fail(why, detail) {
  process.stdout.write(`\n✗ FAILED at step ${stepNo}: ${why}\n`);
  if (detail !== undefined) process.stdout.write(`${typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)}\n`);
  process.exit(1);
}
function assert(cond, why, detail) {
  if (!cond) fail(why, detail);
}
/** Status check that reads the body ONLY on mismatch — a passed argument would consume it. */
async function expectStatus(res, expected, why) {
  if (res.status !== expected) {
    fail(`${why} — expected ${expected}, got ${res.status}`, await res.text().catch(() => ""));
  }
  return res;
}
function ok(msg) {
  process.stdout.write(`  ✓ ${msg}\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── HTTP with a hand-held cookie jar (fetch stores nothing by itself) ─────────────────────
function jarOf(res) {
  const values = {};
  for (const line of res.headers.getSetCookie()) {
    const first = line.split(";")[0];
    const eq = first.indexOf("=");
    if (eq > 0) values[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  }
  return {
    cookie: Object.entries(values).map(([k, v]) => `${k}=${v}`).join("; "),
    csrf: values["tf_csrf"] ?? "",
  };
}

async function post(pathName, body, jar, extraHeaders = {}) {
  return fetch(`${BASE}${pathName}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(jar ? { cookie: jar.cookie, "x-csrf-token": jar.csrf } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

async function get(pathName, jar) {
  return fetch(`${BASE}${pathName}`, { headers: jar ? { cookie: jar.cookie } : {} });
}

/** A read of the front door's own socket under an authority NOBODY CONFIGURED. `fetch` cannot
 *  ask this question: undici overwrites a caller's `Host`, so the request arrives as the origin
 *  after all and the check passes on a door that would have answered nothing. */
function rawGet(pathName, hostHeader) {
  const u = new URL(BASE);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: u.hostname, port: u.port || 80, path: pathName, headers: { host: hostHeader },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

// ── RFC 6238 TOTP (SHA-1, 30 s, 6 digits) over the enrollment's Base32 secret ────────────
function base32Decode(s) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) fail(`TOTP secret contains a non-Base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
function totp(secret, atMs) {
  const counter = Math.floor(atMs / 1000 / 30);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const code = ((h[off] & 0x7f) << 24 | h[off + 1] << 16 | h[off + 2] << 8 | h[off + 3]) % 1_000_000;
  return String(code).padStart(6, "0");
}

// ── Shelling out, with the exit code captured from the command itself ─────────────────────
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error) fail(`could not run ${cmd}: ${r.error.message}`);
  return r;
}
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** The dotenv values the compose was started with (RustFS credential for the download half). */
function envFileValues() {
  const out = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
async function main() {
  // [1] The stack answers through the PROXY origin — /hello parsed, never log-matched.
  step(`waiting for the stack at ${BASE} (up to ${READY_TIMEOUT_MS / 1000}s)`);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let hello = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/hello`);
      if (res.status === 200) { hello = await res.json(); break; }
    } catch { /* not up yet */ }
    await sleep(3000);
  }
  assert(hello !== null, `the stack never answered GET ${BASE}/hello with 200`);
  ok(`/hello answered: ${JSON.stringify(hello)}`);

  // [2] The fresh-box capability statement.
  step("fresh-box /hello: selfhost, needsSetup:true, staging armed, pairing on, no open signup");
  assert(hello.product === "ohmail", "product must be ohmail", hello);
  assert(hello.flavor === "selfhost", "flavor must be selfhost", hello);
  assert(hello.needsSetup === true, "a fresh box must advertise needsSetup:true (is this a re-run against a dirty stack? `docker compose down -v` first)", hello);
  assert(hello.auth?.publicSignup === false, "open signup must NOT exist on this composition", hello);
  assert(hello.features?.staging === true, "staging must be armed — the compose wires RustFS through the storage factory", hello);
  assert(hello.features?.pairing === true, "pairing must be announced — this table mounts /pair*", hello);
  assert(hello.features?.sse === true, "sse is pinned on for the long-running server", hello);
  ok("capability statement is the fresh-box truth");

  // [3] The proxy split, and THE FIRST-RUN DOOR: on a fresh box an anonymous `GET /` is
  // redirected to the guided setup page — the web container's middleware asked the api (by its
  // in-network name, OHMAIL_INTERNAL_API_ORIGIN) whether the server still needs its first
  // account. This one assertion proves the whole chain live: the flavor-compiled middleware
  // branch, the internal /hello probe, and the /setup route existing at the other end.
  step("the proxy split + the first-run door: / redirects to /setup, the marketing site is absent, /api/hello is the API");
  const door = await fetch(`${BASE}/`, { redirect: "manual" });
  assert(door.status === 307,
    `an anonymous GET / on a fresh box must 307 to the setup ceremony (got ${door.status}) — ` +
    "is the web image built with this slice's middleware, and does the compose set OHMAIL_INTERNAL_API_ORIGIN?");
  const doorTo = door.headers.get("location") ?? "";
  assert(new URL(doorTo, BASE).pathname === "/setup", `the redirect must land on /setup (got ${doorTo})`);
  const setupPage = await fetch(`${BASE}/setup`);
  assert(setupPage.status === 200, `GET /setup must answer 200 (got ${setupPage.status})`);
  const setupBody = await setupPage.text();
  assert(setupBody.toLowerCase().includes("ohmail"), "GET /setup must serve the web application");
  // THIS ORIGIN IS THE OPERATOR'S. It used to answer 200 here — the marketing route group is in
  // the same bundle as the app, so an install on `ohmail.theircompany.com` served OUR pricing,
  // OUR privacy policy and an imprint naming TrafficFlow GmbH as "operator of this website".
  // The self-host build refuses every one of those documents (`app/self-host-marketing.ts`), so
  // a 200 anywhere below means the web image was built without the flavor arm.
  for (const marketing of ["/privacy", "/imprint", "/subprocessors", "/de"]) {
    const res = await fetch(`${BASE}${marketing}`);
    assert(res.status === 404,
      `GET ${marketing} must NOT exist on a self-host install (got ${res.status}) — ` +
      "our marketing and legal pages must never be served from an operator's own domain");
  }
  const prefixed = await fetch(`${BASE}/api/hello`);
  assert(prefixed.status === 200, `GET /api/hello must answer 200 (got ${prefixed.status})`);
  const prefixedBody = await prefixed.json();
  assert(prefixedBody.flavor === "selfhost", "the API must strip ONE /api itself — no strip in the proxy", prefixedBody);
  ok("caddy routes the API's paths to api:8080, the web tier steers a fresh box to /setup");

  // [4] The setup token, read where the operator reads it: the api service's log.
  step("reading the first-run setup token from `docker compose logs api`");
  let token = process.env.SMOKE_SETUP_TOKEN ?? "";
  if (token === "") {
    const [composeCmd, ...composeArgs] = COMPOSE;
    const logs = run(composeCmd, [...composeArgs, "logs", "--no-color", "api"]);
    assert(logs.status === 0, "docker compose logs api failed", logs.stderr);
    const lines = stripAnsi(logs.stdout).split("\n").map((l) => l.replace(/^[^|]*\|\s?/, ""));
    const fenced = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes("FIRST-RUN SETUP")) continue;
      for (let j = i; j < Math.min(i + 12, lines.length); j++) {
        const m = /^\s{4,}([A-Za-z0-9_-]{16,})\s*$/.exec(lines[j]);
        if (m) fenced.push(m[1]);
      }
    }
    assert(fenced.length > 0, "no setup token found in the api log — the boot mint did not print");
    token = fenced[fenced.length - 1]; // a restart supersedes; only the LAST printed token lives
  }
  ok(`setup token recovered from the boot log (${token.length} chars)`);

  // [5] Redeem → invite code; the burned token must refuse a replay.
  step("redeeming the setup token (single-use, ownerless first-boot path)");
  const redeem = await post("/pair/redeem", { grant: "invite", token, email: OWNER_EMAIL });
  await expectStatus(redeem, 200, "the setup-token redeem");
  const { invite } = await redeem.json();
  assert(typeof invite?.code === "string" && invite.code.length > 0, "redeem must return an invite code", invite);
  const replay = await post("/pair/redeem", { grant: "invite", token, email: "thief@selfhost.example" });
  assert(replay.status === 400, `a replay of the burned token must answer 400 (got ${replay.status})`);
  ok("token redeemed once, replay refused");

  // [6] Register + TOTP enrollment + full sign-in — the ceremony a human performs.
  step("register, enroll TOTP, sign in");
  const reg = await post("/auth/register", {
    email: OWNER_EMAIL, password: PASSWORD, displayName: "Smoke", inviteCode: invite.code,
  });
  await expectStatus(reg, 201, "register");
  const enrollment = jarOf(reg);
  const enroll = await post("/auth/2fa/totp/enroll", {}, enrollment);
  await expectStatus(enroll, 200, "totp enroll");
  const { secret } = await enroll.json();
  const activate = await post("/auth/2fa/totp/activate", { code: totp(secret, Date.now()) }, enrollment);
  await expectStatus(activate, 200, "totp activate");
  const login = await post("/auth/login", { email: OWNER_EMAIL, password: PASSWORD });
  await expectStatus(login, 200, "login");
  const l = await login.json();
  assert(l.status === "twofa_required", "login must demand the second factor", l);
  // The NEXT time-step's code: activation consumed the current step (single-use per step is
  // the replay guard), and the ±1-step skew window makes step+1 verifiable right now.
  const verify = await post("/auth/2fa/totp/verify", { loginToken: l.loginToken, code: totp(secret, Date.now() + 30_000) });
  await expectStatus(verify, 200, "totp verify");
  const setCookies = verify.headers.getSetCookie();
  const jar = jarOf(verify);
  ok("full session established through the proxy origin");

  // [7] The cookie contract, attribute by attribute, from the real Set-Cookie lines.
  step("session cookie attributes: HttpOnly, SameSite=Strict, Secure, and NO Domain=");
  const byName = new Map(setCookies.map((line) => [line.split("=")[0], line]));
  for (const name of ["tf_session", "tf_refresh", "tf_csrf", "tf_resume"]) {
    assert(byName.has(name), `${name} must be minted on sign-in`, [...byName.keys()]);
  }
  for (const [name, line] of byName) {
    const redacted = line.replace(/^([^=]+)=[^;]*/, "$1=<redacted>");
    // `Secure` is unconditional — including over http://localhost, where every major browser
    // except Safari accepts it (the same-box caveat the Caddyfile documents).
    assert(/;\s*Secure/i.test(line), `${name} must be Secure`, redacted);
    assert(!/Domain=/i.test(line), `${name} must be HOST-ONLY — a Domain= attribute is the widening this topology forbids`, redacted);
    if (name === "tf_resume") assert(/SameSite=Lax/i.test(line), `${name} must be SameSite=Lax`, redacted);
    else assert(/SameSite=Strict/i.test(line), `${name} must be SameSite=Strict`, redacted);
    if (name === "tf_session" || name === "tf_refresh" || name === "tf_resume") {
      assert(/HttpOnly/i.test(line), `${name} must be HttpOnly`, redacted);
    }
    if (name === "tf_csrf") {
      assert(!/HttpOnly/i.test(line), "tf_csrf must NOT be HttpOnly — the double-submit needs the client to read it", redacted);
    }
    // BROWSER SEMANTICS the hand-held jar cannot feel, asserted from the attributes instead:
    // this script resends every value regardless of Path or lifetime, so a cookie scoped off
    // `/` or emitted expired would still authenticate HERE while a real browser withheld or
    // deleted it. The refresh cookie is the ONE deliberate narrow path; everything else must
    // be Path=/ and carry a positive Max-Age.
    if (name !== "tf_refresh") {
      assert(/Path=\/(;|\s|$)/.test(line), `${name} must be scoped Path=/ — narrower and a browser stops sending it where the app needs it`, redacted);
    }
    const maxAge = /Max-Age=(-?\d+)/.exec(line);
    assert(maxAge !== null && Number(maxAge[1]) > 0, `${name} must carry a positive Max-Age — 0 or negative is a deletion, not a session`, redacted);
    ok(redacted);
  }
  assert(/Path=\/auth\/refresh/.test(byName.get("tf_refresh")), "tf_refresh must stay scoped to Path=/auth/refresh through the proxy");

  // [8] CSRF double-submit is live on a mutation.
  // Product routes are called under /api from here on — the spelling the browser client
  // uses (NEXT_PUBLIC_API_BASE=/api). The auth/pair ceremony above ran UNPREFIXED through
  // the proxy's named exceptions, so both spellings of the split are exercised in one run.
  step("CSRF: no header 403, wrong header 403, matching header mutates");
  const mailboxBody = (address) => ({
    provider: "imap",
    address,
    imap: {
      host: MAIL_HOST, port: MAIL_PORT, secure: false, allowInsecure: true,
      user: address, pass: MAIL_PASS,
    },
  });
  const noHeader = await fetch(`${BASE}/api/mailboxes`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: jar.cookie },
    body: JSON.stringify(mailboxBody(MAILBOX_ONE)),
  });
  assert(noHeader.status === 403, `a cookie mutation with no X-CSRF-Token must answer 403 (got ${noHeader.status})`);
  const wrong = await post("/api/mailboxes", mailboxBody(MAILBOX_ONE), { cookie: jar.cookie, csrf: "not-the-derivation" });
  assert(wrong.status === 403, `a wrong X-CSRF-Token must answer 403 (got ${wrong.status})`);
  const right = await post("/api/mailboxes", mailboxBody(MAILBOX_ONE), jar);
  await expectStatus(right, 201, "the matching double-submit mailbox create");
  const mailboxOne = await right.json();
  assert(typeof mailboxOne.id === "string", "the create must return the mailbox id", mailboxOne);
  ok(`CSRF enforced; first mailbox created (${mailboxOne.id}) — the probe dialed the real IMAP server`);

  // [9] TRIPWIRE (paid-gate default): a SECOND mailbox with ZERO billing env. If the explicit
  // unmetered allowance ever falls out of the composition, the barrel's registered PAID gate
  // answers here with a subscription error on a server that has no subscriptions.
  step("second mailbox with zero billing env — the unmetered-allowance tripwire");
  const second = await post("/api/mailboxes", mailboxBody(MAILBOX_TWO), jar);
  await expectStatus(second, 201,
    "the second mailbox with zero billing env — a refusal here means the explicit unmetered " +
    "allowance was dropped and the hosted paid gate is answering");
  ok("two mailboxes, no billing tables consulted");

  // [10] Seed one real message into the disposable mail server, from OUTSIDE the product.
  step("seeding one message into GreenMail over SMTP");
  const subject = `smoke-${randomUUID().slice(0, 12)}`;
  const tmp = mkdtempSync(path.join(tmpdir(), "ohmail-smoke-"));
  const eml = path.join(tmp, "seed.eml");
  writeFileSync(eml, [
    `From: Outside Sender <sender@external.example>`,
    `To: ${MAILBOX_ONE}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@external.example>`,
    ``,
    `The self-host boot smoke seeded this message.`,
    ``,
  ].join("\r\n"));
  const [smtpHost, smtpPort] = SMTP_HOSTPORT.split(":");
  const smtpSend = run("curl", [
    "-sS", "--url", `smtp://${smtpHost}:${smtpPort}`,
    "--mail-from", "sender@external.example",
    "--mail-rcpt", MAILBOX_ONE,
    "--upload-file", eml,
  ]);
  assert(smtpSend.status === 0, "SMTP seed via curl failed", smtpSend.stderr);
  ok(`seeded "${subject}" for ${MAILBOX_ONE}`);

  // [11] TRIPWIRE (worker roster polarity): the ORGANIZER must sync that message on an
  // account with NO billing row, and it must land in GET /sync. The organizer's duty roster
  // is deliberately phrased as a disabled-list; a refactor that flips it to an enabled-list
  // keeps every hosted test green and silently kills every self-host mailbox — THIS step is
  // where that flip goes red.
  step(`waiting for the organizer to sync the seeded message into /sync (up to ${SYNC_TIMEOUT_MS / 1000}s)`);
  const syncDeadline = Date.now() + SYNC_TIMEOUT_MS;
  let found = false;
  let lastCount = -1;
  while (Date.now() < syncDeadline) {
    const res = await get("/api/sync?types=message&limit=500", jar);
    await expectStatus(res, 200, "GET /sync");
    const body = await res.text();
    lastCount = (body.match(/"type"\s*:\s*"message"/g) ?? []).length;
    if (body.includes(subject)) { found = true; break; }
    await sleep(5000);
  }
  assert(found,
    `the seeded message never appeared in /sync — the organizer is not syncing this mailbox. ` +
    `On a database with zero billing rows that is the roster-polarity failure this smoke exists ` +
    `to catch (last /sync held ${lastCount} message change(s)). Read: docker compose logs organizer`);
  ok(`"${subject}" arrived in GET /sync — no-billing-row accounts keep syncing`);

  // [12] The attachment-staging round-trip, ON THE BROWSER'S WIRE: mint → PUT through the
  // PROXY ORIGIN → download. Presigning is LOCAL key derivation, so a missing bucket or a
  // wrong credential only surfaces at the PUT — which is why this step uploads real bytes
  // instead of trusting the 201. And the PUT deliberately goes where a browser's would: the
  // grant is presigned against the public origin (S3_PUBLIC_ENDPOINT defaulting to
  // OHMAIL_ORIGIN) and travels the Caddyfile's `/<bucket>/*` route, Host preserved — the
  // same-origin shape the app's CSP requires. A grant that names the in-network endpoint
  // again IS the regression this step exists to catch: it uploads fine from inside the
  // network and fails in every real browser.
  step("attachment staging: mint a grant, PUT real bytes THROUGH THE PROXY, download them back");
  const payload = `ohmail boot smoke ${subject} ${"x".repeat(1024)}`;
  /* `POST /attachments/staging` reads this header itself and answers 400 without it. A fresh uuid
   * per run: the key is what makes a retry of this mint the same mint. */
  /* AND WHAT THE BYTES ARE (cloud 0041). The send hashes what it downloads and refuses a
   * mismatch, so declaring it here is what puts that comparison on the smoke's own wire rather
   * than only in a suite: a stack whose storage hands back other bytes fails at the send. */
  const mint = await post("/api/attachments/staging", {
    mailboxId: mailboxOne.id, filename: "smoke.txt", contentType: "text/plain",
    sizeBytes: Buffer.byteLength(payload),
    contentSha256: createHash("sha256").update(payload).digest("hex"),
  }, jar, { "idempotency-key": `smoke-staging-${randomUUID()}` });
  await expectStatus(mint, 201, "the staging mint");
  const grant = await mint.json();
  assert(typeof grant.uploadUrl === "string" && grant.uploadMethod === "PUT", "the grant must carry uploadUrl + PUT", grant);
  const grantUrl = new URL(grant.uploadUrl);
  const baseUrl = new URL(BASE);
  assert(grantUrl.host === baseUrl.host,
    `the grant must presign the PUBLIC origin a browser can reach (expected ${baseUrl.host}, got ${grantUrl.host})`);
  // The browser's PUT, verbatim: the grant's URL and headers, same-origin, no credential of
  // ours anywhere in the request. This exercises the whole chain — public-origin signature,
  // Caddy's staging route, the Host-preserved hop, the PRIVATE bucket honouring the grant.
  const put = await fetch(grant.uploadUrl, {
    method: grant.uploadMethod,
    headers: grant.uploadHeaders ?? {},
    body: payload,
  });
  assert(put.status === 200, `the presigned PUT through the proxy must answer 200 (got ${put.status})`,
    await put.text().catch(() => ""));

  // THE PRIVATE-BUCKET TRIPWIRE. Exposing `/<bucket>/*` through the proxy is safe ONLY because
  // unsigned requests 403 — an anonymous bucket policy (one `rc bucket anonymous set` away) would
  // turn the route into a public byte store, and nothing else in the stack would notice. Both
  // verbs: GET is the read leak, PUT is the free upload.
  const bareObject = `${grantUrl.origin}${grantUrl.pathname}`;
  const anonGet = await fetch(bareObject);
  assert(anonGet.status === 403,
    `an UNSIGNED GET of a staged object must answer 403 — the bucket must stay private (got ${anonGet.status})`,
    await anonGet.text().catch(() => ""));
  const anonPut = await fetch(bareObject, { method: "PUT", body: "anonymous bytes" });
  assert(anonPut.status === 403,
    `an UNSIGNED PUT must answer 403 — the bucket must stay private (got ${anonPut.status})`,
    await anonPut.text().catch(() => ""));

  // Download with the SERVICE credential — the same read the send path performs when it
  // resolves a staged attachment — and compare bytes. This half runs on the INTERNAL wire
  // (the published RustFS port), which is where the api and organizer live.
  const envValues = envFileValues();
  // The compose reads the MinIO-era names when the RustFS ones are unset or empty; so does this.
  const s3User = envValues.RUSTFS_ROOT_USER || envValues.MINIO_ROOT_USER || "ohmail-staging";
  const s3Pass = envValues.RUSTFS_ROOT_PASSWORD || envValues.MINIO_ROOT_PASSWORD;
  assert(typeof s3Pass === "string" && s3Pass.length > 0,
    `neither RUSTFS_ROOT_PASSWORD nor MINIO_ROOT_PASSWORD is set in ${ENV_FILE}`);
  const objectUrl = `http://${STORE_HOSTPORT}${grantUrl.pathname}`;
  const downloaded = path.join(tmp, "download.bin");
  const dl = run("curl", [
    "-sS", "-o", downloaded, "-w", "%{http_code}",
    "--user", `${s3User}:${s3Pass}`, "--aws-sigv4", `aws:amz:${envValues.S3_REGION ?? "us-east-1"}:s3`,
    objectUrl,
  ]);
  assert(dl.status === 0 && dl.stdout.trim() === "200",
    `the authenticated download must answer 200 (curl rc=${dl.status}, http=${dl.stdout.trim()})`, dl.stderr);
  const roundTripped = readFileSync(downloaded, "utf8");
  assert(roundTripped === payload, "downloaded bytes must equal the uploaded bytes",
    { uploadedBytes: payload.length, downloadedBytes: roundTripped.length });
  ok(`mint → PUT via ${grantUrl.host} → download round-tripped ${payload.length} bytes; unsigned GET+PUT refused`);

  // [13] The ceremony flipped the box's own account of itself — on BOTH tiers: the API's
  // /hello answer, and the web tier's front door, which must stop steering to /setup the
  // moment the first account exists AND must land on the operator's sign-in, not on a pitch.
  //
  // THIS STEP USED TO ASSERT THE DEFECT. It read "an anonymous GET / must serve the landing
  // once the server has accounts" and passed with a 200 — which is exactly what the bug looked
  // like: a settled self-host box answering its root with 302 KB of ohmail's marketing site,
  // pricing section included, on a domain we do not own. Measured at `https://ohmail.test/`.
  step("/hello after the ceremony: needsSetup:false, staging still true, / is the operator's sign-in door");
  const after = await (await fetch(`${BASE}/hello`)).json();
  assert(after.needsSetup === false, "needsSetup must flip false once the first account exists", after);
  assert(after.features?.staging === true, "staging must still be armed", after);
  const doorAfter = await fetch(`${BASE}/`, { redirect: "manual" });
  assert(doorAfter.status === 307,
    `an anonymous GET / on a settled self-host box must 307 to the sign-in door (got ${doorAfter.status}) — ` +
    "a 200 here is the marketing site squatting the operator's origin");
  const doorAfterTo = new URL(doorAfter.headers.get("location") ?? "", BASE).pathname;
  assert(doorAfterTo === "/login", `the door must be /login (got ${doorAfterTo})`);

  // AND THE DOOR ITSELF SHOWS NO PITCH. A redirect is worth little if the page at the other end
  // still sells ohmail Cloud, so the sign-in page is read and searched for the landing's own
  // sentences — each unique to the pricing/plan sections and none of them at home on a form.
  //
  // SEARCHED OVER THE RENDERED MARKUP, NOT THE RAW BODY, and the difference is not a
  // convenience: `NextIntlClientProvider` ships the WHOLE `messages/en.json` catalogue —
  // pricing section included — into the RSC flight payload of every page, on every flavor.
  // Measured on a self-host build: 166 KB of a 172 KB sign-in document is that payload. Nobody
  // can read it and no browser paints it, but a raw `includes()` would match it, so an
  // assertion written that way would fail here for ever and teach the next person to delete it.
  // Stripping <script> is what makes this check about what a PERSON sees. (The catalogue's size
  // on the product tree is a real cost and a separate question — it is not this defect, and it
  // is identical on ohmail.app.)
  const OURS = ["ours to run, monthly", "Self-hosted Cloud", "the same server run by us", "pricing-title"];
  const painted = (html) => html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, "");
  const loginPage = await fetch(`${BASE}/login`);
  assert(loginPage.status === 200, `GET /login must answer 200 (got ${loginPage.status})`);
  const loginBody = await loginPage.text();
  const leaked = OURS.filter((s) => painted(loginBody).includes(s));
  assert(leaked.length === 0,
    `the sign-in door must show none of our marketing copy (found: ${leaked.join(", ")})`);
  assert(/type="password"/.test(loginBody), "the sign-in door must actually render the sign-in form");
  ok(`/hello now answers: ${JSON.stringify(after)}; / → 307 /login, and the door shows no ohmail pitch`);

  // [14] WHICH BUILD IS THIS, ASKED THE WAY EVERY READER ASKS IT. `/version` carries the token,
  // and the front door has to hand it over whatever address the caller dialled: Caddy's own
  // answer to a Host matching no site block is a bare 200 with an EMPTY BODY, which a monitor
  // and this project's release check both read as a healthy install. So the token is read twice
  // — through the origin, and through the same socket under a name nobody configured — and the
  // two must be the same bytes, with every other path on that door refusing rather than
  // answering 200 with nothing.
  step("/version identifies the build through the origin AND under an unmatched Host");
  const versionRes = await fetch(`${BASE}/version`);
  await expectStatus(versionRes, 200, "GET /version through the origin");
  const versionBody = await versionRes.text();
  assert(/"build"\s*:\s*"[^"]+"/.test(versionBody),
    "GET /version through the origin carried no build token", versionBody.slice(0, 200));
  if (new URL(BASE).protocol === "http:") {
    const alt = await rawGet("/version", "front-door-probe.invalid");
    assert(alt.status === 200 && alt.body === versionBody,
      `/version under an unmatched Host must be the origin's answer verbatim — got ${alt.status} ` +
      `with ${alt.body.length} bytes against ${versionBody.length}`, alt.body.slice(0, 200));
    const altRoot = await rawGet("/", "front-door-probe.invalid");
    assert(altRoot.status >= 400,
      `an unmatched Host must be refused, not answered ${altRoot.status} with ${altRoot.body.length} ` +
      "bytes — a reader cannot tell that from a healthy install serving nothing");
    ok(`/version is ${versionBody.trim()} through the origin and verbatim under an unmatched Host, ` +
       `which is refused ${altRoot.status} everywhere else`);
  } else {
    // The any-address door is the PLAIN-HTTP one by design: an https dial under an unknown name
    // has no certificate to present, which is the same refusal by another mechanism.
    ok(`/version is ${versionBody.trim()}; the unmatched-Host arm needs the http door, and ${BASE} is https`);
  }

  // [15] THE API'S OWN ALERT PASS. Nothing outside a self-hosted api calls its alert routes, and its
  // pass is the only one that sees a stopped organizer, so TF_ALERT_SECRET arms the routes AND a
  // pass inside the api every minute. The secret is read where compose read it — the shell first,
  // then the env file — and never written here. Unarmed, the documented answer is 404.
  const alertSecret = (process.env.TF_ALERT_SECRET || envValues.TF_ALERT_SECRET || "")
    .trim().replace(/^(["'])(.*)\1$/, "$2");
  if (alertSecret.length >= 24) {
    step("the api's alert pass: GET /internal/alerts shows the api driver's last pass (up to 90s), /health no alertsFault");
    const wrongBearer = await fetch(`${BASE}/internal/alerts`, { headers: { authorization: `Bearer ${randomUUID()}` } });
    assert(wrongBearer.status === 401, `a wrong bearer must answer 401 (got ${wrongBearer.status})`);
    const alertDeadline = Date.now() + 90_000;
    let alertRead = null;
    let apiDriver = null;
    while (Date.now() < alertDeadline) {
      const res = await fetch(`${BASE}/internal/alerts`, { headers: { authorization: `Bearer ${alertSecret}` } });
      await expectStatus(res, 200,
        "GET /internal/alerts with the stack's secret (503 alerts_db_unarmed: the api composed no handle for its pass)");
      alertRead = await res.json();
      const api = (alertRead.drivers ?? []).find((d) => d.driver === "api");
      if (api?.ranAt && Date.parse(alertRead.now) - Date.parse(api.ranAt) <= 90_000) { apiDriver = api; break; }
      await sleep(5000);
    }
    assert(apiDriver !== null,
      "the api's alert pass has not run in the last 90s — read: docker compose logs api (alert_clock_armed, alert_pass_failed)",
      alertRead);
    const healthRes = await fetch(`${BASE}/health`);
    await expectStatus(healthRes, 200, "GET /health");
    const health = await healthRes.json();
    assert(!("alertsFault" in health), "an armed pager must leave /health without alertsFault", health.alertsFault);
    assert(Array.isArray(health.alertSinks), "/health must publish the api's alert arms as alertSinks", health);
    ok(`the api driver last ran at ${apiDriver.ranAt}; /health arms ${JSON.stringify(health.alertSinks.map((a) => a.name))}, ` +
       `${health.alertPasses} pass(es) on this api`);
  } else {
    step("the pager is unarmed (no TF_ALERT_SECRET of 24+ characters): the alert endpoint answers 404");
    const res = await fetch(`${BASE}/internal/alerts`);
    assert(res.status === 404, `with no TF_ALERT_SECRET, GET /internal/alerts must answer 404 (got ${res.status})`);
    ok("no secret, no alert endpoint and no api alert pass — the documented unarmed state");
  }

  // [16] SIGNING OUT THROUGH THE FRONT DOOR. The web client signs out at the door below the
  // refresh cookie's path, the one path a browser sends `tf_refresh` to, so the proxy has to carry
  // it to the API. Last, because it ends the session every step above used.
  step("sign out at the refresh path's door: 204, the five session cookies expired, the refresh refused after");
  const signedOut = await post("/auth/refresh/logout", {}, jar);
  await expectStatus(signedOut, 204, "the sign-out door with the signed-in jar");
  const cleared = signedOut.headers.getSetCookie();
  const clearedNames = cleared.map((line) => line.split("=")[0]).sort();
  assert(clearedNames.join(",") === "tf_csrf,tf_owner,tf_refresh,tf_resume,tf_session",
    "the sign-out must expire the five session cookies by name", clearedNames);
  for (const line of cleared) {
    const redacted = line.replace(/^([^=]+)=[^;]*/, "$1=<redacted>");
    assert(/Max-Age=0(;|$)/.test(line), "every cleared cookie must carry Max-Age=0", redacted);
    assert(!/Domain=/i.test(line), "a cleared cookie must stay host-only", redacted);
  }
  assert(/Path=\/auth\/refresh(;|$)/.test(cleared.find((line) => line.startsWith("tf_refresh=")) ?? ""),
    "the refresh cookie's clear must name its own path, or a browser keeps the cookie");
  const renewAfter = await post("/auth/refresh", {}, jar);
  assert(renewAfter.status === 401, `the signed-out jar must not renew (got ${renewAfter.status})`);
  ok("signed out through the proxy: 204, five cookies expired, and the session no longer renews");

  process.stdout.write("\n✓ BOOT SMOKE GREEN — compose boots, migrates, signs in, syncs seeded mail, stages bytes, signs out.\n");
}

main().catch((err) => {
  fail(`unhandled error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
});
