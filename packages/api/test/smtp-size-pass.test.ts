import { describe, expect, it } from "vitest";
import { mailboxes, mailboxCredentials } from "@trafficflow/db";
import { and, eq } from "drizzle-orm";
import { apiRoutes, SMTP_SIZE_CRON_PATH, type ApiDeps } from "@trafficflow/api";
import { localRoutes } from "@trafficflow/api/local";
import type { SmtpSizeDial } from "@trafficflow/core/adapters/imap";
import {
  learnMissingSmtpSizes, SMTP_SIZE_BATCH,
  SMTP_SIZE_RETRY_FAILED_MS, SMTP_SIZE_RETRY_SILENT_MS,
} from "../src/smtp-size.js";
import { makeDeps, seedSession, FIXED_NOW } from "./helpers.js";

/**
 * ══ THE SCHEDULED PASS THAT LEARNS WHAT AN EXISTING MAILBOX'S SERVER ACCEPTS ══════════════════
 *
 * `mailboxes.smtp_max_size_bytes` is the only ceiling left on an attachment once the bytes go to
 * storage instead of into the send request, and nothing ever learned it for a mailbox that was
 * already connected — the column is written on create and on a PATCH that re-dials SMTP, which
 * means the person re-entering their password.
 *
 * The decision itself (dial or not, record or not) is `learnSmtpMaxSize`'s and is pinned in
 * `packages/core`. What THIS file pins is the part that is specific to this host: which rows a pass
 * selects, that the coordinates handed to the dial are the ones the SEND would use, that the write
 * is conditional, and that one mailbox's failure is not the pass's.
 *
 * ── WHY THE PASS IS HERE AT ALL, WHICH IS MEASURED ──────────────────────────────────────────
 *
 * The sync worker is the obvious home and cannot do it: its platform blocks outbound submission
 * ports. Measured 2026-08-22 on the hosted service — twelve distinct submission hosts, every one
 * answering "Connection timeout", with the IMAP dial to the same host on 993 completing in about
 * 300 ms in the very next log line. This host's egress demonstrably reaches SMTP, because every
 * send and every connect-time probe already goes out from here.
 */

type DialCall = {
  host: string; port: number; secure: boolean; user: string;
  /** The password presented, or `undefined` for a bearer-token dial. */
  pass?: string;
  /** The access token presented, or `undefined` for a password dial. */
  accessToken?: string;
};
type Dial = SmtpSizeDial & { calls: DialCall[] };

function spyDial(answer: number | null | Error): Dial {
  const calls: Dial["calls"] = [];
  const fn = (async (smtp) => {
    // The SEAT is recorded, not just the value: these assertions are about whether a secret arrives
    // as a password or as a bearer, and a spy that flattens the two cannot tell them apart.
    calls.push({
      host: smtp.host, port: smtp.port, secure: smtp.secure, user: smtp.auth.user,
      ...("pass" in smtp.auth ? { pass: smtp.auth.pass } : { accessToken: smtp.auth.accessToken }),
    });
    if (answer instanceof Error) throw answer;
    return { maxMessageBytes: answer };
  }) as Dial;
  fn.calls = calls;
  return fn;
}

/**
 * The host's token source, faked — the seam `makeSendAdapter` binds for a send and this pass binds
 * for a probe. It records the REFRESH TOKEN it was handed, which is how the assertions below prove
 * the stored secret went to the token endpoint rather than to somebody's AUTH command.
 */
function fakeOAuth(token: string | Error = "an-access-token"): {
  provider: NonNullable<ApiDeps["oauth"]>;
  refreshTokens: string[];
  mailboxIds: string[];
} {
  const refreshTokens: string[] = [];
  const mailboxIds: string[] = [];
  return {
    refreshTokens,
    mailboxIds,
    provider: {
      forMailbox: (mailboxId: string) => {
        mailboxIds.push(mailboxId);
        return ({ refreshToken }) => async (): Promise<string> => {
          refreshTokens.push(refreshToken);
          if (token instanceof Error) throw token;
          return token;
        };
      },
    },
  };
}

/** The mailbox's attempt stamp (mail 0063), as the next pass's selection will read it. */
const probeStamp = async (
  db: Awaited<ReturnType<typeof makeDeps>>["db"], id: string,
): Promise<{ at: Date | null; code: string | null }> => {
  const [row] = await db.select({
    at: mailboxes.smtpSizeProbedAt, code: mailboxes.smtpSizeProbeCode,
  }).from(mailboxes).where(eq(mailboxes.id, id)).limit(1);
  return { at: row?.at ?? null, code: row?.code ?? null };
};

/** A mailbox with imap + smtp credential rows, encrypted by the harness's own key provider. */
async function seedMailbox(
  db: Awaited<ReturnType<typeof makeDeps>>["db"],
  deps: ApiDeps,
  accountId: string,
  opts: {
    announced?: number | null;
    status?: string;
    smtp?: { host: string; port: number; secure: boolean; user: string } | null;
    oauth?: boolean;
    /** A raw `authType` for the imap credential meta — for the fail-closed cases. */
    authType?: string | null;
    /** The oauth row's `meta.smtp` submission block, when the default is not what is under test. */
    oauthSmtp?: { host: string; port: number; secure: boolean };
    /** Give both credential rows the SAME `updated_at`, as the env bootstrap does. */
    sameStamp?: boolean;
    address?: string;
    /** Mail 0063's attempt stamp, as a previous pass would have left it. */
    probedAt?: Date;
    probeCode?: string;
  } = {},
): Promise<string> {
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: opts.oauth ? "microsoft" : "imap",
    address: opts.address ?? `x${Math.random().toString(36).slice(2, 8)}@example.net`,
    status: opts.status ?? "connected",
    smtpMaxSizeBytes: opts.announced ?? null,
    ...(opts.probedAt ? { smtpSizeProbedAt: opts.probedAt } : {}),
    ...(opts.probeCode ? { smtpSizeProbeCode: opts.probeCode } : {}),
  }).returning();
  const id = mb!.id;
  const imapSecret = await deps.keyProvider.encrypt(opts.oauth ? "a-refresh-token" : "incoming-login-password");
  await db.insert(mailboxCredentials).values({
    mailboxId: id, transport: "imap",
    secretEnc: imapSecret.ciphertext, keyVersion: imapSecret.keyVersion,
    meta: opts.oauth
      ? {
          host: "outlook.office365.com", port: 993, secure: true, user: "o@example.com",
          authType: "oauth2", provider: "microsoft", tenant: "common",
          ...(opts.oauthSmtp ? { smtp: opts.oauthSmtp } : {}),
        }
      : {
          host: "imap.example.net", port: 993, secure: true, user: "u@example.net",
          ...(opts.authType === undefined ? {} : { authType: opts.authType }),
        },
    updatedAt: FIXED_NOW,
  });
  if (opts.smtp !== null && !opts.oauth) {
    const smtp = opts.smtp ?? { host: "smtp.example.net", port: 587, secure: false, user: "u@example.net" };
    const enc = await deps.keyProvider.encrypt("outgoing-login-password");
    await db.insert(mailboxCredentials).values({
      mailboxId: id, transport: "smtp",
      secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
      meta: smtp, updatedAt: opts.sameStamp ? FIXED_NOW : new Date(FIXED_NOW.getTime() + 1000),
    });
  }
  return id;
}

async function armed() {
  const { db, deps } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
  return { db, deps: deps as ApiDeps, accountId: s.accountId };
}

const announced = async (
  db: Awaited<ReturnType<typeof makeDeps>>["db"], id: string,
): Promise<number | null> => {
  const [row] = await db.select({ v: mailboxes.smtpMaxSizeBytes }).from(mailboxes)
    .where(eq(mailboxes.id, id)).limit(1);
  return row?.v ?? null;
};

describe("the back-fill's clock is mounted, and only on the hosted table", () => {
  it("is on `apiRoutes` and NOT on `localRoutes`", () => {
    const key = (r: { method: string; pattern: string }): string => `${r.method} ${r.pattern}`;
    expect(apiRoutes.map(key)).toContain(`GET ${SMTP_SIZE_CRON_PATH}`);
    // A standalone install probes its own server on connect and has no scheduler to run this
    // from; mounting it there would be an unauthenticated path into somebody's own machine.
    expect(localRoutes.map(key)).not.toContain(`GET ${SMTP_SIZE_CRON_PATH}`);
  });
});

describe("learnMissingSmtpSizes — which rows, which coordinates, and what gets written", () => {
  it("records what the server announced, on the coordinates the SEND would use", async () => {
    const { db, deps, accountId } = await armed();
    const id = await seedMailbox(db, deps, accountId);
    const dial = spyDial(52_428_800);

    const res = await learnMissingSmtpSizes(deps, { dial });

    expect(res).toMatchObject({ considered: 1, learned: 1, silent: 0, skipped: 0, failed: 0 });
    expect(await announced(db, id)).toBe(52_428_800);
    // The dedicated smtp row's host/port/secure and ITS OWN secret — not the imap ones. A probe
    // that dialled a different endpoint from the send would record an announcement about the
    // wrong server.
    expect(dial.calls).toEqual([{
      host: "smtp.example.net", port: 587, secure: false, user: "u@example.net", pass: "outgoing-login-password",
    }]);
  });

  it("falls back to the IMAP host and secret when there is no smtp row — the shared-credential convention", async () => {
    const { db, deps, accountId } = await armed();
    await seedMailbox(db, deps, accountId, { smtp: null });
    const dial = spyDial(20 * 1024 * 1024);

    await learnMissingSmtpSizes(deps, { dial });

    expect(dial.calls).toEqual([{
      host: "imap.example.net", port: 587, secure: false, user: "u@example.net", pass: "incoming-login-password",
    }]);
  });

  /**
   * ══ AN OAUTH MAILBOX IS PROBED, WITH THE TOKEN THE SEND WOULD USE ══════════════════════════
   *
   * This pair of cases used to assert that an oauth mailbox was NOT EVEN SELECTED, and the SQL
   * carried a `NOT EXISTS` to keep it out. The reasoning was sound given the rule of the day — the
   * rule declined an oauth transport because the stored secret is a REFRESH TOKEN and there was no
   * password to present, so selecting such a row only ever spent a batch slot — and the consequence
   * was that an oauth mailbox could never learn its ceiling from ANY host: it stayed pinned to the
   * strict product constant however generous its provider was.
   *
   * Now the rule mints an access token through the host's own token provider and dials XOAUTH2, so
   * the exclusion is gone and this asserts the thing that replaced it. Note WHICH secret goes
   * where: the encrypted secret on the imap credential row reaches the TOKEN PROVIDER (as a refresh
   * token), and only the minted access token reaches the dial — in the bearer seat.
   *
   * Mutation: pass the empty string as the secret to `buildImapAuth` (which is what this resolution
   * did while oauth was un-dialled) and the refresh-token assertion goes red.
   */
  it("SELECTS an oauth mailbox and dials it with a bearer token from the host's token source", async () => {
    const { db, deps, accountId } = await armed();
    const id = await seedMailbox(db, deps, accountId, { oauth: true });
    const oauth = fakeOAuth("EwBQA-minted");
    const dial = spyDial(150 * 1024 * 1024);

    const res = await learnMissingSmtpSizes({ ...deps, oauth: oauth.provider }, { dial });

    expect(res).toMatchObject({ considered: 1, learned: 1, skipped: 0, failed: 0 });
    expect(await announced(db, id)).toBe(150 * 1024 * 1024);
    // The submission endpoint from `meta.smtp`, and the ACCESS token — no `pass` in the call at all.
    expect(dial.calls).toEqual([{
      host: "smtp.office365.com", port: 587, secure: false,
      user: "o@example.com", accessToken: "EwBQA-minted",
    }]);
    // The stored secret went to the TOKEN ENDPOINT, decrypted, as a refresh token — which is the
    // half that was missing while this path was dead code.
    expect(oauth.refreshTokens).toEqual(["a-refresh-token"]);
    expect(oauth.mailboxIds).toEqual([id]);
  });

  it("honours the submission endpoint the oauth credential names, not only the default", async () => {
    const { db, deps, accountId } = await armed();
    await seedMailbox(db, deps, accountId, {
      oauth: true, oauthSmtp: { host: "smtp-legacy.example.com", port: 2587, secure: true },
    });
    const dial = spyDial(1024);

    await learnMissingSmtpSizes({ ...deps, oauth: fakeOAuth().provider }, { dial });

    expect(dial.calls).toMatchObject([{ host: "smtp-legacy.example.com", port: 2587, secure: true }]);
  });

  /**
   * ══ THE PROBE'S OWN TOKEN REFRESH IS NOT SOMEBODY ELSE'S ROTATION ══════════════════════════
   *
   * MEASURED LIVE, and it is the sharpest interaction in this slice. The write is guarded on the
   * credential row as it stood before the dial, so that an announcement learned from one server is
   * never stored against credentials that now point at another. For an OAUTH mailbox the dial
   * itself rewrites that row: Microsoft returns a ROTATED refresh token, the token provider
   * persists it (`rotateMailboxOAuthSecret` — `secret_enc`, `key_version`, `updated_at`, nothing
   * else), and an `updated_at` guard then reads the probe's own side effect as a concurrent
   * rotation and throws the measurement away. The first production pass reported `learned: 1` with
   * the row still NULL and UNSTAMPED — the very defect the slice exists to end, reintroduced by the
   * guard that protects it, and it would have repeated every single day.
   *
   * So an oauth row is guarded on `meta` instead: the endpoint and the identity, which are what an
   * announcement is ABOUT, and which a token rotation does not touch.
   *
   * Mutation: guard the oauth branch on `updated_at` again and this case goes red with a NULL
   * ceiling, while the case below it — the one that proves the guard still bites — stays green.
   */
  it("records the ceiling even though the token refresh ROTATED the credential row mid-dial", async () => {
    const { db, deps, accountId } = await armed();
    const id = await seedMailbox(db, deps, accountId, { oauth: true });
    const oauth = fakeOAuth("EwBQA-minted");
    // The rotation, exactly as the token provider performs it: the secret and the stamp move, the
    // meta does not.
    const dial: SmtpSizeDial = async () => {
      await db.update(mailboxCredentials)
        .set({ secretEnc: "rotated-ciphertext", updatedAt: new Date(FIXED_NOW.getTime() + 60_000) })
        .where(and(eq(mailboxCredentials.mailboxId, id), eq(mailboxCredentials.transport, "imap")));
      return { maxMessageBytes: 150 * 1024 * 1024 };
    };

    const res = await learnMissingSmtpSizes({ ...deps, oauth: oauth.provider }, { dial });

    expect(res).toMatchObject({ considered: 1, learned: 1, stamped: 1 });
    expect(await announced(db, id)).toBe(150 * 1024 * 1024);
    expect(await probeStamp(db, id)).toMatchObject({ code: "learned" });
  });

  it("…and STILL refuses the write when the oauth credential's META changes mid-dial", async () => {
    // The other half, so the case above cannot be read as "the oauth branch has no guard". A
    // reconnect that lands on a different submission endpoint rewrites `meta`, and then the
    // announcement is about a server this mailbox no longer sends through.
    const { db, deps, accountId } = await armed();
    const id = await seedMailbox(db, deps, accountId, { oauth: true });
    const dial: SmtpSizeDial = async () => {
      await db.update(mailboxCredentials)
        .set({
          meta: {
            host: "outlook.office365.com", port: 993, secure: true, user: "someone-else@example.com",
            authType: "oauth2", provider: "microsoft", tenant: "common",
          },
        })
        .where(and(eq(mailboxCredentials.mailboxId, id), eq(mailboxCredentials.transport, "imap")));
      return { maxMessageBytes: 150 * 1024 * 1024 };
    };

    const res = await learnMissingSmtpSizes({ ...deps, oauth: fakeOAuth().provider }, { dial });

    expect(res).toMatchObject({ considered: 1, learned: 1, stamped: 0 });
    expect(await announced(db, id)).toBeNull();
    expect(await probeStamp(db, id)).toEqual({ at: null, code: null });
  });

  it("an oauth mailbox whose TOKEN cannot be minted is unlearned with a closed code", async () => {
    const { db, deps, accountId } = await armed();
    const id = await seedMailbox(db, deps, accountId, { oauth: true });
    const dial = spyDial(1);

    const res = await learnMissingSmtpSizes(
      { ...deps, oauth: fakeOAuth(new Error("AADSTS700082 expired for o@example.com")).provider },
      { dial },
    );

    // Reported, never thrown, and nothing dialled: there was no credential to present.
    expect(res).toMatchObject({ considered: 1, learned: 0, failed: 1 });
    expect(dial.calls).toHaveLength(0);
    expect(await announced(db, id)).toBeNull();
    // And the row REMEMBERS it, with our own code rather than the token endpoint's sentence.
    expect(await probeStamp(db, id)).toMatchObject({ code: "token_unavailable" });
  });

  it("does NOT stamp a token failure when the credential was rotated by SOMEBODY ELSE", async () => {
    // `token_unavailable` is the one outcome that is a statement about the CREDENTIAL, and a
    // concurrent refresh — the sync host, or a send — is a plausible cause of it: a rotated refresh
    // token invalidates the one this pass already read. Backing the mailbox off for a week on that
    // basis is backing it off over a token that has since been replaced.
    //
    // Mutation: drop the `secret_enc` conjunct and this goes red with a `token_unavailable` stamp,
    // while the case below (the probe's OWN rotation, which must still stamp) stays green.
    const { db, deps, accountId } = await armed();
    const id = await seedMailbox(db, deps, accountId, { oauth: true });
    const oauth: NonNullable<ApiDeps["oauth"]> = {
      forMailbox: () => () => async (): Promise<string> => {
        // Somebody else rotates the secret, and THEN our (now superseded) token fetch fails.
        await db.update(mailboxCredentials)
          .set({ secretEnc: "somebody-elses-ciphertext", updatedAt: new Date(FIXED_NOW.getTime() + 30_000) })
          .where(and(eq(mailboxCredentials.mailboxId, id), eq(mailboxCredentials.transport, "imap")));
        throw new Error("invalid_grant: the refresh token was superseded");
      },
    };

    const res = await learnMissingSmtpSizes({ ...deps, oauth }, { dial: spyDial(1) });

    expect(res).toMatchObject({ considered: 1, failed: 1, stamped: 0 });
    expect(await probeStamp(db, id)).toEqual({ at: null, code: null });
  });

  it("…and a KEK REWRAP is not a credential change — the stamp still lands", async () => {
    // The rewrap re-encrypts the SAME refresh token under a new key version and deliberately leaves
    // `updated_at` alone (its own compare-and-swap is on the ciphertext, which is why it must be).
    // Keying the token-failure conjunct on the ciphertext would read that as a credential change and
    // drop the stamp, costing a probe slot for something that changed no credential at all.
    //
    // Mutation: key the conjunct on `secret_enc` and this goes red with an unstamped row, while the
    // concurrent-rotation case above stays green — the two together are what pin `updated_at` as
    // the right column.
    const { db, deps, accountId } = await armed();
    const id = await seedMailbox(db, deps, accountId, { oauth: true });
    const oauth: NonNullable<ApiDeps["oauth"]> = {
      forMailbox: () => () => async (): Promise<string> => {
        await db.update(mailboxCredentials)
          .set({ secretEnc: "same-token-new-envelope", keyVersion: 2 })
          .where(and(eq(mailboxCredentials.mailboxId, id), eq(mailboxCredentials.transport, "imap")));
        throw new Error("invalid_grant");
      },
    };

    const res = await learnMissingSmtpSizes({ ...deps, oauth }, { dial: spyDial(1) });

    expect(res).toMatchObject({ considered: 1, failed: 1, stamped: 1 });
    expect(await probeStamp(db, id)).toMatchObject({ code: "token_unavailable" });
  });

  it("…but DOES stamp a token failure when the credential is still the one it tried", async () => {
    // The other half: an ordinary dead grant, nothing else touching the row. That is a real reason
    // to wait a week, and refusing to stamp it would be the daily-forever defect for every mailbox
    // whose consent has lapsed.
    const { db, deps, accountId } = await armed();
    const id = await seedMailbox(db, deps, accountId, { oauth: true });

    const res = await learnMissingSmtpSizes(
      { ...deps, oauth: fakeOAuth(new Error("invalid_grant")).provider },
      { dial: spyDial(1) },
    );

    expect(res).toMatchObject({ considered: 1, failed: 1, stamped: 1 });
    expect(await probeStamp(db, id)).toMatchObject({ code: "token_unavailable" });
  });

  it("an oauth mailbox on a deployment with NO token source is refused, not password-dialled", async () => {
    // `deps.oauth` absent means this host does not do oauth; `buildImapAuth` throws rather than
    // falling through to the password branch, where the refresh token would be the password. The
    // pass reads that as an unreadable credential — one mailbox unprobed, no dial, no prose logged.
    const { db, deps, accountId } = await armed();
    const id = await seedMailbox(db, deps, accountId, { oauth: true });
    const dial = spyDial(1);

    const res = await learnMissingSmtpSizes(deps, { dial });

    expect(dial.calls).toHaveLength(0);
    expect(res).toMatchObject({ considered: 1, learned: 0, skipped: 1 });
    expect(await announced(db, id)).toBeNull();
    expect(await probeStamp(db, id)).toMatchObject({ code: "no_credentials" });
  });

  /**
   * ══ AN UNKNOWN `authType` IS NOT A PASSWORD ROW ════════════════════════════════════════════
   *
   * The resolution used to read `authType === "oauth2" ? oauth : password`, which puts every OTHER
   * value — a future scheme, a corrupt row, a typo — into the password branch, where the stored
   * secret is decrypted and presented to a third party's AUTH command. For an oauth-shaped row that
   * secret is a REFRESH TOKEN. `buildImapAuth` throws on an unknown type for exactly this reason.
   *
   * Mutation: restore the ternary (`authType === "oauth2" ? … : password`) and this case dials,
   * with the refresh token in the password seat, which is the assertion below.
   */
  it("REFUSES an authType it does not recognise rather than sending the secret as a password", async () => {
    const { db, deps, accountId } = await armed();
    const id = await seedMailbox(db, deps, accountId, { authType: "oauth3-future" });
    const dial = spyDial(1);

    const res = await learnMissingSmtpSizes(deps, { dial });

    expect(dial.calls).toHaveLength(0);
    expect(res).toMatchObject({ considered: 1, learned: 0, skipped: 1 });
    expect(await announced(db, id)).toBeNull();
  });

  /**
   * `null` IS NOT "ABSENT". The first fix read `!== undefined && !== null && !== "password"`, which
   * reads as "absent in either spelling" and is wrong: an untyped row and a row storing JSON `null`
   * are different claims, and an oauth-shaped row whose `authType` came back `null` would have had
   * its refresh token decrypted and presented as an SMTP password — the leak the branch exists to
   * close, surviving the fix for it.
   *
   * Mutation: re-admit `null` and this case dials.
   */
  it("treats an explicit null authType as UNKNOWN, not as absent", async () => {
    const { db, deps, accountId } = await armed();
    const id = await seedMailbox(db, deps, accountId, { authType: null });
    const dial = spyDial(1);

    const res = await learnMissingSmtpSizes(deps, { dial });

    expect(dial.calls).toHaveLength(0);
    expect(res).toMatchObject({ considered: 1, learned: 0, skipped: 1 });
    expect(await announced(db, id)).toBeNull();
  });

  it("dials a row that says `password` explicitly, exactly as one that says nothing", async () => {
    const { db, deps, accountId } = await armed();
    const id = await seedMailbox(db, deps, accountId, { authType: "password" });

    const res = await learnMissingSmtpSizes(deps, { dial: spyDial(25 * 1024 * 1024) });

    expect(res).toMatchObject({ considered: 1, learned: 1 });
    expect(await announced(db, id)).toBe(25 * 1024 * 1024);
  });

  it("leaves a mailbox that already announced something alone — no dial, no write", async () => {
    const { db, deps, accountId } = await armed();
    const id = await seedMailbox(db, deps, accountId, { announced: 35_882_577 });
    const dial = spyDial(1);

    const res = await learnMissingSmtpSizes(deps, { dial });

    expect(res.considered).toBe(0);
    expect(dial.calls).toHaveLength(0);
    expect(await announced(db, id)).toBe(35_882_577);
  });

  it("SKIPS a disabled mailbox — its ceiling answers no question anybody is asking", async () => {
    const { db, deps, accountId } = await armed();
    const id = await seedMailbox(db, deps, accountId, { status: "disabled" });
    const dial = spyDial(1);

    const res = await learnMissingSmtpSizes(deps, { dial });

    expect(res.considered).toBe(0);
    expect(dial.calls).toHaveLength(0);
    expect(await announced(db, id)).toBeNull();
  });

  it("a server that announces nothing writes nothing — the strict fallback stands", async () => {
    const { db, deps, accountId } = await armed();
    const id = await seedMailbox(db, deps, accountId);

    const res = await learnMissingSmtpSizes(deps, { dial: spyDial(null) });

    expect(res).toMatchObject({ considered: 1, learned: 0, silent: 1 });
    expect(await announced(db, id)).toBeNull();
  });

  /**
   * THE WRITE CARRIES ITS OWN `IS NULL`, AND THIS IS THE ONLY THING THAT PROVES IT.
   *
   * The row is selected because it announces nothing, and the dial that follows takes seconds
   * against somebody else's server. A PATCH that re-dials SMTP in that window is a MORE RECENT
   * measurement of the same server, by the ceremony that owns this column — made by a person who
   * just re-entered their password. An unconditional write would replace it with whatever this
   * older dial happens to learn, moving the ceiling backwards for exactly the person who acted.
   *
   * The race is driven from inside the injected dial, because that is where the window is.
   * Mutation: drop the `isNull` predicate from the update — this case goes red and no other does.
   */
  it("does NOT overwrite an announcement that landed WHILE the dial was in flight", async () => {
    const { db, deps, accountId } = await armed();
    const id = await seedMailbox(db, deps, accountId);
    const dial: SmtpSizeDial = async () => {
      // The concurrent PATCH: a fresh, larger measurement committed mid-dial.
      await db.update(mailboxes).set({ smtpMaxSizeBytes: 52_428_800 })
        .where(eq(mailboxes.id, id));
      return { maxMessageBytes: 10 * 1024 * 1024 };
    };

    const res = await learnMissingSmtpSizes(deps, { dial });

    // The pass still reports what IT learned — it did learn something, and saying otherwise would
    // hide a dial that happened. What must not have changed is the row.
    expect(res).toMatchObject({ considered: 1, learned: 1 });
    expect(await announced(db, id)).toBe(52_428_800);
  });

  it("ONE mailbox's refusal is not the pass's — the rest are still probed", async () => {
    const { db, deps, accountId } = await armed();
    const bad = await seedMailbox(db, deps, accountId, { address: "a@example.net" });
    const good = await seedMailbox(db, deps, accountId, { address: "b@example.net" });
    // Fail the first dial, answer the second. Which row is "first" is the createdAt order the
    // pass imposes, so drive it off the call count rather than off the host.
    let n = 0;
    const dial: SmtpSizeDial = async () => {
      n += 1;
      if (n === 1) throw new Error("535 authentication failed");
      return { maxMessageBytes: 25 * 1024 * 1024 };
    };

    const res = await learnMissingSmtpSizes(deps, { dial });

    expect(res).toMatchObject({ considered: 2, learned: 1, failed: 1 });
    const values = [await announced(db, bad), await announced(db, good)];
    expect(values.filter((v) => v !== null)).toHaveLength(1);
  });

  /**
   * ══ THE WRITE IS TIED TO THE CREDENTIALS THAT WERE PROBED ══════════════════════════════════
   *
   * `IS NULL` alone is not enough, and the case that breaks it is specific: a PATCH that installs
   * NEW credentials whose server advertises no usable `SIZE` deliberately writes `null` here. The
   * row is therefore STILL NULL when this older in-flight probe returns, so an `IS NULL`-only
   * predicate stores the previous server's limit against the new credentials — a ceiling for a
   * server this mailbox no longer sends through.
   *
   * The credential row's `updated_at` as it stood before the dial closes it. Driven from inside the
   * injected dial, because mid-dial is the window. Mutation: drop the EXISTS clause and this case
   * goes red while the plain `IS NULL` case above stays green.
   */
  it("does NOT write when the CREDENTIALS were rotated while the dial was in flight", async () => {
    const { db, deps, accountId } = await armed();
    const id = await seedMailbox(db, deps, accountId);
    const dial: SmtpSizeDial = async () => {
      // The rotation: a new secret installed mid-dial, which moves the row's stamp. The new
      // server announces nothing, so `smtp_max_size_bytes` is left NULL by that path.
      await db.update(mailboxCredentials)
        .set({ updatedAt: new Date(Date.now() + 60_000) })
        .where(eq(mailboxCredentials.mailboxId, id));
      return { maxMessageBytes: 10 * 1024 * 1024 };
    };

    const res = await learnMissingSmtpSizes(deps, { dial });

    // The pass reports what it learned — it did dial and it did get an answer — and the row is
    // untouched, because that answer is about a server these credentials no longer reach.
    expect(res).toMatchObject({ considered: 1, learned: 1 });
    expect(await announced(db, id)).toBeNull();
    // AND IT IS LEFT UNSTAMPED, which is the half mail 0063 adds: the attempt is not remembered, so
    // the row is due again on the next pass rather than backed off for a week on the strength of a
    // measurement about credentials it no longer has. `stamped` is what says so — it is deliberately
    // not equal to `considered` for exactly this case.
    expect(res.stamped).toBe(0);
    expect(await probeStamp(db, id)).toEqual({ at: null, code: null });
  });

  /**
   * THE STAMP HAS TO NAME ITS TRANSPORT, and the case that proves it is the env bootstrap's:
   * it inserts the imap and smtp rows with ONE timestamp. A predicate that accepted either
   * transport at that value is satisfied by the untouched IMAP row after the SMTP row alone has
   * been rotated — so the guard passes in exactly the situation it exists to catch, and the old
   * server's limit is written against the new SMTP credentials.
   *
   * Mutation: widen the predicate back to `transport IN ('smtp','imap')` and this case goes red
   * while the whole-mailbox rotation case above stays green.
   */
  it("does not accept the OTHER transport's stamp when both rows share a timestamp", async () => {
    const { db, deps, accountId } = await armed();
    const id = await seedMailbox(db, deps, accountId, { sameStamp: true });
    const dial: SmtpSizeDial = async () => {
      // Only the SMTP row rotates — the imap row keeps the shared timestamp.
      await db.update(mailboxCredentials)
        .set({ updatedAt: new Date(FIXED_NOW.getTime() + 60_000) })
        .where(and(
          eq(mailboxCredentials.mailboxId, id),
          eq(mailboxCredentials.transport, "smtp"),
        ));
      return { maxMessageBytes: 10 * 1024 * 1024 };
    };

    const res = await learnMissingSmtpSizes(deps, { dial });

    expect(res).toMatchObject({ considered: 1, learned: 1 });
    expect(await announced(db, id)).toBeNull();
  });

  /* ══════════════════════════════════════════════════════════════════════════════════════════
     MAIL 0063 — THE DURABLE ATTEMPT STAMP, WHICH IS THE ONLY THING THAT BOUNDS THE SEQUENCE
     ══════════════════════════════════════════════════════════════════════════════════════════

     Before it, the selection was `smtp_max_size_bytes IS NULL` and nothing else, and three outcomes
     leave that column NULL without being failures of the pass: a server that advertises no `SIZE`,
     a login it refuses, a mailbox with nothing to dial. So those rows were re-selected on EVERY
     scheduled run — a real SMTP login against somebody else's infrastructure, once a day, for the
     life of the account — and because the pass takes a bounded batch, a batch's worth of them hid
     every learnable mailbox behind them for ever.

     The in-process `attempted` set cannot help: on this host the invocation IS the process.
     ══════════════════════════════════════════════════════════════════════════════════════════ */

  it("stamps a SILENT server, so the very next pass does not dial it again", async () => {
    // The regression, stated as an outcome rather than as a column: two consecutive passes, one
    // dial. Mutation: drop the due-filter from the selection and the second pass dials again —
    // which is the defect, once a day, for ever.
    const { db, deps, accountId } = await armed();
    const id = await seedMailbox(db, deps, accountId);

    const first = await learnMissingSmtpSizes(deps, { dial: spyDial(null) });
    expect(first).toMatchObject({ considered: 1, silent: 1, stamped: 1 });
    expect(await probeStamp(db, id)).toMatchObject({ code: "silent" });
    expect((await probeStamp(db, id)).at).toBeInstanceOf(Date);

    const second = spyDial(null);
    const again = await learnMissingSmtpSizes(deps, { dial: second });
    expect(again).toMatchObject({ considered: 0, stamped: 0 });
    expect(second.calls).toHaveLength(0);
  });

  it("…and asks again once the SILENT backoff has passed — it is a backoff, never a verdict", async () => {
    // Nothing here ever gives up. A provider that turns `SIZE` on next month is picked up next
    // month, which is why the stamp is a timestamp and not a flag.
    const { db, deps, accountId } = await armed();
    const stale = new Date(FIXED_NOW.getTime() - SMTP_SIZE_RETRY_SILENT_MS - 1000);
    const id = await seedMailbox(db, deps, accountId, { probedAt: stale, probeCode: "silent" });

    const res = await learnMissingSmtpSizes(deps, {
      dial: spyDial(35_882_577), now: () => FIXED_NOW,
    });

    expect(res).toMatchObject({ considered: 1, learned: 1, stamped: 1 });
    expect(await announced(db, id)).toBe(35_882_577);
    expect(await probeStamp(db, id)).toMatchObject({ code: "learned" });
  });

  it("a FAILURE waits a week, not a month — the two intervals are not the same", async () => {
    // A refusal is usually somebody's to fix and the fix does not write this column, so it converges
    // faster than a server's own configuration does. The pair of cases pins BOTH sides of the split:
    // at just over a week a failed row is due and a silent row is not.
    const { db, deps, accountId } = await armed();
    const weekOld = new Date(FIXED_NOW.getTime() - SMTP_SIZE_RETRY_FAILED_MS - 1000);
    const failed = await seedMailbox(db, deps, accountId, {
      address: "f@example.net", probedAt: weekOld, probeCode: "auth_refused",
    });
    const silent = await seedMailbox(db, deps, accountId, {
      address: "s@example.net", probedAt: weekOld, probeCode: "silent",
    });

    const res = await learnMissingSmtpSizes(deps, {
      dial: spyDial(9 * 1024 * 1024), now: () => FIXED_NOW,
    });

    expect(res).toMatchObject({ considered: 1, learned: 1 });
    expect(await announced(db, failed)).toBe(9 * 1024 * 1024);
    expect(await announced(db, silent)).toBeNull();
    // The silent row's stamp is untouched — it was not looked at, so nothing about it changed.
    expect((await probeStamp(db, silent)).at?.getTime()).toBe(weekOld.getTime());
  });

  it("a stamped row whose CODE is somehow NULL is still due — a backoff cannot become a verdict", async () => {
    // The `COALESCE` in the predicate. Without it, `code = 'silent'` and `code <> 'silent'` are both
    // NULL for such a row, so it satisfies neither arm and is never selected again — a terminal
    // state arrived at by accident, which is the one thing this design refuses to have.
    const { db, deps, accountId } = await armed();
    const stale = new Date(FIXED_NOW.getTime() - SMTP_SIZE_RETRY_FAILED_MS - 1000);
    const id = await seedMailbox(db, deps, accountId, { probedAt: stale });

    const res = await learnMissingSmtpSizes(deps, {
      dial: spyDial(4 * 1024 * 1024), now: () => FIXED_NOW,
    });

    expect(res).toMatchObject({ considered: 1, learned: 1 });
    expect(await announced(db, id)).toBe(4 * 1024 * 1024);
  });

  it("a row that CANNOT be learned no longer crowds out the rows that can", async () => {
    // The convergence property, stated as an outcome. A batch's worth of silent servers used to
    // occupy every slot of every pass for ever; now they are stamped on the first pass and the
    // learnable mailbox behind them is reached on the second.
    const { db, deps, accountId } = await armed();
    for (let i = 0; i < SMTP_SIZE_BATCH; i += 1) {
      await seedMailbox(db, deps, accountId, { address: `q${i}@example.net` });
    }

    // Pass one: the batch is full of servers that answer nothing, and every one of them is stamped.
    const first = await learnMissingSmtpSizes(deps, { dial: spyDial(null) });
    expect(first).toMatchObject({ considered: SMTP_SIZE_BATCH, silent: SMTP_SIZE_BATCH, stamped: SMTP_SIZE_BATCH });

    // The learnable mailbox arrives afterwards, behind a full batch of un-learnable rows.
    const learnable = await seedMailbox(db, deps, accountId, { address: "late@example.net" });
    const second = await learnMissingSmtpSizes(deps, { dial: spyDial(25 * 1024 * 1024) });

    expect(second).toMatchObject({ considered: 1, learned: 1 });
    expect(await announced(db, learnable)).toBe(25 * 1024 * 1024);
  });

  it("stamps a mailbox with NOTHING TO DIAL — the row that was re-selected most often of all", async () => {
    // No `imap` credential row at all: the resolution returns nothing, the rule skips, and before
    // that fix the row came back on every single pass for the life of the account.
    const { db, deps, accountId } = await armed();
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: "orphan@example.net", status: "connected",
    }).returning();
    const dial = spyDial(1);

    const res = await learnMissingSmtpSizes(deps, { dial });

    expect(res).toMatchObject({ considered: 1, skipped: 1, stamped: 1 });
    expect(dial.calls).toHaveLength(0);
    expect(await probeStamp(db, mb!.id)).toMatchObject({ code: "no_credentials" });
  });

  it("is BOUNDED — a pass never probes more than the batch, however many rows wait", async () => {
    const { db, deps, accountId } = await armed();
    for (let i = 0; i < SMTP_SIZE_BATCH + 3; i += 1) {
      await seedMailbox(db, deps, accountId, { address: `m${i}@example.net` });
    }
    const dial = spyDial(null);

    const res = await learnMissingSmtpSizes(deps, { dial });

    expect(res.considered).toBe(SMTP_SIZE_BATCH);
    expect(dial.calls).toHaveLength(SMTP_SIZE_BATCH);
  });

  it("STOPS at the deadline rather than being killed by the invocation ceiling", async () => {
    const { db, deps, accountId } = await armed();
    for (let i = 0; i < SMTP_SIZE_BATCH; i += 1) {
      await seedMailbox(db, deps, accountId, { address: `d${i}@example.net` });
    }
    // A clock that stands still long enough for one mailbox and then jumps past the deadline:
    // the check sits BETWEEN mailboxes, so the first is probed and the rest are refused. (A probe
    // already in flight has a timeout of its own; abandoning one would leak the socket.)
    let reads = 0;
    const now = (): Date => new Date(reads++ < 2 ? 0 : 10 * 60_000);
    const dial = spyDial(null);

    const res = await learnMissingSmtpSizes(deps, { dial, now });

    expect(res.considered).toBe(1);
    expect(dial.calls).toHaveLength(1);
  });
});
