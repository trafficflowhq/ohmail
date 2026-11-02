import { describe, expect, it } from "vitest";
import { fixturePassword } from "../../../test/support/fixture-credentials.js";
import {
  classifySmtpSizeFailure, learnSmtpMaxSize,
  type SmtpSizeCreds, type SmtpSizeDial, type SmtpSizeDialAuth,
} from "../src/adapters/imap.js";

/**
 * ══ WHAT THE SENDING SERVER SAID IT WILL ACCEPT, LEARNED FOR A MAILBOX THAT IS ALREADY CONNECTED ══
 *
 * ── THE DEFECT THIS CLOSES, MEASURED ────────────────────────────────────────────────────────
 *
 * `mailboxes.smtp_max_size_bytes` is the only ceiling on an attachment once the bytes stop riding
 * the send request — the compose form promises `min(surface, SIZE)` and the send enforces the same
 * pair, and on the hosted client the surface is explicitly uncapped because the files go straight
 * to storage. An unprobed mailbox announces nothing, and "nothing" is deliberately read as the
 * strict product constant rather than as "no limit", because an unknown ceiling read as no ceiling
 * costs somebody a message they composed and waited for.
 *
 * The column was only ever written in two places: when a mailbox is CREATED with an SMTP block, and
 * when a PATCH re-dials SMTP — which means the user re-entering their password. Nothing back-filled
 * it. So every mailbox connected before that column existed announced nothing for ever, and every
 * one of them was pinned to the strict fallback no matter what its provider actually accepts.
 * Against the live database, many mailbox rows held NULL.
 *
 * THE RULE LIVES HERE, BESIDE THE DIAL IT DECIDES ABOUT, AND IT IS HOST-AGNOSTIC ON PURPOSE. Two
 * hosts want it — the long-running sync process, which already decrypts these credentials on every
 * roster pass, and a scheduled pass on the serverless API host — and they disagree about timeouts
 * and about which of them can even reach a submission port. Measured 2026-08-22: the sync host's
 * platform BLOCKS outbound submission, so every dial from there answers "Connection timeout" while
 * the IMAP dial to the same host on 993 completes in the next log line. Neither of those
 * differences belongs in the rule, which is why the rule is here and the dial is injected.
 *
 * ── WHAT THESE GUARDS PIN, AND THE MUTATIONS THAT PROVE THEM ────────────────────────────────
 *
 *  · a mailbox that already announced something is never re-dialled — drop the `announced` check
 *    and "does not dial when the answer is already stored" goes red with a dial count of 1;
 *  · an oauth transport is dialled with an ACCESS TOKEN obtained from the send path's own callback,
 *    never with the stored secret (which for such a row is a REFRESH token) and never in the
 *    password seat — return the callback's value as `pass` and the XOAUTH2 case goes red naming the
 *    token it would have sent as a password;
 *  · a mailbox whose token cannot be minted is UNLEARNED with a closed `token_unavailable` and no
 *    dial at all — remove the inner catch and the outer one still reports `failed`, but with
 *    `code: "unknown"`, so a dead grant becomes indistinguishable from a server that hung up: the
 *    mutation is watched going red on the CODE, which is the whole diagnostic value of the arm;
 *  · a server that announces nothing writes nothing, so the strict fallback stands — return the
 *    proof's `null` as a number and `silent` becomes `learned`;
 *  · a dial that throws is swallowed — remove the catch and the failure case rejects instead of
 *    reporting, which in the worker means one bad submission server stops an attach;
 *  · one attempt per process, whatever the roster does — drop the `attempted` guard and a mailbox
 *    that flaps dials its provider on every re-attach.
 */

const PASSWORD_SMTP: SmtpSizeCreds = {
  host: "smtp.example.net",
  port: 587,
  secure: false,
  auth: { user: "someone@example.net", pass: fixturePassword("smtp-size") },
};

/** An oauth2 mailbox: the shared builder yields a token callback, never a password. */
const OAUTH_SMTP: SmtpSizeCreds = {
  host: "smtp.office365.com",
  port: 587,
  secure: false,
  auth: { user: "someone@example.com", fetchAccessToken: async () => "an-access-token" },
};

interface DialCall { host: string; port: number; secure: boolean; auth: SmtpSizeDialAuth }

function spyDial(proof: { maxMessageBytes: number | null } | Error): {
  dial: SmtpSizeDial;
  calls: DialCall[];
} {
  const calls: DialCall[] = [];
  const dial: SmtpSizeDial = async (smtp) => {
    // The WHOLE auth member is recorded, not `user`/`pass` picked off it: the assertions below are
    // about which SEAT a secret lands in, and a spy that only reads the two password fields cannot
    // tell "sent as a token" from "sent as a password".
    calls.push({ host: smtp.host, port: smtp.port, secure: smtp.secure, auth: smtp.auth });
    if (proof instanceof Error) throw proof;
    return proof;
  };
  return { dial, calls };
}

/** The password calls, in the shape the pre-oauth assertions were written against. */
const passwordCalls = (calls: readonly DialCall[]): Array<{
  host: string; port: number; secure: boolean; user: string; pass: string;
}> => calls.map((c) => ({
  host: c.host, port: c.port, secure: c.secure,
  user: c.auth.user, pass: "pass" in c.auth ? c.auth.pass : `NOT-A-PASSWORD:${c.auth.accessToken}`,
}));

describe("learnSmtpMaxSize — one dial, and only when it can answer a question nobody has answered", () => {
  it("does not dial when the answer is already stored", async () => {
    const { dial, calls } = spyDial({ maxMessageBytes: 25 * 1024 * 1024 });
    const res = await learnSmtpMaxSize({
      mailboxId: "mb-1", announced: 35_882_577, smtp: PASSWORD_SMTP,
      attempted: new Set(), dial,
    });
    expect(res).toEqual({ outcome: "known", maxMessageBytes: 35_882_577 });
    expect(calls).toHaveLength(0);
  });

  it("does not dial a mailbox with no SMTP credential row", async () => {
    const { dial, calls } = spyDial({ maxMessageBytes: 1 });
    const res = await learnSmtpMaxSize({
      mailboxId: "mb-2", announced: null, smtp: undefined, attempted: new Set(), dial,
    });
    expect(res).toEqual({ outcome: "skipped", reason: "no_smtp_credentials" });
    expect(calls).toHaveLength(0);
  });

  /**
   * ══ AN OAUTH MAILBOX IS PROBED WITH A TOKEN, THROUGH THE SEND PATH'S OWN CALLBACK ══════════
   *
   * This case used to assert the opposite — `skipped: "oauth_transport"` — and the assertion was
   * right about the danger and wrong about the remedy. The danger is real and unchanged: for an
   * oauth row the stored secret is a REFRESH TOKEN, so dialling with "the secret" would present a
   * refresh token to somebody else's AUTH command. The remedy was to refuse, which meant such a
   * mailbox could never learn what its server accepts from ANY host and stayed pinned to the
   * product's strict constant no matter how generous its provider was.
   *
   * So the rule now awaits `fetchAccessToken` — the same callback `ImapAdapter.send` awaits per
   * message, which is the whole point: one token path, one cache, one rotation-persist — and hands
   * the result to the dial in the TOKEN seat.
   */
  it("dials an OAUTH transport with an ACCESS TOKEN from the send path's own callback", async () => {
    const { dial, calls } = spyDial({ maxMessageBytes: 40 * 1024 * 1024 });
    let fetched = 0;
    const res = await learnSmtpMaxSize({
      mailboxId: "mb-3",
      announced: null,
      smtp: {
        ...OAUTH_SMTP,
        auth: {
          user: "someone@example.com",
          fetchAccessToken: async () => { fetched += 1; return "an-access-token"; },
        },
      },
      attempted: new Set(),
      dial,
    });

    expect(res).toEqual({ outcome: "learned", maxMessageBytes: 40 * 1024 * 1024 });
    expect(calls).toEqual([{
      host: "smtp.office365.com", port: 587, secure: false,
      auth: { user: "someone@example.com", accessToken: "an-access-token" },
    }]);
    // ONE fetch for one probe. The callback is the token provider's, and it reaches Microsoft on a
    // cache miss; a rule that called it twice would double every back-fill pass's token traffic.
    expect(fetched).toBe(1);
    // The seat is the assertion. `pass` anywhere in this call would be the refresh-token leak with
    // an extra step, and a token in the password seat is an `AUTH PLAIN` carrying a bearer.
    expect(JSON.stringify(calls)).not.toContain("pass");
  });

  it("NEVER sends the stored secret for an oauth row — the refresh token stays behind the callback", async () => {
    // The refresh token is what `buildImapAuth` closes over; nothing in this rule can see it. This
    // pins the consequence rather than the mechanism: whatever the callback returns is what travels,
    // and the token it returns is not the secret it was built from.
    const { dial, calls } = spyDial({ maxMessageBytes: 1 });
    await learnSmtpMaxSize({
      mailboxId: "mb-3b",
      announced: null,
      smtp: {
        ...OAUTH_SMTP,
        auth: {
          user: "someone@example.com",
          fetchAccessToken: async () => "minted-from-0.AXoA-the-refresh-token",
        },
      },
      attempted: new Set(),
      dial,
    });
    const wire = JSON.stringify(calls);
    expect(wire).toContain("minted-from-");
    expect(wire).not.toContain("\"pass\"");
  });

  it("a token that cannot be minted is UNLEARNED with a closed code, and nothing is dialled", async () => {
    // `fetchAccessToken` rejects for three reasons that are all somebody else's to fix — a dead
    // refresh token, a token endpoint that will not answer, a deployment with no client secret —
    // and every one of them must cost this mailbox its ceiling and nothing else. The error's
    // MESSAGE may not travel: it is written by the token endpoint.
    const { dial, calls } = spyDial({ maxMessageBytes: 1 });
    const res = await learnSmtpMaxSize({
      mailboxId: "mb-3c",
      announced: null,
      smtp: {
        ...OAUTH_SMTP,
        auth: {
          user: "someone@example.com",
          fetchAccessToken: async () => {
            throw new Error("AADSTS700082: refresh token expired for user someone@example.com");
          },
        },
      },
      attempted: new Set(),
      dial,
    });

    expect(res).toEqual({ outcome: "failed", code: "token_unavailable" });
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(res)).not.toContain("AADSTS700082");
    expect(JSON.stringify(res)).not.toContain("someone@example.com");
  });

  it("an EMPTY token is not a token — no dial, and not misreported as the server's refusal", async () => {
    // Presenting an empty bearer would produce `AUTH XOAUTH2` with nothing in it, which a provider
    // answers with an auth failure — and `auth_refused` would then blame the server for a condition
    // that never left this process.
    for (const empty of ["", "   "]) {
      const { dial, calls } = spyDial({ maxMessageBytes: 1 });
      const res = await learnSmtpMaxSize({
        mailboxId: `mb-3d-${empty.length}`,
        announced: null,
        smtp: { ...OAUTH_SMTP, auth: { user: "someone@example.com", fetchAccessToken: async () => empty } },
        attempted: new Set(),
        dial,
      });
      expect(res, `token ${JSON.stringify(empty)}`).toEqual({ outcome: "failed", code: "token_unavailable" });
      expect(calls).toHaveLength(0);
    }
  });

  it("a token failure still counts as the one attempt this process gets", async () => {
    // The once-per-process bound is marked BEFORE the dial precisely so a failure counts. A token
    // failure happens even earlier, and it must count too: otherwise a roster that re-attaches a
    // mailbox whose grant is dead asks the token endpoint again on every pass.
    const attempted = new Set<string>();
    const { dial } = spyDial({ maxMessageBytes: 1 });
    const smtp: SmtpSizeCreds = {
      ...OAUTH_SMTP,
      auth: { user: "someone@example.com", fetchAccessToken: async () => { throw new Error("nope"); } },
    };
    const first = await learnSmtpMaxSize({ mailboxId: "mb-3e", announced: null, smtp, attempted, dial });
    const second = await learnSmtpMaxSize({ mailboxId: "mb-3e", announced: null, smtp, attempted, dial });
    expect(first).toEqual({ outcome: "failed", code: "token_unavailable" });
    expect(second).toEqual({ outcome: "skipped", reason: "already_attempted" });
  });

  it("a credential shape with NEITHER a password nor a token is skipped, not dialled", async () => {
    // The fall-through. `SmtpSizeCreds.auth` is `unknown` because three hosts assemble it, so the
    // rule has to have an answer for a shape it does not recognise — and the answer is the same as
    // for a mailbox with no credentials at all.
    const { dial, calls } = spyDial({ maxMessageBytes: 1 });
    const res = await learnSmtpMaxSize({
      mailboxId: "mb-3f", announced: null,
      smtp: { host: "smtp.example.net", port: 587, secure: false, auth: { user: "u@example.net" } },
      attempted: new Set(), dial,
    });
    expect(res).toEqual({ outcome: "skipped", reason: "no_smtp_credentials" });
    expect(calls).toHaveLength(0);
  });

  it("dials the STORED coordinates and reports what the server announced", async () => {
    const { dial, calls } = spyDial({ maxMessageBytes: 52_428_800 });
    const res = await learnSmtpMaxSize({
      mailboxId: "mb-4", announced: null, smtp: PASSWORD_SMTP, attempted: new Set(), dial,
    });
    expect(res).toEqual({ outcome: "learned", maxMessageBytes: 52_428_800 });
    expect(passwordCalls(calls)).toEqual([{
      host: "smtp.example.net", port: 587, secure: false,
      user: "someone@example.net", pass: fixturePassword("smtp-size"),
    }]);
  });

  it("a server that announces nothing writes nothing — the strict fallback stands", async () => {
    const { dial, calls } = spyDial({ maxMessageBytes: null });
    const res = await learnSmtpMaxSize({
      mailboxId: "mb-5", announced: null, smtp: PASSWORD_SMTP, attempted: new Set(), dial,
    });
    expect(res).toEqual({ outcome: "silent" });
    expect(calls).toHaveLength(1);
  });

  it("a dial that fails is REPORTED, never thrown — an attach must not die on it", async () => {
    const { dial } = spyDial(new Error("535 authentication failed"));
    const res = await learnSmtpMaxSize({
      mailboxId: "mb-6", announced: null, smtp: PASSWORD_SMTP, attempted: new Set(), dial,
    });
    expect(res.outcome).toBe("failed");
    expect(res).toHaveProperty("code");
  });

  /**
   * ══ A FAILURE MAY NOT CARRY THE SERVER'S WORDS ════════════════════════════════════════════
   *
   * nodemailer's error text embeds the SMTP server's own response. On an AUTH failure that line is
   * written by somebody else's server and routinely contains the username; it can contain an
   * echoed credential and it can contain arbitrary provider-controlled text. Both callers LOG this
   * value, `reason` is an allowlisted field in the structured logger, and the value scrubber only
   * redacts strings that label themselves as secrets — so a raw message here is a path from a
   * third party's socket to a log drain.
   *
   * Mutation: return `err.message` instead of the code. Both cases below go red naming the exact
   * text that would have been published.
   */
  it("reports a CLOSED CODE and never the message, whatever the server said", async () => {
    const leaky = Object.assign(
      new Error(`535 5.7.8 Authentication failed for u@example.net with password ${fixturePassword("smtp-size")}`),
      { code: "EAUTH" },
    );
    const res = await learnSmtpMaxSize({
      mailboxId: "mb-6b", announced: null, smtp: PASSWORD_SMTP, attempted: new Set(), dial: spyDial(leaky).dial,
    });
    expect(res).toEqual({ outcome: "failed", code: "auth_refused" });
    // Nothing anywhere in the outcome repeats the server's sentence.
    expect(JSON.stringify(res)).not.toContain(fixturePassword("smtp-size"));
    expect(JSON.stringify(res)).not.toContain("u@example.net");
    expect(JSON.stringify(res)).not.toContain("535");
  });

  it("classifies from the error's CODE, never from its prose", () => {
    // The prose says "authentication"; the code says the socket never came up. The code wins,
    // because prose is what a remote server controls.
    expect(classifySmtpSizeFailure(Object.assign(new Error("authentication"), { code: "ETIMEDOUT" })))
      .toBe("unreachable");
    expect(classifySmtpSizeFailure(Object.assign(new Error("x"), { code: "EAUTH" }))).toBe("auth_refused");
    expect(classifySmtpSizeFailure(Object.assign(new Error("x"), { code: "ECONNECTION" }))).toBe("unreachable");
    expect(classifySmtpSizeFailure(Object.assign(new Error("x"), { code: "ESOCKET" }))).toBe("unreachable");
    expect(classifySmtpSizeFailure(Object.assign(new Error("x"), { code: "ETLS" }))).toBe("tls_refused");
    // No code at all — including this module's own `Connection closed` — is opaque, not guessed.
    expect(classifySmtpSizeFailure(new Error("Connection closed"))).toBe("unknown");
    expect(classifySmtpSizeFailure("a string")).toBe("unknown");
    expect(classifySmtpSizeFailure(undefined)).toBe("unknown");
  });

  it("a dial door's refusal and an unresolved name are unreachable: no connection was made", () => {
    // The API door's wire codes, the organizer's closed tokens, and the socket's own ENOTFOUND that
    // both doors keep for a name the deployment's resolver could not answer.
    for (const code of ["ENOTFOUND", "mailbox_host_refused", "mailbox_port_refused",
      "MAILBOX_HOST_REFUSED", "MAILBOX_PORT_REFUSED", "MAILBOX_PLAINTEXT_REFUSED"]) {
      expect(classifySmtpSizeFailure(Object.assign(new Error("x"), { code })), code).toBe("unreachable");
    }
    // CONTROL: a code the classifier does not know stays opaque.
    expect(classifySmtpSizeFailure(Object.assign(new Error("x"), { code: "mailbox_busy" }))).toBe("unknown");
  });

  it("tries a mailbox at most ONCE per process, however often the roster re-attaches it", async () => {
    const { dial, calls } = spyDial({ maxMessageBytes: null });
    const attempted = new Set<string>();
    const first = await learnSmtpMaxSize({
      mailboxId: "mb-7", announced: null, smtp: PASSWORD_SMTP, attempted, dial,
    });
    const second = await learnSmtpMaxSize({
      mailboxId: "mb-7", announced: null, smtp: PASSWORD_SMTP, attempted, dial,
    });
    expect(first).toEqual({ outcome: "silent" });
    expect(second).toEqual({ outcome: "skipped", reason: "already_attempted" });
    expect(calls).toHaveLength(1);
  });

  it("the once-per-process guard is marked even when the dial FAILS", async () => {
    const { dial, calls } = spyDial(new Error("connection refused"));
    const attempted = new Set<string>();
    await learnSmtpMaxSize({ mailboxId: "mb-8", announced: null, smtp: PASSWORD_SMTP, attempted, dial });
    const second = await learnSmtpMaxSize({ mailboxId: "mb-8", announced: null, smtp: PASSWORD_SMTP, attempted, dial });
    expect(second).toEqual({ outcome: "skipped", reason: "already_attempted" });
    expect(calls).toHaveLength(1);
  });

  it("a non-positive or non-finite announcement is silence, not a ceiling of nothing", async () => {
    // RFC 1870 §6: `SIZE 0` means "no fixed maximum". `verifySmtpLogin` already collapses that to
    // null; this pins the second line of defence, because a 0 written to the column would become a
    // ceiling no message can clear.
    for (const bogus of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { dial } = spyDial({ maxMessageBytes: bogus });
      const res = await learnSmtpMaxSize({
        mailboxId: `mb-9-${bogus}`, announced: null, smtp: PASSWORD_SMTP, attempted: new Set(), dial,
      });
      expect(res, `announcement ${bogus}`).toEqual({ outcome: "silent" });
    }
  });
});
