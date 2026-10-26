import { connect as netConnect } from "node:net";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ImapFlow } from "imapflow";
import type { ImapConfig } from "../../src/adapters/imap-types.js";
import { greenmailEndpoint, readLaneGreenmail } from "../../../../scripts/lib/lane-greenmail-env.mjs";
import { CONDSTORE_HOST, CONDSTORE_PORT, TEST_SERVICES, probedService, serviceUp } from "../../../../test/support/services.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/**
 * A fresh GreenMail user per test → isolated mailbox (no cross-test contamination). The server is
 * this checkout's own GreenMail when `.lane-greenmail.env` exists (read FIRST, and refused when the
 * run did not apply it), else `IMAP_HOST`/`IMAP_PORT`/`SMTP_*`, else the shared box.
 */
export function greenmailConfig(): ImapConfig {
  const user = `t-${randomUUID()}@trafficflow.test`;
  const gm = greenmailEndpoint(process.env, readLaneGreenmail(REPO_ROOT));
  return {
    host: gm.imapHost,
    port: gm.imapPort,
    secure: false,
    auth: { user, pass: "test" },
    smtp: { host: gm.smtpHost, port: gm.smtpPort, secure: false },
    sentDomain: "trafficflow.test",
  };
}

/** Build a minimal RFC822 message. */
export function eml(opts: { from: string; to?: string; subject: string; messageId: string; body?: string }): string {
  return [
    `Message-ID: <${opts.messageId}>`,
    `From: ${opts.from}`,
    `To: ${opts.to ?? "mila@lichtgrat.example"}`,
    `Subject: ${opts.subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    opts.body ?? "hello",
  ].join("\r\n");
}

export async function waitFor(pred: () => boolean | Promise<boolean>, ms = 5000, step = 50): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error("waitFor: timed out");
}

/**
 * ── A LOCATOR REF IS `<uidValidity>:<uid>`, AND ONLY THE SERVER MAY SAY THE FIRST HALF ────────
 *
 * Every GreenMail-backed file below used to build its own source locator as `` `1:${uid}` ``, on
 * the unstated assumption that a fresh mailbox is at UIDVALIDITY 1. GreenMail 2.1.3 stamps the
 * CONTAINER'S START TIME instead — 1788537505 on the run this helper was written for — the same
 * value for every user, changing on every `docker compose up`. So the fabricated epoch was never
 * the server's, and `ImapAdapter.assertLocatorEpoch` (unconditional since that change) is right to
 * refuse it: a ref whose epoch contradicts the selected mailbox names a DIFFERENT message.
 *
 * Thirteen tests read `MessageGoneError: message not at source locator INBOX#1:1` for it, and none
 * of them could ever have passed against a real server. They looked green only because nothing had
 * a mail server to run against — see the project's design notes.
 *
 * The fix is this helper rather than a per-file constant, because the point is that the epoch is
 * READ and never assumed: a test that spells one out is a test that will lie again on the next
 * server whose UIDVALIDITY policy differs.
 */
export async function seedInbox(
  cfg: ImapConfig,
  messageId: string,
  opts: { from?: string; subject?: string } = {},
): Promise<{ uid: number; uidValidity: string; ref: string }> {
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await c.connect();
  const lock = await c.getMailboxLock("INBOX");
  let uid = 0;
  let uidValidity = "0";
  try {
    await c.append("INBOX", eml({ from: opts.from ?? "s@x.example", subject: opts.subject ?? "mv", messageId }));
    const mb = c.mailbox;
    // Read AFTER the append and under the same lock: this is the epoch the very next command on
    // any connection will run against, which is exactly what the adapter compares the ref to.
    if (mb && mb.uidValidity != null) uidValidity = String(mb.uidValidity);
    const found = await c.search({ header: { "message-id": messageId } }, { uid: true });
    uid = Array.isArray(found) && found.length ? Math.max(...found) : 0;
  } finally {
    lock.release();
    await c.logout();
  }
  return { uid, uidValidity, ref: `${uidValidity}:${uid}` };
}

/**
 * ── IS THERE A CONDSTORE SERVER? ASK THE SERVER, DO NOT ASK AN ENVIRONMENT VARIABLE ───────────
 *
 * Seven tests — the CONDSTORE fast path and the Dovecot half of the organizer peek — used to be
 * gated on `IMAP_CONDSTORE` being set. Nothing sets it. So on a machine where the Dovecot
 * container had been up for a day, those seven reported as "skipped" and everybody read that as
 * "not applicable" rather than "never run here". That is the same shape as the reds this suite
 * spent two days mistaking for infrastructure: a test nobody can observe is a test that drifts,
 * and the file this helper was written for had accumulated three superseded rulings that way.
 *
 * So the gate now DETECTS the server, and the env var is kept as a FORCE-ON override for a
 * CONDSTORE server this probe cannot see (a remote host, a tunnel, a server that answers slowly).
 *
 * ── WHY THE PROBE ASKS FOR CAPABILITIES AND NOT JUST A SOCKET ─────────────────────────────────
 *
 * "Something is listening" is the wrong question, and answering it would have introduced a defect
 * rather than removed one. `imap.changes.fastpath.test.ts` derived its port from `IMAP_PORT`,
 * which CI sets to **3143** — GreenMail. A TCP-only probe would therefore have found GreenMail
 * listening, declared CONDSTORE available, and run the CONDSTORE branch against a server that has
 * no CONDSTORE at all: a confident red pointing at the adapter, caused by the fixture. The port is
 * now read from `IMAP_CONDSTORE_PORT` (which is what `organizer-peek.imap.test.ts` already used —
 * the two files disagreed) and the probe additionally requires the server to ADVERTISE CONDSTORE.
 *
 * ── AND WHY IT LOGS IN ────────────────────────────────────────────────────────────────────────
 *
 * Dovecot does not advertise CONDSTORE before authentication. Measured on the container this was
 * written against: the greeting lists `IMAP4rev1 SASL-IR LOGIN-REFERRALS ID ENABLE IDLE LITERAL+
 * AUTH=PLAIN AUTH=LOGIN` and then says, in as many words, *"Pre-login capabilities listed,
 * post-login capabilities have more."* A probe that asked only the pre-login list would refuse a
 * perfectly good Dovecot for ever — the first version of this did, which is how the behaviour was
 * found. So the probe authenticates with the same throwaway credentials the tests use (the static
 * passdb takes any user at this password) and asks again. That also makes the probe prove the
 * precondition the tests actually need — reachable, authenticating, CONDSTORE — rather than a
 * weaker one that happens to correlate.
 *
 * The reason is returned rather than logged, so the caller can put it in a SKIPPED TEST'S NAME.
 * A skip that names the closed port is a skip somebody can act on; a silent one is how this got
 * here.
 */
export { CONDSTORE_HOST, CONDSTORE_PORT };

export type CondstoreProbe = { ok: true } | { ok: false; why: string };

/** Greet, LOGIN, then `CAPABILITY` — or the reason the exchange did not finish. */
function imapPostLoginCapabilities(
  host: string, port: number, timeoutMs: number,
): Promise<{ text: string } | { error: string }> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    let stage: "greeting" | "login" | "caps" = "greeting";
    const user = `probe-${randomUUID()}@trafficflow.test`;
    const pass = process.env.IMAP_CONDSTORE_PASS ?? "testpass-password";
    const sock = netConnect({ host, port });
    const finish = (v: { text: string } | { error: string }): void => {
      if (settled) return;
      settled = true;
      // A polite goodbye is not worth a second round-trip on a probe.
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once("timeout", () => finish({ error: `no answer within ${timeoutMs} ms at the ${stage} stage` }));
    sock.once("error", (e) => finish({ error: (e as NodeJS.ErrnoException).code ?? e.message }));
    sock.on("data", (b: Buffer) => {
      out += b.toString("utf8");
      if (stage === "greeting" && /^\* (OK|PREAUTH)/im.test(out)) {
        stage = "login";
        sock.write(`p1 LOGIN "${user}" "${pass}"\r\n`);
        return;
      }
      if (stage === "login" && /^p1 (OK|NO|BAD)/im.test(out)) {
        if (/^p1 (NO|BAD)/im.test(out)) {
          finish({ error: `the server refused the probe login (${user})` });
          return;
        }
        stage = "caps";
        out = "";                      // only the POST-login answer counts
        sock.write("p2 CAPABILITY\r\n");
        return;
      }
      if (stage === "caps" && /^p2 (OK|NO|BAD)/im.test(out)) finish({ text: out });
    });
    sock.once("close", () => finish({ error: `closed during the ${stage} stage` }));
  });
}

/** Dovecot holds every login from an address it refused one from for 4 s, up to 15 s after several. */
const AUTH_PENALTY_WAIT_MS = 20_000;

export async function probeCondstore(
  host: string = CONDSTORE_HOST, port: number = CONDSTORE_PORT, timeoutMs?: number,
): Promise<CondstoreProbe> {
  // FORCE-ON. An operator who says the server is there outranks a probe that cannot reach it.
  if (process.env.IMAP_CONDSTORE) return { ok: true };
  const remedy = `${TEST_SERVICES.dovecot.start} starts it, or set IMAP_CONDSTORE=1 to force these on`;
  /* The run's one probe first (test/setup/services.global.ts): absent is a skip without a dial
     (a failure under TF_REQUIRE_DOVECOT=1); listening, the exchange below must then succeed. */
  const at = `${host}:${port}`;
  const absent = serviceUp("dovecot", at);
  if (!absent.up) return { ok: false, why: `${absent.why} — ${remedy}` };
  const listening = probedService("dovecot", at)?.up === true;
  // CI's test connections all reach Dovecot from one address, so another file's refused login delays ours.
  const answer = await imapPostLoginCapabilities(host, port, timeoutMs ?? (listening ? AUTH_PENALTY_WAIT_MS : 2000));
  if ("error" in answer) {
    const why = `no IMAP server answered on ${at} (${answer.error})`;
    if (listening) throw new Error(`Dovecot listens at ${at}, but ${why}`);
    return { ok: false, why: `${why} — ${remedy}` };
  }
  if (!/\bCONDSTORE\b/i.test(answer.text)) {
    const why = `the server on ${at} answered IMAP but advertises no CONDSTORE (GreenMail does not have it — check IMAP_CONDSTORE_PORT points at Dovecot, not 3143)`;
    if (listening) throw new Error(why);
    return { ok: false, why };
  }
  return { ok: true };
}
