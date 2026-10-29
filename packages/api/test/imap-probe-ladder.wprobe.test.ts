import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { mailboxCredentials } from "@trafficflow/db";
import { ImapAdapter, type ImapConfig } from "@trafficflow/core/adapters/imap";
import {
  makeImapProbe, makeSmtpProbe, probeAttempts, smtpProbeAttempts, certCoversHost,
  tlsDetailOf, smtpTlsDetailOf, smtpVerdictFor, verdictFor, isStarttlsUnavailable,
  makeProbeHostGuard, MAIL_PROBE_PORTS, PROBE_DEADLINE_MS, PROBE_TIMEOUTS,
  type ProbeDialer,
} from "../src/imap-probe.js";
import { WORKER_NET_TIMEOUTS } from "@trafficflow/core/adapters/imap";
import { LOOPBACK_ADMITTED, LOOPBACK_LOOKALIKES } from "../../core/test/adapters/_loopback-table.js";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * THE AUTO-DETECTION LADDER, THE TLS TAXONOMY, AND THE CONSENT GATE.
 *
 * Written for the first real external mailbox this product refused: a vanity host that is a
 * CNAME to its provider's server, whose (valid, publicly trusted) certificate names the
 * provider. The old probe dialled exactly one combination and had one sentence for every TLS
 * failure; these tests pin the three things that replaced it —
 *
 *  1. the LADDER: which combinations are dialled, in which order, and which are NEVER dialled;
 *  2. the TAXONOMY: a hostname mismatch, an expired cert and a server with no TLS at all are
 *     different sentences, and the mismatch names both hosts and (when it can be derived
 *     safely) the host the certificate can actually prove;
 *  3. the CONSENT GATE: plaintext is dialled only with the explicit flag AND fresh in-call
 *     proof that the server has no TLS — never as a fallback, and never when the server HAS
 *     TLS with a bad certificate, which is the downgrade shape the gate exists to refuse.
 *
 * The ladder tests dial through an injected factory, so they assert the CONFIGS the probe
 * builds — including the ones it must never build — without a socket.
 */

/* ── the ladders, as pure tables ─────────────────────────────────────────────────────────── */

describe("probeAttempts — the IMAP ladder", () => {
  it("no port: 993 implicit TLS first, then 143 STARTTLS — and nothing else", () => {
    expect(probeAttempts(undefined, undefined)).toEqual([
      { port: 993, secure: true }, { port: 143, secure: false },
    ]);
  });
  it("an explicit port+mode is respected verbatim — the shape every preset sends", () => {
    expect(probeAttempts(993, true)).toEqual([{ port: 993, secure: true }]);
    expect(probeAttempts(143, false)).toEqual([{ port: 143, secure: false }]);
  });
  it("an explicit port without a mode negotiates: canonical mode first, the other second", () => {
    expect(probeAttempts(993, undefined)).toEqual([{ port: 993, secure: true }, { port: 993, secure: false }]);
    expect(probeAttempts(1143, undefined)).toEqual([{ port: 1143, secure: false }, { port: 1143, secure: true }]);
  });
  it("PLAINTEXT IS NOT ON THE LADDER — no rung anywhere authenticates without TLS", () => {
    for (const attempts of [probeAttempts(undefined, undefined), probeAttempts(143, undefined), probeAttempts(9999, undefined)]) {
      // Every rung is either implicit TLS or the mandatory-STARTTLS mode the floor enforces
      // for `secure: false`; the ladder never emits a config that could skip the upgrade.
      expect(attempts.every((a) => typeof a.secure === "boolean")).toBe(true);
    }
  });
});

describe("smtpProbeAttempts — the submission ladder", () => {
  it("no port: 465 implicit TLS first (RFC 8314), then 587 STARTTLS", () => {
    expect(smtpProbeAttempts(undefined, undefined)).toEqual([
      { port: 465, secure: true }, { port: 587, secure: false },
    ]);
  });
  it("explicit combinations are respected; a bare port negotiates its mode", () => {
    expect(smtpProbeAttempts(587, false)).toEqual([{ port: 587, secure: false }]);
    expect(smtpProbeAttempts(465, undefined)).toEqual([{ port: 465, secure: true }, { port: 465, secure: false }]);
    expect(smtpProbeAttempts(2525, undefined)).toEqual([{ port: 2525, secure: false }, { port: 2525, secure: true }]);
  });
});

/* ── the certificate-name matcher the suggestion rests on ────────────────────────────────── */

describe("certCoversHost — RFC 6125 matching", () => {
  it("exact names match case-insensitively, trailing dots ignored", () => {
    expect(certCoversHost(["Mail.Example.COM"], "mail.example.com.")).toBe(true);
  });
  it("a wildcard covers exactly one leftmost label", () => {
    expect(certCoversHost(["*.example.com"], "mail.example.com")).toBe(true);
    expect(certCoversHost(["*.example.com"], "example.com")).toBe(false);
    expect(certCoversHost(["*.example.com"], "a.b.example.com")).toBe(false);
  });
  it("no name, no match", () => {
    expect(certCoversHost([], "mail.example.com")).toBe(false);
    expect(certCoversHost(["mail.other.net"], "mail.example.com")).toBe(false);
  });
});

/* ── the TLS taxonomy, both transports ───────────────────────────────────────────────────── */

/** A throw shaped like Node's identity-check failure, `cert` attached as `tls.connect` does. */
const altnameError = (host: string, cn: string, sans: string[]): Error =>
  Object.assign(new Error(`Hostname/IP does not match certificate's altnames: Host: ${host}. is not in the cert's altnames: ${sans.map((s) => `DNS:${s}`).join(", ")}`), {
    code: "ERR_TLS_CERT_ALTNAME_INVALID",
    cert: { subject: { CN: cn }, subjectaltname: sans.map((s) => `DNS:${s}`).join(", ") },
  });

describe("tlsDetailOf — the IMAP-side classification", () => {
  it("a hostname mismatch names both hosts", () => {
    const detail = tlsDetailOf(altnameError("mail.vanity.example", "mail.provider.example", ["mail.provider.example"]), "mail.vanity.example");
    expect(detail).toEqual({ kind: "hostname_mismatch", expectedHost: "mail.vanity.example", certHost: "mail.provider.example" });
  });
  it("expired / self-signed / untrusted each keep their own kind", () => {
    expect(tlsDetailOf(Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }), "h").kind).toBe("expired");
    expect(tlsDetailOf(Object.assign(new Error("self signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }), "h").kind).toBe("self_signed");
    expect(tlsDetailOf(Object.assign(new Error("unable to verify"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }), "h").kind).toBe("untrusted");
  });
  it("imapflow's no-STARTTLS throw is `tls_unavailable`, and `verdictFor` now calls it tls, not unknown", () => {
    const err = Object.assign(new Error("Server does not support STARTTLS"), { tlsFailed: true, authenticationFailed: true });
    expect(isStarttlsUnavailable(err)).toBe(true);
    expect(tlsDetailOf(err, "h")).toEqual({ kind: "tls_unavailable" });
    // Before this slice the flag fell through every check and the user was told "we could not
    // tell why" about a server whose problem is precisely nameable.
    expect(verdictFor(err)).toEqual({ verdict: "refuse", code: "tls" });
  });
});

describe("smtpTlsDetailOf — nodemailer re-stamps codes, so this classifier reads sentences", () => {
  it("THE LIVE SHAPE (smtp.vanity.example): code ESOCKET, message and cert intact", () => {
    // `_formatError` overwrote the OpenSSL code with its transport code; a code-gated
    // classifier read this as `connect` — about a valid-chain hostname mismatch.
    const err = Object.assign(
      new Error("Hostname/IP does not match certificate's altnames: Host: smtp.vanity.example. is not in the cert's altnames: DNS:mail.provider.example, DNS:smtp.provider.business"),
      {
        code: "ESOCKET", command: "CONN",
        cert: { subject: { CN: "mail.provider.example" }, subjectaltname: "DNS:mail.provider.example, DNS:smtp.provider.business" },
      },
    );
    expect(smtpTlsDetailOf(err, "smtp.vanity.example")).toEqual({
      kind: "hostname_mismatch", expectedHost: "smtp.vanity.example", certHost: "mail.provider.example",
    });
  });

  it("the wrapped identity failure still yields both hosts", () => {
    const err = Object.assign(
      new Error("Error initiating TLS - Hostname/IP does not match certificate's altnames: Host: smtp.vanity.example. is not in the cert's altnames: DNS:mail.provider.example, DNS:smtp.provider.example"),
      { code: "ETLS" },
    );
    expect(smtpTlsDetailOf(err, "smtp.vanity.example")).toEqual({
      kind: "hostname_mismatch", expectedHost: "smtp.vanity.example", certHost: "mail.provider.example",
    });
  });
  it("a refused STARTTLS (requireTLS sent it unadvertised) is `tls_unavailable`", () => {
    const err = Object.assign(new Error("Error upgrading connection with STARTTLS"), { code: "ETLS" });
    expect(smtpTlsDetailOf(err, "h")).toEqual({ kind: "tls_unavailable" });
  });
  it("the phone's TLS shim names the refusal itself: its kind, or a certificate it could not name", () => {
    // Android's words reach nodemailer as an ESOCKET over the shim's own stamps.
    const shim = (kind?: string) => Object.assign(new Error("Trust anchor for certification path not found."), {
      code: "ESOCKET", tlsFailed: true, certificateRefused: true, ...(kind ? { certificateKind: kind } : {}),
    });
    expect(smtpTlsDetailOf(shim("expired"), "h")).toEqual({ kind: "expired" });
    expect(smtpTlsDetailOf(shim("untrusted"), "h")).toEqual({ kind: "untrusted" });
    expect(smtpTlsDetailOf(shim(), "h")).toEqual({ kind: "generic" });
    expect(smtpTlsDetailOf(shim("a kind nobody wrote"), "h")).toEqual({ kind: "generic" });
  });
  it("a non-TLS failure is not claimed by this classifier", () => {
    expect(smtpTlsDetailOf(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }), "h")).toBeNull();
    expect(smtpVerdictFor(Object.assign(new Error("Invalid login"), { code: "EAUTH", responseCode: 535 }))).toEqual({ verdict: "refuse", code: "auth" });
    expect(smtpVerdictFor(Object.assign(new Error("try later"), { responseCode: 421 }))).toEqual({ verdict: "store_unverified", code: "connect" });
  });
});

/* ── the ladder through the probe itself, on an injected dialler ─────────────────────────── */

interface Dialled { config: ImapConfig }

function fakeDeps(scope?: readonly string[]): ApiDeps {
  return {
    db: {} as ApiDeps["db"],
    now: () => new Date(FIXED_NOW),
    services: {
      imapAdmission: { acquire: async () => true, release: async () => { /* counted elsewhere */ } },
      // Where the host resolves, for the plaintext bound; absent = this deployment cannot tell.
      ...(scope ? { probeScopeResolver: { resolve: async () => [...scope] } } : {}),
    } as unknown as ApiDeps["services"],
  } as ApiDeps;
}

/** A home network's mail server, and one on the internet. */
const LAN = ["192.168.1.20"] as const;
const INTERNET = ["93.184.216.34"] as const;

/** A factory that answers each dial from a script keyed on `port/secure/allowInsecure`. */
function scriptedFactory(script: (config: ImapConfig) => Promise<void>): {
  factory: (config: ImapConfig) => ProbeDialer; dialled: Dialled[];
} {
  const dialled: Dialled[] = [];
  return {
    dialled,
    factory: (config: ImapConfig): ProbeDialer => ({
      connect: async () => { dialled.push({ config }); await script(config); },
      close: async () => { /* nothing held */ },
    }),
  };
}

const noStartTls = (): Error =>
  Object.assign(new Error("Server does not support STARTTLS"), { tlsFailed: true, authenticationFailed: true });
const refusedPort = (): Error =>
  Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED", authenticationFailed: true });

const CRED = { host: "mail.vanity.example", user: "u@vanity.example", pass: "typed-secret-password-password" } as const;

describe("makeImapProbe — the ladder, the consent gate, the suggestion", () => {
  it("walks 993 then 143 and reports the WINNING combination", async () => {
    const { factory, dialled } = scriptedFactory(async (c) => {
      if (c.port === 993) throw refusedPort();
    });
    const probe = makeImapProbe(fakeDeps(), { adapterFactory: factory });
    const verdict = await probe({ accountId: "a", address: "u@vanity.example", imap: { ...CRED } });
    expect(dialled.map((d) => [d.config.port, d.config.secure])).toEqual([[993, true], [143, false]]);
    expect(verdict).toEqual({ verdict: "ok", proven: { host: CRED.host, port: 143, secure: false } });
  });

  it("a first-rung success never dials the second", async () => {
    const { factory, dialled } = scriptedFactory(async () => { /* accepted */ });
    const probe = makeImapProbe(fakeDeps(), { adapterFactory: factory });
    const verdict = await probe({ accountId: "a", address: "u@vanity.example", imap: { ...CRED } });
    expect(dialled).toHaveLength(1);
    expect(verdict).toEqual({ verdict: "ok", proven: { host: CRED.host, port: 993, secure: true } });
  });

  it("a rejected PASSWORD stops the ladder — the combination is proven, retrying helps nobody", async () => {
    const { factory, dialled } = scriptedFactory(async () => {
      throw Object.assign(new Error("no"), { authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" });
    });
    const probe = makeImapProbe(fakeDeps(), { adapterFactory: factory });
    const verdict = await probe({ accountId: "a", address: "u@vanity.example", imap: { ...CRED } });
    expect(dialled).toHaveLength(1);
    expect(verdict).toEqual({ verdict: "refuse", code: "auth" });
  });

  it("PLAINTEXT IS NEVER DIALLED WITHOUT THE FLAG — a no-TLS server refuses with its own kind", async () => {
    const { factory, dialled } = scriptedFactory(async (c) => {
      if (c.secure) throw refusedPort();
      throw noStartTls();
    });
    const probe = makeImapProbe(fakeDeps(), { adapterFactory: factory });
    const verdict = await probe({ accountId: "a", address: "u@vanity.example", imap: { ...CRED } });
    // Two rungs, and NOT a third: no config with `allowInsecure` was ever built.
    expect(dialled).toHaveLength(2);
    expect(dialled.every((d) => d.config.allowInsecure !== true)).toBe(true);
    expect(verdict).toEqual({ verdict: "refuse", code: "tls", tls: { kind: "tls_unavailable" } });
  });

  it("the flag alone is NOT enough — a server with TLS-but-bad-cert never gets the plaintext dial", async () => {
    const { factory, dialled } = scriptedFactory(async (c) => {
      if (c.secure) throw altnameError(CRED.host, "mail.provider.example", ["mail.provider.example"]);
      throw noStartTls();
    });
    const probe = makeImapProbe(fakeDeps(), { adapterFactory: factory, resolveCname: async () => null });
    const verdict = await probe({
      accountId: "a", address: "u@vanity.example", imap: { ...CRED, allowInsecure: true },
    });
    // The server HAS encryption; consent to plaintext must not paper over its certificate.
    expect(dialled.every((d) => d.config.allowInsecure !== true)).toBe(true);
    expect(verdict.verdict).toBe("refuse");
    expect((verdict as { tls?: { kind?: string } }).tls?.kind).toBe("hostname_mismatch");
  });

  it("flag + fresh proof of no-TLS + a host on the home network = the consent dial, pinned there", async () => {
    const { factory, dialled } = scriptedFactory(async (c) => {
      if (c.secure) throw refusedPort();
      if (!c.allowInsecure) throw noStartTls();
      // The consented plaintext login is the one that succeeds.
    });
    const probe = makeImapProbe(fakeDeps(LAN), { adapterFactory: factory });
    const verdict = await probe({
      accountId: "a", address: "u@vanity.example", imap: { ...CRED, allowInsecure: true },
    });
    expect(dialled.map((d) => [d.config.port, d.config.secure, d.config.allowInsecure === true]))
      .toEqual([[993, true, false], [143, false, false], [143, false, true]]);
    // The plaintext socket goes to the address that was judged private, never to a second lookup.
    expect(dialled[2]!.config.pin).toEqual(LAN);
    expect(verdict).toEqual({
      verdict: "ok", proven: { host: CRED.host, port: 143, secure: false, insecure: true },
    });
  });

  it("a no-TLS server on the home network is OFFERED the consent, and nothing plaintext is dialled", async () => {
    const { factory, dialled } = scriptedFactory(async (c) => {
      if (c.secure) throw refusedPort();
      throw noStartTls();
    });
    const probe = makeImapProbe(fakeDeps(LAN), { adapterFactory: factory });
    const verdict = await probe({ accountId: "a", address: "u@vanity.example", imap: { ...CRED } });
    expect(dialled.every((d) => d.config.allowInsecure !== true)).toBe(true);
    expect(verdict).toEqual({ verdict: "refuse", code: "tls", tls: { kind: "tls_unavailable", plaintext: "offered" } });
  });

  it("A PUBLIC HOST NEVER GETS THE PLAINTEXT DIAL, consent or not, and the refusal says why", async () => {
    const { factory, dialled } = scriptedFactory(async (c) => {
      if (c.secure) throw refusedPort();
      throw noStartTls();
    });
    // One public address among private ones is a public host.
    const probe = makeImapProbe(fakeDeps([...LAN, ...INTERNET]), { adapterFactory: factory });
    const verdict = await probe({
      accountId: "a", address: "u@vanity.example", imap: { ...CRED, allowInsecure: true },
    });
    expect(dialled).toHaveLength(2);
    expect(dialled.every((d) => d.config.allowInsecure !== true)).toBe(true);
    expect(verdict).toEqual({ verdict: "refuse", code: "tls", tls: { kind: "tls_unavailable", plaintext: "not_private" } });
  });

  it("a working TLS server ignores a stray flag entirely — no plaintext dial, a secure verdict", async () => {
    const { factory, dialled } = scriptedFactory(async () => { /* 993 accepts */ });
    const probe = makeImapProbe(fakeDeps(), { adapterFactory: factory });
    const verdict = await probe({
      accountId: "a", address: "u@vanity.example", imap: { ...CRED, allowInsecure: true },
    });
    expect(dialled).toHaveLength(1);
    expect(verdict).toEqual({ verdict: "ok", proven: { host: CRED.host, port: 993, secure: true } });
  });

  it("HOSTNAME MISMATCH + a CNAME the certificate covers = the canonical-host suggestion", async () => {
    const { factory } = scriptedFactory(async () => {
      throw altnameError(CRED.host, "mail.provider.example", ["mail.provider.example", "*.provider.business"]);
    });
    const probe = makeImapProbe(fakeDeps(), {
      adapterFactory: factory,
      resolveCname: async () => "mail.provider.business",   // covered by the wildcard SAN
    });
    const verdict = await probe({ accountId: "a", address: "u@vanity.example", imap: { ...CRED, port: 993, secure: true } });
    expect(verdict).toEqual({
      verdict: "refuse", code: "tls",
      tls: {
        kind: "hostname_mismatch", expectedHost: CRED.host, certHost: "mail.provider.example",
        suggestedHost: "mail.provider.business",
      },
    });
  });

  it("no CNAME (or one the certificate does not cover) falls back to the certificate's own subject", async () => {
    const { factory } = scriptedFactory(async () => {
      throw altnameError(CRED.host, "mail.provider.example", ["mail.provider.example"]);
    });
    const probe = makeImapProbe(fakeDeps(), { adapterFactory: factory, resolveCname: async () => "unrelated.cdn.example" });
    const verdict = await probe({ accountId: "a", address: "u@vanity.example", imap: { ...CRED, port: 993, secure: true } });
    expect((verdict as { tls?: { suggestedHost?: string } }).tls?.suggestedHost).toBe("mail.provider.example");
  });

  it("R23-03: a certificate nobody vouches for, on the operator's own network, names how THIS server can trust it", async () => {
    const selfSigned = scriptedFactory(async () => {
      throw Object.assign(new Error("self signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT", authenticationFailed: true });
    });
    const withTrust = (scope: readonly string[]): ApiDeps => {
      const d = fakeDeps(scope);
      (d.services as unknown as { probeOperatorTrust: string }).probeOperatorTrust = "NODE_EXTRA_CA_CERTS";
      return d;
    };
    const ask = (d: ApiDeps) => makeImapProbe(d, { adapterFactory: selfSigned.factory })(
      { accountId: "a", address: "u@vanity.example", imap: { ...CRED, port: 993, secure: true } });
    expect(await ask(withTrust(LAN))).toEqual({
      verdict: "refuse", code: "tls", tls: { kind: "self_signed", trustVariable: "NODE_EXTRA_CA_CERTS" },
    });
    // On the internet the lever is a public certificate, and a deployment with no lever names none.
    expect(await ask(withTrust(INTERNET))).toEqual({ verdict: "refuse", code: "tls", tls: { kind: "self_signed" } });
    expect(await ask(fakeDeps(LAN))).toEqual({ verdict: "refuse", code: "tls", tls: { kind: "self_signed" } });
  });

  it("a garbage certificate gets NO suggestion — only a chain-valid mismatch may recommend a host", async () => {
    const { factory } = scriptedFactory(async () => {
      throw Object.assign(new Error("self signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT", authenticationFailed: true });
    });
    const resolveCname = vi.fn(async () => "mail.provider.business");
    const probe = makeImapProbe(fakeDeps(), { adapterFactory: factory, resolveCname });
    const verdict = await probe({ accountId: "a", address: "u@vanity.example", imap: { ...CRED, port: 993, secure: true } });
    expect(verdict).toEqual({ verdict: "refuse", code: "tls", tls: { kind: "self_signed" } });
    // The resolver is not even consulted: DNS has nothing to add to a certificate nobody vouches for.
    expect(resolveCname).not.toHaveBeenCalled();
  });
});

describe("makeSmtpProbe — the submission ladder and its own consent arm", () => {
  const SMTP_IN = { accountId: "a", address: "u@vanity.example", smtp: { host: "smtp.vanity.example", user: "u@vanity.example", pass: "typed-secret-password-password" } };

  it("walks 465 then 587 and reports the winning combination", async () => {
    const dialled: Array<[number, boolean]> = [];
    const probe = makeSmtpProbe(fakeDeps(), {
      dial: async (smtp) => {
        dialled.push([smtp.port, smtp.secure]);
        if (smtp.port === 465) throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      },
    });
    const verdict = await probe(SMTP_IN);
    expect(dialled).toEqual([[465, true], [587, false]]);
    // `maxMessageBytes: null` — this double resolves `void`, which is a dial that learned nothing.
    // It is explicit here rather than loosened out of the equality: the whole value of `toEqual` on
    // a proven endpoint is that a field appearing on it has to be accounted for.
    expect(verdict).toEqual({
      verdict: "ok",
      proven: { host: "smtp.vanity.example", port: 587, secure: false, maxMessageBytes: null },
    });
  });

  it("carries the server's own SIZE announcement onto the proven endpoint", async () => {
    // What the dial LEARNED, not merely that it succeeded. The connect flow stores this on the
    // mailbox row and `SendService` caps a send at the smaller of it and the host's own limit, so a
    // probe that dropped it would leave the whole feature measuring and discarding.
    const probe = makeSmtpProbe(fakeDeps(), {
      dial: async () => ({ maxMessageBytes: 35_882_577 }),
    });
    expect(await probe(SMTP_IN)).toEqual({
      verdict: "ok",
      proven: { host: "smtp.vanity.example", port: 465, secure: true, maxMessageBytes: 35_882_577 },
    });
  });

  it("a server that announced nothing proves the endpoint with a null ceiling", async () => {
    const probe = makeSmtpProbe(fakeDeps(), { dial: async () => ({ maxMessageBytes: null }) });
    expect(await probe(SMTP_IN)).toEqual({
      verdict: "ok",
      proven: { host: "smtp.vanity.example", port: 465, secure: true, maxMessageBytes: null },
    });
  });

  it("the vanity-CNAME mismatch carries the suggestion, parsed from nodemailer's wrapped sentence", async () => {
    const probe = makeSmtpProbe(fakeDeps(), {
      dial: async () => {
        throw Object.assign(
          new Error("Error initiating TLS - Hostname/IP does not match certificate's altnames: Host: smtp.vanity.example. is not in the cert's altnames: DNS:mail.provider.example, DNS:smtp.provider.business"),
          { code: "ETLS" },
        );
      },
      resolveCname: async () => "smtp.provider.business",
    });
    const verdict = await probe(SMTP_IN);
    expect(verdict).toEqual({
      verdict: "refuse", code: "tls",
      tls: {
        kind: "hostname_mismatch", expectedHost: "smtp.vanity.example", certHost: "mail.provider.example",
        suggestedHost: "smtp.provider.business",
      },
    });
  });

  /** A submission server with no TLS at all: 465 closed, 587 answers STARTTLS with a refusal. */
  const noTlsSubmission = (dials: Array<{ port: number; allowInsecure: boolean; pin?: readonly string[] }>) =>
    async (smtp: { port: number; secure: boolean; allowInsecure?: boolean; pin?: readonly string[] }): Promise<void> => {
      dials.push({ port: smtp.port, allowInsecure: smtp.allowInsecure === true, ...(smtp.pin ? { pin: smtp.pin } : {}) });
      if (smtp.secure) throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      if (smtp.allowInsecure !== true) {
        throw Object.assign(new Error("Error upgrading connection with STARTTLS"), { code: "ETLS" });
      }
    };

  it("a no-TLS submission host on the home network is OFFERED its own consent, and not dialled in plaintext", async () => {
    const dials: Array<{ port: number; allowInsecure: boolean }> = [];
    const probe = makeSmtpProbe(fakeDeps(LAN), { dial: noTlsSubmission(dials) });
    const verdict = await probe(SMTP_IN);
    expect(dials.every((d) => !d.allowInsecure)).toBe(true);
    expect(verdict).toEqual({ verdict: "refuse", code: "tls", tls: { kind: "tls_unavailable", plaintext: "offered" } });
  });

  it("R23-02: consent + no TLS + home network = the plaintext SMTP login, pinned, proven insecure", async () => {
    const dials: Array<{ port: number; allowInsecure: boolean; pin?: readonly string[] }> = [];
    const probe = makeSmtpProbe(fakeDeps(LAN), { dial: noTlsSubmission(dials) });
    const verdict = await probe({ ...SMTP_IN, smtp: { ...SMTP_IN.smtp, allowInsecure: true } });
    expect(dials).toEqual([
      { port: 465, allowInsecure: false }, { port: 587, allowInsecure: false },
      { port: 587, allowInsecure: true, pin: LAN },
    ]);
    expect(verdict).toEqual({
      verdict: "ok",
      proven: { host: "smtp.vanity.example", port: 587, secure: false, insecure: true, maxMessageBytes: null },
    });
  });

  it("a PUBLIC submission host is refused plaintext whatever the flag says, and told why", async () => {
    const dials: Array<{ port: number; allowInsecure: boolean }> = [];
    const probe = makeSmtpProbe(fakeDeps(INTERNET), { dial: noTlsSubmission(dials) });
    const verdict = await probe({ ...SMTP_IN, smtp: { ...SMTP_IN.smtp, allowInsecure: true } });
    expect(dials.every((d) => !d.allowInsecure)).toBe(true);
    expect(verdict).toEqual({ verdict: "refuse", code: "tls", tls: { kind: "tls_unavailable", plaintext: "not_private" } });
  });

  it("a certificate on any rung keeps its refusal — consent never turns a bad certificate into plaintext", async () => {
    const dials: Array<{ port: number; allowInsecure: boolean }> = [];
    const probe = makeSmtpProbe(fakeDeps(LAN), {
      dial: async (smtp) => {
        dials.push({ port: smtp.port, allowInsecure: smtp.allowInsecure === true });
        if (smtp.secure) throw Object.assign(new Error("self signed certificate"), { code: "ESOCKET" });
        throw Object.assign(new Error("Error upgrading connection with STARTTLS"), { code: "ETLS" });
      },
    });
    const verdict = await probe({ ...SMTP_IN, smtp: { ...SMTP_IN.smtp, allowInsecure: true } });
    expect(dials.every((d) => !d.allowInsecure)).toBe(true);
    expect((verdict as { tls?: { kind?: string } }).tls?.kind).toBe("self_signed");
  });

  it("a deployment that cannot tell where a host is offers nothing", async () => {
    const dials: Array<{ port: number; allowInsecure: boolean }> = [];
    const probe = makeSmtpProbe(fakeDeps(), { dial: noTlsSubmission(dials) });
    const verdict = await probe({ ...SMTP_IN, smtp: { ...SMTP_IN.smtp, allowInsecure: true } });
    expect(dials.every((d) => !d.allowInsecure)).toBe(true);
    expect(verdict).toEqual({ verdict: "refuse", code: "tls", tls: { kind: "tls_unavailable" } });
  });
});

/* ── SEC2 IMAP-PROBE-CONNECT-ORACLE: the hosted SSRF/port guard, before any dial ──────────────
 *
 * The add-time probe dials a `host:port` the caller typed behind a verified session. On the hosted
 * deployment that is a connect oracle into the deployment's network; the guard resolves the host and
 * refuses a private/loopback answer, and refuses a non-mail port, BEFORE a socket exists. The
 * resolver is injected (never `node:dns`), so the PERMIT branch — a public host is dialled — is the
 * one these tests run, which a DNS-blocked sandbox could never reach through a real resolver. */

describe("makeImapProbe/makeSmtpProbe — the hosted host+port guard refuses before dialling", () => {
  const resolvesTo = (...addrs: string[]) => ({ async resolve(): Promise<string[]> { return addrs; } });
  const withGuard = (guard: ReturnType<typeof makeProbeHostGuard>): ApiDeps => {
    const d = fakeDeps();
    (d.services as unknown as { probeHostGuard: unknown }).probeHostGuard = guard;
    return d;
  };
  const IMAP_IN = (over: Record<string, unknown> = {}) =>
    ({ accountId: "a", address: "u@vanity.example", imap: { ...CRED, port: 993, secure: true, ...over } });

  it("PERMIT: a public-resolving host on a mail port IS dialled (the branch a node:dns default could never run)", async () => {
    const { factory, dialled } = scriptedFactory(async () => { /* greeting ok → verdict ok */ });
    const probe = makeImapProbe(withGuard(makeProbeHostGuard(resolvesTo("93.184.216.34"))), { adapterFactory: factory });
    const verdict = await probe(IMAP_IN());
    expect(verdict.verdict).toBe("ok");
    expect(dialled).toHaveLength(1);
  });

  it("BLOCK: a host that resolves to the metadata address refuses, and NEVER dials", async () => {
    const { factory, dialled } = scriptedFactory(async () => { throw new Error("the guard must have stopped this before any dial"); });
    const probe = makeImapProbe(withGuard(makeProbeHostGuard(resolvesTo("169.254.169.254"))), { adapterFactory: factory });
    await expect(probe(IMAP_IN())).rejects.toMatchObject({ httpStatus: 400 });
    expect(dialled).toHaveLength(0);
  });

  it("PORT CAP: an explicit non-mail port (22) refuses before any dial, even for a public host", async () => {
    const { factory, dialled } = scriptedFactory(async () => { throw new Error("the port cap must have stopped this before any dial"); });
    const probe = makeImapProbe(withGuard(makeProbeHostGuard(resolvesTo("93.184.216.34"))), { adapterFactory: factory });
    await expect(probe(IMAP_IN({ port: 22 }))).rejects.toMatchObject({ httpStatus: 400 });
    expect(dialled).toHaveLength(0);
    expect(MAIL_PROBE_PORTS.imap.has(22)).toBe(false);
    expect(MAIL_PROBE_PORTS.imap.has(993)).toBe(true);
  });

  it("SMTP: the same guard refuses a private-resolving submission host without a dial", async () => {
    let dialled = 0;
    const probe = makeSmtpProbe(withGuard(makeProbeHostGuard(resolvesTo("10.0.0.5"))), {
      dial: async () => { dialled += 1; },
    });
    await expect(
      probe({ accountId: "a", address: "u@vanity.example", smtp: { host: "smtp.vanity.example", user: "u@vanity.example", pass: "x" } }),
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect(dialled).toBe(0);
  });
});

/* ── a server on THIS computer gets the sync dial's wait, and nothing else does ────────── */

/** The sync dial's deadlines, as the desktop passes them: 15 + 15 + 120 = 150 s for the whole probe. */
const LOCAL = WORKER_NET_TIMEOUTS;
const LOCAL_BOUND_MS = LOCAL.connectionMs + LOCAL.greetingMs + LOCAL.socketMs;

/**
 * A server that answers the sign-in after `holdMs`. `honour` makes it behave as imapflow does with
 * the timeouts the dialler was BUILT with (socket silence past `socketMs` is ETIMEOUT); without it
 * the hold outlives every client timer and only the probe's own deadline can end it.
 */
function holdingFactory(holdMs: number, honour: boolean): {
  factory: (config: ImapConfig) => ProbeDialer; built: ImapConfig[];
} {
  const built: ImapConfig[] = [];
  return {
    built,
    factory: (config: ImapConfig): ProbeDialer => ({
      connect: () => new Promise<void>((resolve, reject) => {
        built.push(config);
        const socketMs = config.timeouts?.socketMs ?? Number.POSITIVE_INFINITY;
        if (honour && holdMs > socketMs) {
          setTimeout(() => reject(Object.assign(new Error("Socket timeout"), { code: "ETIMEOUT" })), socketMs);
        } else {
          setTimeout(resolve, holdMs);
        }
      }),
      close: async () => { /* nothing held */ },
    }),
  };
}

const typed = (host: string) => ({
  accountId: "a", address: "u@gateway.test",
  imap: { host, port: 1143, secure: false, user: "u@gateway.test", pass: "typed-secret-password-password" },
});

/** Run one probe under fake time; the verdict and the virtual instant it settled at. */
async function timed(
  probe: (i: ReturnType<typeof typed>) => Promise<unknown>, host: string, runMs: number,
): Promise<{ verdict: unknown; at: number | null }> {
  let at: number | null = null;
  const t0 = Date.now();
  const p = probe(typed(host)).then((v) => { at = Date.now() - t0; return v; });
  await vi.advanceTimersByTimeAsync(runMs);
  return { verdict: await p, at };
}

describe("makeImapProbe — localServerDial: the local-gateway wait", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("127.0.0.1 holding the sign-in 90 s passes, dialled with the option's own timeouts", async () => {
    vi.useFakeTimers();
    const { factory, built } = holdingFactory(90_000, true);
    const probe = makeImapProbe(fakeDeps(), { adapterFactory: factory, localServerDial: LOCAL });
    const { verdict } = await timed(probe, "127.0.0.1", 91_000);
    expect(verdict).toMatchObject({ verdict: "ok" });
    expect(built.map((c) => c.timeouts)).toEqual([LOCAL]);
  });

  it("every row the address-class table admits waits too", async () => {
    vi.useFakeTimers();
    for (const host of LOOPBACK_ADMITTED) {
      const { factory } = holdingFactory(90_000, true);
      const probe = makeImapProbe(fakeDeps(), { adapterFactory: factory, localServerDial: LOCAL });
      expect((await timed(probe, host, 91_000)).verdict, host).toMatchObject({ verdict: "ok" });
    }
  });

  it("a remote host keeps today's 20 s and today's timeouts, with the option passed", async () => {
    vi.useFakeTimers();
    const { factory, built } = holdingFactory(90_000, false);
    const probe = makeImapProbe(fakeDeps(), { adapterFactory: factory, localServerDial: LOCAL });
    const { verdict, at } = await timed(probe, "imap.example.com", 91_000);
    expect(verdict).toEqual({ verdict: "refuse", code: "timeout" });
    expect(at).toBe(PROBE_DEADLINE_MS);
    expect(built.map((c) => c.timeouts)).toEqual([PROBE_TIMEOUTS]);
  });

  it("every lookalike the address-class table refuses gets no wait: unspecified, mapped, look-alike, LAN, RFC 1918", async () => {
    vi.useFakeTimers();
    for (const host of LOOPBACK_LOOKALIKES.filter((h) => h.trim() !== "")) {
      const { factory, built } = holdingFactory(90_000, false);
      const probe = makeImapProbe(fakeDeps(), { adapterFactory: factory, localServerDial: LOCAL });
      const { verdict, at } = await timed(probe, host, 91_000);
      expect(verdict, host).toEqual({ verdict: "refuse", code: "timeout" });
      expect(at, host).toBe(PROBE_DEADLINE_MS);
      expect(built.map((c) => c.timeouts), host).toEqual([PROBE_TIMEOUTS]);
    }
  });

  it("a loopback hold past the bound times out at 150 s, derived from the option and nothing else", async () => {
    vi.useFakeTimers();
    const { factory } = holdingFactory(140_000 + LOCAL_BOUND_MS, false);
    const probe = makeImapProbe(fakeDeps(), { adapterFactory: factory, localServerDial: LOCAL, deadlineMs: 5_000 });
    const { verdict, at } = await timed(probe, "127.0.0.1", 200_000);
    expect(verdict).toEqual({ verdict: "refuse", code: "timeout", localServer: true });
    expect(at).toBe(LOCAL_BOUND_MS);
  });

  it("an honest 140 s hold ends at the dialler's own 120 s socket bound", async () => {
    vi.useFakeTimers();
    const { factory } = holdingFactory(140_000, true);
    const probe = makeImapProbe(fakeDeps(), { adapterFactory: factory, localServerDial: LOCAL });
    const { verdict, at } = await timed(probe, "127.0.0.1", 200_000);
    expect(verdict).toEqual({ verdict: "refuse", code: "timeout", localServer: true });
    // The socket bound the dialler was built with (120 s), not the probe's 12 s, and not 150 s.
    expect(at).toBe(LOCAL.socketMs);
  });

  it("the stamp says where the wait applied: a local refusal carries it, a sign-in NO too, a remote one never", async () => {
    const refusing = (code: string) => (config: ImapConfig): ProbeDialer => ({
      connect: async () => { void config; throw Object.assign(new Error("refused"), code === "auth"
        ? { authenticationFailed: true, responseText: "LOGIN failed" } : { code }); },
      close: async () => { /* nothing held */ },
    });
    const local = makeImapProbe(fakeDeps(), { adapterFactory: refusing("auth"), localServerDial: LOCAL });
    expect(await local(typed("127.0.0.1"))).toMatchObject({ verdict: "refuse", code: "auth", localServer: true });
    expect(await local(typed("imap.example.com"))).not.toHaveProperty("localServer");
    const door = makeImapProbe(fakeDeps(), { adapterFactory: refusing("auth") });
    expect(await door(typed("127.0.0.1")), "a door without the wait stamps nothing").not.toHaveProperty("localServer");
  });

  it("without the option (Cloud, self-host) loopback is byte-identical to today: 20 s", async () => {
    vi.useFakeTimers();
    const { factory, built } = holdingFactory(90_000, false);
    const probe = makeImapProbe(fakeDeps(), { adapterFactory: factory });
    const { verdict, at } = await timed(probe, "127.0.0.1", 91_000);
    expect(verdict).toEqual({ verdict: "refuse", code: "timeout" });
    expect(at).toBe(PROBE_DEADLINE_MS);
    expect(built.map((c) => c.timeouts)).toEqual([PROBE_TIMEOUTS]);
  });
});

/* ── the whole flow through the route: what gets STORED, and the consent round-trip ──────── */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

async function session(): Promise<{ db: Awaited<ReturnType<typeof makeDeps>>["db"]; deps: ApiDeps; token: string }> {
  const { db, deps } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
  return { db, deps, token: s.token };
}

const manualPost = (
  token: string, imapOver: Record<string, unknown> = {}, smtpOver: Record<string, unknown> = {},
): Request =>
  req("POST", "/mailboxes", {
    bearer: token,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "imap", address: "u@vanity.example",
      // The manual-provider shape: HOSTS ONLY. Port and TLS mode are the probe's to prove.
      imap: { host: "mail.vanity.example", user: "u@vanity.example", pass: "typed-secret-password-password", ...imapOver },
      smtp: { host: "smtp.vanity.example", user: "u@vanity.example", ...smtpOver },
    }),
  });

/** The submission seam for a server with no TLS: 465 closed, 587 without STARTTLS, plaintext only on consent. */
const noTlsSmtp = async (smtp: { secure: boolean; allowInsecure?: boolean }): Promise<void> => {
  if (smtp.secure) throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
  if (smtp.allowInsecure !== true) throw Object.assign(new Error("Error upgrading connection with STARTTLS"), { code: "ETLS" });
};

/** Drive the REAL probe ladder through the spied adapter, branching on the dialled config. */
function scriptDial(script: (config: ImapConfig) => Promise<void>): void {
  vi.spyOn(ImapAdapter.prototype, "connect").mockImplementation(async function (this: unknown) {
    await script((this as { config: ImapConfig }).config);
  });
  vi.spyOn(ImapAdapter.prototype, "close").mockResolvedValue(undefined);
}

afterEach(() => { vi.restoreAllMocks(); });

describe("POST /mailboxes — the ladder end to end", () => {
  it("STORES THE PROVEN COMBINATION, not a guess: a 143-only server lands as 143/STARTTLS", async () => {
    const { db, deps, token } = await session();
    scriptDial(async (c) => { if (c.port !== 143) throw refusedPort(); });

    const res = await H(manualPost(token), deps);
    expect(res.status).toBe(201);

    const [imapRow] = await db.select().from(mailboxCredentials).where(eq(mailboxCredentials.transport, "imap"));
    expect(imapRow!.meta).toEqual({
      host: "mail.vanity.example", port: 143, secure: false, user: "u@vanity.example",
    });
  });

  it("the consent round-trip: refused with tls_unavailable, then admitted WITH the flag, marker stored", async () => {
    const { db, deps, token } = await session();
    (deps.services as unknown as { probeScopeResolver: unknown }).probeScopeResolver = { resolve: async () => [...LAN] };
    scriptDial(async (c) => {
      if (c.secure) throw refusedPort();
      if (!c.allowInsecure) throw noStartTls();
    });

    // First submit: no flag. The server proves TLS absent and says so — nothing stored.
    const first = await H(manualPost(token), deps);
    const firstWire = await first.json();
    expect(first.status).toBe(400);
    expect(firstWire.error.details.reason).toBe("tls");
    expect(firstWire.error.details.tls).toEqual({ kind: "tls_unavailable", plaintext: "offered" });
    // The sentence names the protocol that refused: the consent is per protocol.
    expect(firstWire.error.message).toContain("incoming (IMAP)");
    expect(await db.select().from(mailboxCredentials)).toHaveLength(0);

    // Second submit: the explicit opt-in. Admitted, and the meta carries exactly what was proved.
    const second = await H(manualPost(token, { allowInsecure: true }), deps);
    expect(second.status).toBe(201);
    const [imapRow] = await db.select().from(mailboxCredentials).where(eq(mailboxCredentials.transport, "imap"));
    expect(imapRow!.meta).toEqual({
      host: "mail.vanity.example", port: 143, secure: false, user: "u@vanity.example",
      insecureConsent: true,
    });
  });

  it("the vanity-CNAME refusal carries both hosts in details.tls, but its MESSAGE names neither (SEC2 IMAP-PROBE)", async () => {
    const { deps, token } = await session();
    scriptDial(async () => {
      throw altnameError("mail.vanity.example", "mail.provider.example", ["mail.provider.example"]);
    });

    const res = await H(manualPost(token), deps);
    const wire = await res.json();
    expect(res.status).toBe(400);
    expect(wire.error.details.transport).toBe("imap");
    // The STRUCTURED detail still carries both hosts and the suggestion — the client's own
    // vanity-CNAME one-press host correction reads them, and (on the hosted deployment) the SSRF
    // host guard means the dialed host was public in the first place.
    expect(wire.error.details.tls).toEqual({
      kind: "hostname_mismatch", expectedHost: "mail.vanity.example", certHost: "mail.provider.example",
      // `mail.vanity.example` has no CNAME (the resolver fails closed in this environment), so
      // the suggestion falls back to the certificate's own subject — the provider's real host.
      suggestedHost: "mail.provider.example",
    });
    // But the server's SENTENCE names no host from the dialed certificate — behind a verified
    // session that string would be a caller-driven disclosure of an internal hostname.
    expect(wire.error.message).not.toContain("mail.provider.example");
    // The guarantee that must survive every rewording.
    expect(wire.error.message).toContain("before sending the password");
  });

  it("R23-02 end to end: the SMTP half is refused by name, then admitted with ITS consent, marker on its row", async () => {
    const { db, deps, token } = await session();
    (deps.services as unknown as { probeScopeResolver: unknown }).probeScopeResolver = { resolve: async () => [...LAN] };
    scriptDial(async () => { /* IMAP accepts over TLS */ });
    (deps.services as unknown as { smtpVerify: unknown }).smtpVerify = noTlsSmtp;

    const first = await H(manualPost(token), deps);
    const firstWire = await first.json();
    expect(first.status).toBe(400);
    expect(firstWire.error.details.transport).toBe("smtp");
    expect(firstWire.error.details.tls).toEqual({ kind: "tls_unavailable", plaintext: "offered" });
    expect(firstWire.error.message).toContain("outgoing (SMTP)");
    expect(await db.select().from(mailboxCredentials)).toHaveLength(0);

    // The IMAP consent is not the SMTP one: only the smtp block's own flag admits it.
    const imapOnly = await H(manualPost(token, { allowInsecure: true }), deps);
    expect(imapOnly.status).toBe(400);

    const second = await H(manualPost(token, {}, { allowInsecure: true }), deps);
    expect(second.status).toBe(201);
    const [smtpRow] = await db.select().from(mailboxCredentials).where(eq(mailboxCredentials.transport, "smtp"));
    expect(smtpRow!.meta).toMatchObject({ host: "smtp.vanity.example", port: 587, secure: false, insecureConsent: true });
    const [imapRow] = await db.select().from(mailboxCredentials).where(eq(mailboxCredentials.transport, "imap"));
    expect((imapRow!.meta as { insecureConsent?: unknown }).insecureConsent).toBeUndefined();
  });

  it("the certificate refusal's sentence names the operator's lever on a self-hosted server's own network", async () => {
    const { deps, token } = await session();
    (deps.services as unknown as { probeScopeResolver: unknown }).probeScopeResolver = { resolve: async () => [...LAN] };
    (deps.services as unknown as { probeOperatorTrust: string }).probeOperatorTrust = "NODE_EXTRA_CA_CERTS";
    scriptDial(async () => {
      throw Object.assign(new Error("self signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT", authenticationFailed: true });
    });
    const wire = await (await H(manualPost(token), deps)).json();
    expect(wire.error.message).toContain("NODE_EXTRA_CA_CERTS on the api and the organizer");
    expect(wire.error.message).toContain("before sending the password");
  });

  it("a public no-TLS server is refused with the reason named, and nothing is stored", async () => {
    const { db, deps, token } = await session();
    (deps.services as unknown as { probeScopeResolver: unknown }).probeScopeResolver = { resolve: async () => [...INTERNET] };
    scriptDial(async () => { /* IMAP accepts over TLS */ });
    (deps.services as unknown as { smtpVerify: unknown }).smtpVerify = noTlsSmtp;

    const res = await H(manualPost(token, {}, { allowInsecure: true }), deps);
    const wire = await res.json();
    expect(res.status).toBe(400);
    expect(wire.error.details.tls).toEqual({ kind: "tls_unavailable", plaintext: "not_private" });
    expect(wire.error.message).toContain("not on your own network");
    expect(await db.select().from(mailboxCredentials)).toHaveLength(0);
  });

  it("an SMTP refusal blames the SMTP field, and IMAP being fine does not mask it", async () => {
    const { db, deps, token } = await session(); // helpers' smtpVerify accepts by default…
    scriptDial(async () => { /* IMAP accepts */ });
    (deps.services as unknown as { smtpVerify: (s: { host: string }) => Promise<void> }).smtpVerify =
      async () => {
        throw Object.assign(
          new Error("Error initiating TLS - Hostname/IP does not match certificate's altnames: Host: smtp.vanity.example. is not in the cert's altnames: DNS:mail.provider.example"),
          { code: "ETLS" },
        );
      };

    const res = await H(manualPost(token), deps);
    const wire = await res.json();
    expect(res.status).toBe(400);
    expect(wire.error.details.transport).toBe("smtp");
    expect(wire.error.details.tls.kind).toBe("hostname_mismatch");
    expect(wire.error.message).toContain("SMTP");
    // A refused SMTP probe writes NOTHING — not the mailbox, not the already-proven IMAP row.
    expect(await db.select().from(mailboxCredentials)).toHaveLength(0);
  });
});
