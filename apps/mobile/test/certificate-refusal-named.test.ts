import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A CERTIFICATE THE PLATFORM REFUSED IS SAID AS ONE — the shim's half, on the shapes both native
 * halves produce. The platform socket reports a failed handshake as a bare message; before this the
 * implicit-TLS dial rejected with no flag and the engine read it as an outage. The door's half runs
 * over the artifact in `standalone-dial-refusal.test.ts`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);
const TLS_SHIM = join(here, "../src/engine/shims/tls.js");

type Refusal = Error & { tlsFailed?: boolean; certificateRefused?: boolean; certificateKind?: string };

/**
 * Android's implicit-TLS dial (993): `TcpSocketModule.connect`'s catch sends the message alone,
 * which for a chain refused under a trusted root is no more than "Chain validation failed"; the
 * patched transport puts every cause into it (`handshakeFailure`).
 */
const DIAL_CHAIN = "Chain validation failed";
const DIAL_EXPIRED = "the TLS handshake failed: javax.net.ssl.SSLHandshakeException: Chain validation failed; "
  + "caused by java.security.cert.CertificateException: Chain validation failed; "
  + "caused by java.security.cert.CertPathValidatorException: timestamp check failed; "
  + "caused by java.security.cert.CertificateExpiredException: Certificate expired at Sat Jan 01 00:00:00 GMT 2022 "
  + "(compared to Fri Oct 23 12:00:00 GMT 2026)";
const DIAL_NOT_YET_VALID = "the TLS handshake failed: javax.net.ssl.SSLHandshakeException: Chain validation failed; "
  + "caused by java.security.cert.CertificateException: Chain validation failed; "
  + "caused by java.security.cert.CertPathValidatorException: timestamp check failed; "
  + "caused by java.security.cert.CertificateNotYetValidException: Certificate not valid until Sat Jan 01 00:00:00 GMT 2050 "
  + "(compared to Fri Oct 23 12:00:00 GMT 2026)";
const DIAL_UNTRUSTED = "the TLS handshake failed: javax.net.ssl.SSLHandshakeException: "
  + "java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.; "
  + "caused by java.security.cert.CertificateException: java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.; "
  + "caused by java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.";
type Shim = {
  connect: (o: Record<string, unknown>) => EventEmitter;
  handshakeRefusal: (e: unknown) => unknown;
};

/** The shim with the native package answered by one emitter this file drives. */
function loadShim(): { tls: Shim; native: () => EventEmitter } {
  let last: EventEmitter | null = null;
  const fake = (): EventEmitter => {
    const e = new EventEmitter() as EventEmitter & Record<string, unknown>;
    Object.assign(e, { write: () => true, destroy: () => undefined, pause: () => undefined, resume: () => undefined });
    last = e;
    return e;
  };
  const Module = req("node:module") as { _load(r: string, p: unknown, m: boolean): unknown };
  const original = Module._load;
  Module._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === "react-native-tcp-socket") {
      return { createConnection: fake, connectTLS: fake, TLSSocket: class {}, isIP: () => 0, isIPv4: () => false, isIPv6: () => false };
    }
    return original.call(this, request, parent, isMain);
  };
  try {
    const cache = (req as unknown as { cache: Record<string, unknown> }).cache;
    for (const key of Object.keys(cache)) {
      if (key.includes("engine/shims/net.js") || key.includes("engine/shims/tls.js")) delete cache[key];
    }
    return { tls: req(TLS_SHIM) as Shim, native: () => last! };
  } finally { Module._load = original; }
}

/** What the bridge emitted for one native error, before or after the handshake completed. */
function emitted(err: unknown, afterHandshake: boolean): unknown {
  const { tls, native } = loadShim();
  const bridge = tls.connect({ host: "mail.example.test", port: 993 });
  const got: unknown[] = [];
  bridge.on("error", (e) => got.push(e));
  if (afterHandshake) native().emit("secureConnect");
  native().emit("error", err);
  return got[0];
}

describe("the TLS shim names a refused certificate", () => {
  const cases: Array<[string, string]> = [
    ["Android, no trust anchor", "java.security.cert.CertPathValidatorException: Trust anchor for certification path not found."],
    ["Android, a name the certificate does not carry", "Hostname mail.example.test not verified:\n    certificate: sha256/AAAA"],
    ["Android, implicit TLS, a chain refused under a trusted root (the module's message alone)", DIAL_CHAIN],
    ["Android, implicit TLS, an expired certificate (the patched transport's causes)", DIAL_EXPIRED],
    ["iOS, an invalid chain", "The operation couldn’t be completed. (kCFStreamErrorDomainSSL error -9807.)"],
    ["iOS, an expired certificate", "The operation couldn’t be completed. (kCFStreamErrorDomainSSL error -9814.)"],
  ];
  for (const [what, message] of cases) {
    it(`before the handshake: ${what}`, () => {
      const e = emitted(message, false) as Refusal;
      expect(e).toBeInstanceOf(Error);
      expect(e.message).toBe(message);
      expect(e.tlsFailed).toBe(true);
      expect(e.certificateRefused).toBe(true);
    });
  }

  it("node's own refusal (the suite's stand-in) keeps its object and gains the two flags", () => {
    const err = Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    const e = emitted(err, false) as Refusal;
    expect(e).toBe(err);
    expect(e.certificateRefused).toBe(true);
  });

  /* The platform's string arrives as an Error carrying its message and errno (`net.js#nativeError`,
     PHONE-NATIVE-SOCKET-ERROR-IS-A-STRING); what these controls hold is that no certificate is read into it. */
  it("CONTROL — a refused connect or a closed handshake is an outage, never a certificate", () => {
    for (const [message, code] of [
      ["failed to connect to /10.0.2.2 (port 993) from /:: (port 0): connect failed: ECONNREFUSED (Connection refused)", "ECONNREFUSED"],
      ["connect timed out", "ETIMEDOUT"],
      ["The operation couldn’t be completed. (kCFStreamErrorDomainSSL error -9806.)", undefined],
      /* The patched dial's line keeps the platform's words, so an outage keeps its errno. */
      ["the TLS handshake failed: java.net.SocketTimeoutException: Read timed out", "ETIMEDOUT"],
      ["the TLS handshake failed: javax.net.ssl.SSLException: Read error: ssl=0x7a1c: I/O error during system call, Connection reset by peer", "ECONNRESET"],
    ] as const) {
      const e = emitted(message, false) as Refusal & { code?: string };
      expect(e, message).toBeInstanceOf(Error);
      expect(e.message).toBe(message);
      expect(e.code).toBe(code);
      expect(e.certificateRefused, message).toBeUndefined();
      expect(e.tlsFailed, message).toBeUndefined();
    }
  });

  it("CONTROL — after the handshake nothing is re-read as a certificate", () => {
    const message = "java.security.cert.CertificateException: a late error naming a certificate";
    const e = emitted(message, true) as Refusal;
    expect(e.message).toBe(message);
    expect(e.certificateRefused).toBeUndefined();
    expect(e.tlsFailed).toBeUndefined();
  });
});

/**
 * AND WHICH REFUSAL IT WAS, where the platform's words say — the desktop probe's vocabulary, so
 * Connect can say what the desktop says. A message no pattern reads keeps the two
 * flags and no kind: the door then says the generic certificate sentence.
 */
describe("the TLS shim names the kind of certificate refusal", () => {
  const cases: Array<[string, string, string | undefined]> = [
    ["Android, no trust anchor", "java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.", "untrusted"],
    ["Android, the reason the patched transport carries", "the TLS upgrade failed: javax.net.ssl.SSLHandshakeException: java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.", "untrusted"],
    ["Android, a name the certificate does not carry (OkHttp's words)", "Hostname mail.example.test not verified:\n    certificate: sha256/AAAA", "hostname_mismatch"],
    ["Android, a name the certificate does not carry (the platform's)", "the TLS upgrade failed: javax.net.ssl.SSLHandshakeException: java.security.cert.CertificateException: No subjectAltNames on the certificate match", "hostname_mismatch"],
    ["Android, an expired certificate", "the TLS upgrade failed: javax.net.ssl.SSLHandshakeException: Chain validation failed; caused by java.security.cert.CertPathValidatorException: timestamp check failed; caused by java.security.cert.CertificateExpiredException: Certificate expired at Sat Jan 01 00:00:00 GMT 2022", "expired"],
    ["Android, a certificate not valid yet", "the TLS upgrade failed: javax.net.ssl.SSLHandshakeException: Chain validation failed; caused by java.security.cert.CertPathValidatorException: timestamp check failed; caused by java.security.cert.CertificateNotYetValidException: Certificate not valid until Sat Jan 01 00:00:00 GMT 2050", "not_yet_valid"],
    ["Android, a chain it says no more about", "java.security.cert.CertPathValidatorException: timestamp check failed", undefined],
    ["Android, implicit TLS, the module's message alone (expired or not valid yet)", DIAL_CHAIN, undefined],
    ["Android, implicit TLS, an expired certificate (the patched transport's causes)", DIAL_EXPIRED, "expired"],
    ["Android, implicit TLS, a certificate not valid yet", DIAL_NOT_YET_VALID, "not_yet_valid"],
    ["Android, implicit TLS, no trust anchor", DIAL_UNTRUSTED, "untrusted"],
    ["iOS, an invalid chain", "The operation couldn’t be completed. (kCFStreamErrorDomainSSL error -9807.)", "untrusted"],
    ["iOS, an unknown root", "The operation couldn’t be completed. (kCFStreamErrorDomainSSL error -9812.)", "untrusted"],
    ["iOS, no root", "The operation couldn’t be completed. (kCFStreamErrorDomainSSL error -9813.)", "untrusted"],
    ["iOS, an expired certificate", "The operation couldn’t be completed. (kCFStreamErrorDomainSSL error -9814.)", "expired"],
    ["iOS, a certificate not valid yet", "The operation couldn’t be completed. (kCFStreamErrorDomainSSL error -9815.)", "not_yet_valid"],
    ["iOS, a name mismatch", "The operation couldn’t be completed. (kCFStreamErrorDomainSSL error -9843.)", "hostname_mismatch"],
    ["iOS, a bad certificate with no reason", "The operation couldn’t be completed. (kCFStreamErrorDomainSSL error -9808.)", undefined],
    ["node, an issuer it cannot find", "unable to get local issuer certificate", "untrusted"],
    ["node, a self-signed certificate", "self-signed certificate", "untrusted"],
  ];
  for (const [what, message, kind] of cases) {
    it(`${what}: ${kind ?? "no kind"}`, () => {
      const e = emitted(message, false) as Refusal;
      expect(e.message).toBe(message);
      expect(e.certificateRefused).toBe(true);
      expect(e.certificateKind).toBe(kind);
    });
  }

  /* The desktop probe's own table (`packages/api/src/imap-probe.ts`), read from its source so a code
     it learns is a code this shim must learn too. Self-signed reads as untrusted: neither platform
     tells the two apart, so the phone has one sentence for both. */
  it("node's codes read as the desktop probe reads them, self-signed as untrusted", () => {
    const probe = readFileSync(join(here, "../../../packages/api/src/imap-probe.ts"), "utf8");
    const table = /const TLS_KIND_BY_CODE[^{]*\{([^}]*)\}/.exec(probe)?.[1] ?? "";
    const desktop = [...table.matchAll(/([A-Z_]+):\s*"([a-z_]+)"/g)].map((m) => [m[1]!, m[2]!] as const);
    expect(desktop.length, "the desktop's table moved").toBeGreaterThanOrEqual(7);
    for (const [code, kind] of desktop) {
      const e = emitted(Object.assign(new Error("the handshake was refused"), { code }), false) as Refusal;
      expect(e.certificateKind, code).toBe(kind === "self_signed" ? "untrusted" : kind);
    }
  });

  it("CONTROL — a refusal that is not about a certificate carries no kind", () => {
    for (const message of [
      "connect timed out",
      "the TLS upgrade failed: java.net.SocketTimeoutException: Read timed out",
      "the TLS handshake failed: java.net.SocketTimeoutException: Read timed out",
    ]) {
      const e = emitted(message, false) as Refusal;
      expect(e.certificateRefused, message).toBeUndefined();
      expect(e.certificateKind, message).toBeUndefined();
    }
  });
});
