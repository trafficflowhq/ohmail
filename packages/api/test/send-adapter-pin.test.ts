import { describe, expect, it } from "vitest";
import { accounts, mailboxes, mailboxCredentials } from "@trafficflow/db";
import {
  imapFlowOptions, smtpTransportOptions, type ImapConfig,
} from "@trafficflow/core/adapters/imap";
import { ServiceError, type HostResolver } from "@trafficflow/services/mail";
import { makeSendAdapter } from "../src/send-adapter.js";
import { makeImapProbe, makeProbeHostGuard, type ProbeDialer } from "../src/imap-probe.js";
import { makeDeps } from "./helpers.js";

/**
 * ═══ THE SEND DIALS THE ADDRESS IT CHECKED ════════════════════════════════════════════════
 *
 * The add-time probe resolves the hostname, clears its addresses and pins the dial to them. The
 * SEND path did neither: it read `meta.host` out of the credential row and handed the NAME to a
 * fresh `ImapAdapter`, which resolved it again — months after the one check that ever ran. A
 * name that answered a public address the day the mailbox was added and answers `169.254.169.254`
 * today was dialled at that address, with the user's mail password, by a service whose own SSRF
 * guard exists for exactly this.
 *
 * Check and dial are one act here now: the send path runs the SAME guard the probe runs, on both
 * legs, and hands the cleared addresses down as `ImapConfig.pin` / `ImapConfig.smtp.pin`. The
 * NAME stays where it was — SNI and certificate validation must still see what the user typed —
 * which is what the last case is about.
 *
 * The guard is a deployment POLICY: `ALLOW_ANY_PROBE_HOST` on a self-host install (a LAN mail
 * server is legitimate there and nothing resolves), the enforcing guard on Cloud. The last case
 * below is the self-host arm, and it is what keeps the refusal narrow.
 */

const IMAP_NAME = "imap.vanity.example";
const SMTP_NAME = "smtp.vanity.example";
const PUBLIC_IMAP = "93.184.216.34";
const PUBLIC_SMTP = "93.184.216.35";
const METADATA = "169.254.169.254";
const USER = "u@vanity.example";

type Deps = Awaited<ReturnType<typeof makeDeps>>;

/**
 * A resolver whose answer CHANGES — the rebinding server, and the only shape that can tell a
 * check-then-connect from one act. Each host gets a list of answers: every answer but the last is
 * used once, the last repeats for ever. `[[public], [metadata]]` is therefore "public to the
 * probe, the metadata address to everything after it".
 */
function scriptedResolver(script: Record<string, string[][]>): {
  resolver: HostResolver; asked: () => readonly string[];
} {
  const asked: string[] = [];
  const left: Record<string, string[][]> = {};
  for (const [h, answers] of Object.entries(script)) left[h] = answers.map((a) => [...a]);
  return {
    asked: () => asked,
    resolver: {
      async resolve(hostname: string): Promise<string[]> {
        asked.push(hostname);
        const answers = left[hostname];
        if (!answers) throw new Error(`the test scripted no answer for ${hostname}`);
        return answers.length > 1 ? answers.shift()! : answers[0]!;
      },
    },
  };
}

/** Wire the HOSTED policy onto a test's deps — what Cloud runs; absent means the self-host one. */
function hosted(d: Deps, resolver: HostResolver): void {
  (d.deps.services as unknown as { probeHostGuard: unknown }).probeHostGuard =
    makeProbeHostGuard(resolver);
}

async function seed(
  d: Deps, over: { imapHost?: string; smtpHost?: string | null; imapConsent?: boolean; smtpConsent?: boolean } = {},
): Promise<{ mailboxId: string; accountId: string; address: string }> {
  // `name`, not `email`: the accounts table has no email column, and typing one raises the
  // typecheck-test-dirs pin for this directory.
  const [acct] = await d.db.insert(accounts).values({ name: "send-dials" }).returning();
  const [mb] = await d.db.insert(mailboxes).values({
    accountId: acct!.id, provider: "imap", address: USER,
  }).returning();
  const imapSecret = await d.deps.keyProvider.encrypt("incoming-relay-password");
  await d.db.insert(mailboxCredentials).values({
    mailboxId: mb!.id, accountId: mb!.accountId, transport: "imap",
    secretEnc: imapSecret.ciphertext, keyVersion: imapSecret.keyVersion,
    // A consent is only ever stored on the no-TLS rung the probe proved, so it rides `secure: false`.
    meta: { host: over.imapHost ?? IMAP_NAME, ...(over.imapConsent ? { port: 143, secure: false, insecureConsent: true } : { port: 993, secure: true }), user: USER },
  });
  if (over.smtpHost !== null) {
    const enc = await d.deps.keyProvider.encrypt("outgoing-relay-password");
    await d.db.insert(mailboxCredentials).values({
      mailboxId: mb!.id, accountId: mb!.accountId, transport: "smtp",
      secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
      meta: { host: over.smtpHost ?? SMTP_NAME, port: 587, secure: false, user: USER, ...(over.smtpConsent ? { insecureConsent: true } : {}) },
    });
  }
  return { mailboxId: mb!.id, accountId: acct!.id, address: USER };
}

/** What the adapter was CONSTRUCTED with, and whether it was connected — `makeSendAdapter`'s seam. */
function recorder(): { built: ImapConfig[]; connects: () => number; newAdapter: never } {
  const built: ImapConfig[] = [];
  let connects = 0;
  return {
    built,
    connects: () => connects,
    newAdapter: ((cfg: ImapConfig) => {
      built.push(cfg);
      return {
        connect: async (): Promise<void> => { connects += 1; },
        close: async (): Promise<void> => undefined,
      };
    }) as never,
  };
}

/** Run the add-time probe over a mailbox — the check the send path has been trading on. */
async function probeOnce(d: Deps, seeded: { accountId: string; address: string }): Promise<string> {
  const probe = makeImapProbe(d.deps, {
    adapterFactory: () => ({
      connect: async (): Promise<void> => undefined,
      close: async (): Promise<void> => undefined,
    }) as ProbeDialer,
  });
  const verdict = await probe({
    accountId: seeded.accountId, address: seeded.address,
    imap: { host: IMAP_NAME, port: 993, secure: true, user: USER, pass: "user-entered-password" },
  });
  return verdict.verdict;
}

/** Call an assembled `tls.lookup` the way `net.connect` does, and report what the socket gets. It
 * awaits the callback, as `net` does: the pin answers after the call, never inside it. */
async function askLookup(options: Record<string, unknown>, hostname: string): Promise<string> {
  const lookup = (options.tls as { lookup?: unknown } | undefined)?.lookup;
  if (typeof lookup !== "function") throw new Error("no lookup on the assembled tls options");
  const [err, address] = await new Promise<[unknown, unknown]>((resolve) => {
    (lookup as (h: string, o: unknown, cb: (e: unknown, a: unknown) => void) => void)(
      hostname, {}, (e, a) => resolve([e, a]),
    );
  });
  expect(err, "the pinned lookup must never fail the connect").toBeNull();
  return address as string;
}

describe("makeSendAdapter — validation and connection are one act", () => {
  it("(1) REFUSES a host whose resolution changed between the probe and the send", async () => {
    /* The whole defect as a sequence: the probe cleared a public address and stored the mailbox;
       the name now answers the metadata address; the send dialled it anyway on the strength of a
       check that happened once. Mutating the send path's own `check` away restores exactly that. */
    const { resolver } = scriptedResolver({
      [IMAP_NAME]: [[PUBLIC_IMAP], [METADATA]],
      [SMTP_NAME]: [[PUBLIC_SMTP]],
    });
    const d = await makeDeps();
    hosted(d, resolver);
    const seeded = await seed(d);

    expect(await probeOnce(d, seeded), "the probe must pass, or this proves nothing").toBe("ok");

    const rec = recorder();
    await expect(makeSendAdapter(d.deps, seeded.mailboxId, {}, rec.newAdapter))
      .rejects.toThrow(/is not one this service will connect to/);
    // AND NOTHING WAS BUILT: a refusal after a transport exists is a refusal after a socket may.
    expect(rec.built, "a transport was constructed for a host the guard refused").toEqual([]);
    expect(rec.connects()).toBe(0);
  });

  it("(2) an unchanged host still sends, and the adapter carries BOTH legs' cleared addresses", async () => {
    /* The positive control. Without it (1) and (3) could pass because sending had been broken for
       everybody — and the pin is the half that makes the check worth anything, so the arm asserts
       the cleared addresses reached the config rather than merely that nothing threw. */
    const { resolver, asked } = scriptedResolver({
      [IMAP_NAME]: [[PUBLIC_IMAP]],
      [SMTP_NAME]: [[PUBLIC_SMTP]],
    });
    const d = await makeDeps();
    hosted(d, resolver);
    const seeded = await seed(d);
    const rec = recorder();

    await makeSendAdapter(d.deps, seeded.mailboxId, {}, rec.newAdapter);

    expect(rec.built).toHaveLength(1);
    expect(rec.connects()).toBe(1);
    const cfg = rec.built[0]!;
    // The NAME on both legs — only the pin decides the address.
    expect(cfg.host).toBe(IMAP_NAME);
    expect(cfg.smtp?.host).toBe(SMTP_NAME);
    expect(cfg.pin).toEqual([PUBLIC_IMAP]);
    expect(cfg.smtp?.pin).toEqual([PUBLIC_SMTP]);
    // Each leg is its own name and gets its own check: two resolutions, not one shared verdict.
    expect([...asked()].sort()).toEqual([IMAP_NAME, SMTP_NAME]);
  });

  it("(3) REFUSES a name that resolves to a private range at connect time — the IMAP leg", async () => {
    const { resolver } = scriptedResolver({
      [IMAP_NAME]: [[METADATA]],
      [SMTP_NAME]: [[PUBLIC_SMTP]],
    });
    const d = await makeDeps();
    hosted(d, resolver);
    const seeded = await seed(d);
    const rec = recorder();

    await expect(makeSendAdapter(d.deps, seeded.mailboxId, {}, rec.newAdapter))
      .rejects.toThrow(/is not one this service will connect to/);
    expect(rec.built).toEqual([]);
  });

  it("(3b) and the SUBMISSION leg, which dials its own server and takes its own check", async () => {
    /* Both halves dial, so both halves take the pin — a fix that only covered the IMAP leg would
       leave the send itself going out through an address nothing checked. */
    const { resolver } = scriptedResolver({
      [IMAP_NAME]: [[PUBLIC_IMAP]],
      [SMTP_NAME]: [[METADATA]],
    });
    const d = await makeDeps();
    hosted(d, resolver);
    const seeded = await seed(d);
    const rec = recorder();

    await expect(makeSendAdapter(d.deps, seeded.mailboxId, {}, rec.newAdapter))
      .rejects.toThrow(/is not one this service will connect to/);
    expect(rec.built).toEqual([]);
  });

  it("(4) the pin moves the ADDRESS and nothing else: SNI and the certificate still see the name", async () => {
    /* The arm that fails if the pin dropped SNI. Certificate validation against an IP is a worse
       hole than the one the pin closes — a multi-vhost server presents its default certificate to
       a dial with no SNI, which is indistinguishable from a wrong certificate. Both legs, because
       the two libraries read the pin differently: imapflow takes a `lookup` inside `tls`,
       nodemailer resolves the name itself so its pin has to be the dial host. */
    const { resolver } = scriptedResolver({
      [IMAP_NAME]: [[PUBLIC_IMAP]],
      [SMTP_NAME]: [[PUBLIC_SMTP]],
    });
    const d = await makeDeps();
    hosted(d, resolver);
    const seeded = await seed(d);
    const rec = recorder();
    await makeSendAdapter(d.deps, seeded.mailboxId, {}, rec.newAdapter);

    const cfg = rec.built[0]! as Parameters<typeof imapFlowOptions>[0];
    const imap = imapFlowOptions(cfg) as unknown as Record<string, unknown>;
    /* SNI FIRST, and the order is the point: `servername` is derived from `host`, and RFC 6066 §3
       forbids an IP literal there — so a config that dialled the address instead of the name
       produces NO servername at all, a multi-vhost server answers with its default certificate,
       and hostname validation fails in a way indistinguishable from a wrong certificate. Asserting
       `host` first would hide that behind a failure about the host. */
    expect(imap.servername, "SNI must be the name, never the address").toBe(IMAP_NAME);
    expect(imap.host, "the IMAP dial must keep the name").toBe(IMAP_NAME);
    expect((imap.tls as Record<string, unknown>).rejectUnauthorized).toBe(true);
    // ...and the socket still goes to the checked address: this is the lookup `net.connect` calls.
    expect(await askLookup(imap, IMAP_NAME)).toBe(PUBLIC_IMAP);

    const smtp = smtpTransportOptions(cfg as ImapConfig) as unknown as Record<string, unknown>;
    expect(smtp.host, "nodemailer dials the cleared address").toBe(PUBLIC_SMTP);
    expect(smtp.servername, "SNI must be the name, never the address").toBe(SMTP_NAME);
    expect((smtp.tls as Record<string, unknown>).rejectUnauthorized).toBe(true);
  });

  it("(5) a SELF-HOST install is untouched: no resolution, no pin, dial by name", async () => {
    /* The policy's other half, and what keeps the refusal narrow. A desktop user's mail server may
       sit on a LAN address behind an mDNS name the OS resolver is the only thing that knows; the
       self-host guard clears nothing, so there is nothing to pin and the dial is by name exactly
       as it has always been. No `probeHostGuard` on the deps IS that policy. */
    const d = await makeDeps();
    const seeded = await seed(d, { imapHost: "mail.lan", smtpHost: "mail.lan" });
    const rec = recorder();

    await makeSendAdapter(d.deps, seeded.mailboxId, {}, rec.newAdapter);

    expect(rec.built).toHaveLength(1);
    expect(rec.built[0]!.pin).toBeUndefined();
    expect(rec.built[0]!.smtp?.pin).toBeUndefined();
    expect(rec.built[0]!.host).toBe("mail.lan");
  });

  it("(5c) a send dials the submission server on ITS row's plaintext consent, never the IMAP row's", async () => {
    // R23-02: the consent the SMTP probe earned travels to the send; the IMAP one does not. The
    // name still resolves to the person's own network, which a consented dial is re-asked at.
    const d = await makeDeps();
    (d.deps.services as unknown as { probeScopeResolver: HostResolver }).probeScopeResolver =
      { resolve: async () => ["192.168.1.20"] };
    const smtpConsent = await seed(d, { imapHost: "mail.lan", smtpHost: "mail.lan", smtpConsent: true });
    const imapConsent = await seed(d, { imapHost: "mail.lan", smtpHost: "mail.lan", imapConsent: true });
    const noRow = await seed(d, { imapHost: "mail.lan", smtpHost: null, imapConsent: true });
    const rec = recorder();

    for (const m of [smtpConsent, imapConsent, noRow]) {
      await makeSendAdapter(d.deps, m.mailboxId, {}, rec.newAdapter);
    }
    expect(rec.built.map((c) => [c.allowInsecure === true, c.smtp?.allowInsecure === true]))
      .toEqual([[false, true], [true, false], [true, false]]);
  });

  it("(5b) a RESOLVER that is down defers the send rather than deciding against the mailbox", async () => {
    /* The class is the decision. `SendService.resolveStale` reads a `ServiceError` from this
       factory as "this mailbox can never be dialled again" and settles a stranded send terminally
       `unverified`; before the guard existed a DNS failure arrived from the socket as an ordinary
       dial error and the row was simply deferred. A minute of broken DNS must not be promoted into
       a verdict about somebody's mailbox, so this arm drives a THROWING resolver end to end and
       reads the class — which also pins the core gate's refusal wording the classifier matches on. */
    const d = await makeDeps();
    hosted(d, { async resolve(): Promise<string[]> { throw new Error("EAI_AGAIN"); } });
    const seeded = await seed(d);
    const rec = recorder();

    const err = await makeSendAdapter(d.deps, seeded.mailboxId, {}, rec.newAdapter)
      .then(() => null, (e: unknown) => e);
    expect(err, "the dial must still be refused").toBeInstanceOf(Error);
    expect(err, "a resolver outage is not a verdict about the mailbox").not.toBeInstanceOf(ServiceError);
    expect((err as Error).message).toMatch(/did not resolve/);
    // The socket's own code, so the send path reads it as an unreachable server (424), not a 500.
    expect((err as { code?: unknown }).code).toBe("ENOTFOUND");
    expect(rec.built).toEqual([]);
  });

  it("(6) the no-smtp-row fallback checks the SAME name twice, once per transport", async () => {
    /* A mailbox with no `smtp` row sends through `imap host:587`. That is a different transport on
       the same name — a different port gate and a separate dial — so it is checked as one, and the
       submission leg carries its own pin rather than borrowing the IMAP leg's. */
    const { resolver, asked } = scriptedResolver({ [IMAP_NAME]: [[PUBLIC_IMAP]] });
    const d = await makeDeps();
    hosted(d, resolver);
    const seeded = await seed(d, { smtpHost: null });
    const rec = recorder();

    await makeSendAdapter(d.deps, seeded.mailboxId, {}, rec.newAdapter);

    expect(rec.built[0]!.smtp?.host).toBe(IMAP_NAME);
    expect(rec.built[0]!.smtp?.pin).toEqual([PUBLIC_IMAP]);
    expect(asked()).toEqual([IMAP_NAME, IMAP_NAME]);
  });
});
