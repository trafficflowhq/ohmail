import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { createServer, type Server } from "node:https";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCloudSidecar, describeProbeFailure, probeCloudServer, type CloudSidecar,
} from "../src/cloud-engine.js";
import { OPERATOR_CA_FILE } from "../src/cloud-origin.js";
import { cloudConfigFromEnv, configFromEnv } from "../src/main.js";
import { createSidecar, type Sidecar } from "../src/engine.js";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";
import { buildSelfSignedCert, ensureLanIdentity } from "../src/host-lan-tls.js";
import { rootCertificates } from "node:tls";
import {
  createOperatorCaFetch, operatorCa, probeTransport, probeTrustAnchors,
} from "../src/operator-ca-fetch.js";

/**
 * THE PRIVATE-CA TRANSITION — an install that already holds a door and moves to a server that
 * issues its own certificates.
 *
 * The trust for such a server arrives as `cloud-ca.pem` in the data folder, and it used to reach
 * the engine only as `NODE_EXTRA_CA_CERTS` at LAUNCH. A running process cannot be given another
 * root, so the candidate was proved by a process that started before the person chose the door:
 * the probe was refused on trust, and nothing they typed could have fixed it.
 *
 * ── HOW THE FIX IS MEASURED ────────────────────────────────────────────────────────────────────
 *
 * A real HTTPS server presenting a real self-signed certificate, probed twice with nothing
 * changed but the presence of the file. WITHOUT it the refusal is `tls_trust` — nobody vouches
 * for that certificate. WITH it the refusal MOVES to `tls_name`, which is only reachable once the
 * CHAIN has verified: OpenSSL checks the name after the issuer, so the second reading cannot be
 * produced by a transport that did not load the CA. That move is the measurement.
 *
 * The fixture certificate is minted by the repository's own minter, for `localhost` — there is no
 * second certificate builder here, and no committed key.
 */

const dir = mkdtempSync(join(tmpdir(), "ohmail-operator-ca-"));
const certDir = mkdtempSync(join(tmpdir(), "ohmail-operator-ca-cert-"));
const minted = ensureLanIdentity(certDir);
if (minted.kind !== "identity") throw new Error("the fixture could not mint a certificate");
const key = minted.identity.key;
/* THE SAME KEY, A CERTIFICATE FOR `localhost` — so the hostname check can be SATISFIED as well as
   failed, and both readings come from the same server. `ensureLanIdentity` mints for the door's own
   `.invalid` label, which no resolver answers for. */
const cert = pemOf(
  buildSelfSignedCert(createPublicKey(createPrivateKey(key)), createPrivateKey(key), "localhost"),
);

/** DER to PEM. The minter returns DER; `ensureLanIdentity` wraps its own and does not export this. */
function pemOf(der: Buffer): string {
  const b64 = der.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

const GREETING = { product: "ohmail", flavor: "selfhost", needsSetup: false, auth: { totp: true } };

const server: Server = createServer({ key, cert }, (req, res) => {
  res.writeHead(200, { "content-type": "application/json", "x-fixture": "yes" });
  res.end(JSON.stringify(GREETING));
});
const listening = new Promise<number>((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
  rmSync(certDir, { recursive: true, force: true });
});

/** The refusal kind the probe answered with, read off its body. */
async function probeKind(fetchImpl: typeof fetch): Promise<string> {
  const port = await listening;
  const res = await probeCloudServer(`https://127.0.0.1:${port}`, fetchImpl);
  if (res.ok) return "ok";
  const parsed = (await res.json()) as { error: { details: { kind: string } } };
  return parsed.error.details.kind;
}

describe("a candidate with a private CA is probed WITH that CA", () => {
  it("without the file, the probe is refused on TRUST — the state this fixes", async () => {
    expect(operatorCa({ dataDir: dir })).toBeNull();
    expect(await probeKind(probeTransport({ dataDir: dir }))).toBe("tls_trust");
  });

  it("with the file, the refusal MOVES to the NAME — which only a verified chain reaches", async () => {
    writeFileSync(join(dir, OPERATOR_CA_FILE), cert, { mode: 0o600 });
    expect(operatorCa({ dataDir: dir })).toBe(cert);
    /* `tls_name` is unreachable while the issuer is untrusted: OpenSSL answers about the chain
       first. So this reading IS the proof the certificate authority was loaded, in a process that
       was started before the file existed. */
    expect(await probeKind(probeTransport({ dataDir: dir }))).toBe("tls_name");
  });

  it("and the server's greeting comes back whole when the name matches too", async () => {
    /* The success half, which the two refusals above cannot show: the chain verifies, the NAME
       matches, and the transport's own reading of the answer — status, headers, body — is what the
       probe classifies. Without this the response half of the transport would be unmeasured. */
    const port = await listening;
    const res = await probeCloudServer(`https://localhost:${port}`, createOperatorCaFetch(cert));
    expect(res.ok, "the probe did not accept its own certificate authority").toBe(true);
    const parsed = (await res.json()) as { ok: boolean; flavor: string; needsSetup: boolean };
    expect(parsed).toMatchObject({ ok: true, flavor: "selfhost", needsSetup: false });
  });

  it("the operator's authority is ADDED to the system roots, not put in their place", () => {
    /* A fixture that dials its own authority passes either way, so the substitution is measured by
       COUNT: node's `ca` replaces the default set, and an install trusting only the operator would
       refuse every publicly-trusted server — the hosted door included. */
    const anchors = probeTrustAnchors(cert);
    expect(rootCertificates.length).toBeGreaterThan(50);
    expect(anchors).toHaveLength(rootCertificates.length + 1);
    expect(anchors).toContain(rootCertificates[0]);
    expect(anchors[anchors.length - 1]).toBe(cert);
  });

  it("a file that is not a certificate is refused and SAID, not silently ignored", async () => {
    const bad = mkdtempSync(join(tmpdir(), "ohmail-operator-ca-bad-"));
    writeFileSync(join(bad, OPERATOR_CA_FILE), "-----BEGIN CERTIFICATE-----\nnope\n", "utf8");
    const lines: string[] = [];
    expect(operatorCa({ dataDir: bad }, (event) => lines.push(event))).toBeNull();
    expect(lines).toEqual(["cloud_operator_ca_unavailable"]);
    rmSync(bad, { recursive: true, force: true });
  });

  it("no file means the platform's own fetch — a public server is dialled exactly as before", () => {
    const empty = mkdtempSync(join(tmpdir(), "ohmail-operator-ca-none-"));
    /* The positive control on the whole change: the ordinary install's transport is unchanged,
       and it is asserted by IDENTITY rather than by behaviour, so a wrapper that merely behaved
       the same today could not pass for it. */
    expect(probeTransport({ dataDir: empty })).toBe(fetch);
    rmSync(empty, { recursive: true, force: true });
  });

  it("the transport is narrow — one question, and it refuses the rest by name", async () => {
    const dial = createOperatorCaFetch(cert);
    await expect(dial("http://example.com/hello")).rejects.toThrow(/https only/);
    await expect(dial("https://example.com/x", { method: "POST" })).rejects.toThrow(/GET only/);
    await expect(dial("https://example.com/x", { body: "x" })).rejects.toThrow(/no body/);
    await expect(dial(new Request("https://example.com/x"))).rejects.toThrow(/not a Request/);
  });
});

/**
 * ONE FOLDER. The shell composes `<app data>/cloud-ca.pem` into the launch and hands this probe the
 * same path as `OHMAIL_OPERATOR_CA_FILE`; the engine's own data directory is the per-mode one under
 * it, which is where the probe used to look. A file in one folder was honoured at launch and not
 * at probe time, or the other way round, and nothing named either path.
 */
describe("the probe reads the certificate authority from the one folder the shell names", () => {
  /* A fresh install per case: the old-folder line is said once per path, so a shared root would
     let one case swallow the line the next one asks for. */
  const roots: string[] = [];
  const install = (): { dataDir: string; named: string; old: string } => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-operator-ca-root-"));
    roots.push(root);
    const dataDir = join(root, "engine-cloud");
    mkdirSync(dataDir);
    return { dataDir, named: join(root, OPERATOR_CA_FILE), old: join(dataDir, OPERATOR_CA_FILE) };
  };
  /* A second certificate from the same key: parseable, and not the bytes of the first. */
  const elsewhere = pemOf(
    buildSelfSignedCert(createPublicKey(createPrivateKey(key)), createPrivateKey(key), "elsewhere.test"),
  );
  afterAll(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  it("the file in the app's data folder is the one the probe dials with — the row", async () => {
    const at = install();
    writeFileSync(at.named, cert, { mode: 0o600 });
    const place = { dataDir: at.dataDir, operatorCaFile: at.named };
    expect(operatorCa(place)).toBe(cert);
    expect(await probeKind(probeTransport(place))).toBe("tls_name");
  });

  it("the old folder is still read for one release, and says once, by name, which file it used", () => {
    const at = install();
    writeFileSync(at.old, cert, { mode: 0o600 });
    const lines: Array<[string, Record<string, unknown>]> = [];
    const log = (event: string, detail: Record<string, unknown>): void => { lines.push([event, detail]); };
    const place = { dataDir: at.dataDir, operatorCaFile: at.named };
    expect(operatorCa(place, log)).toBe(cert);
    expect(operatorCa(place, log)).toBe(cert);
    expect(lines.map(([event]) => event)).toEqual(["cloud_operator_ca_old_folder"]);
    expect(String(lines[0]![1].reason)).toContain(at.old);
    expect(String(lines[0]![1].reason)).toContain(at.named);
  });

  it("with a file in both folders the named one wins, and the line says the old copy is not read", () => {
    const at = install();
    writeFileSync(at.named, cert, { mode: 0o600 });
    writeFileSync(at.old, elsewhere, { mode: 0o600 });
    const lines: Array<[string, Record<string, unknown>]> = [];
    const place = { dataDir: at.dataDir, operatorCaFile: at.named };
    expect(operatorCa(place, (event, detail) => { lines.push([event, detail]); })).toBe(cert);
    expect(lines.map(([event]) => event)).toEqual(["cloud_operator_ca_old_folder"]);
    expect(String(lines[0]![1].reason)).toContain(at.old);
  });

  it("a file that cannot be read as a certificate is said with the path it was read from", () => {
    const at = install();
    writeFileSync(at.named, "-----BEGIN CERTIFICATE-----\nnope\n", "utf8");
    const lines: Array<[string, Record<string, unknown>]> = [];
    const place = { dataDir: at.dataDir, operatorCaFile: at.named };
    expect(operatorCa(place, (event, detail) => { lines.push([event, detail]); })).toBeNull();
    expect(lines.map(([event]) => event)).toEqual(["cloud_operator_ca_unavailable"]);
    expect(String(lines[0]![1].reason)).toContain(at.named);
  });

  it("the engine takes the path the shell composed", () => {
    const at = install();
    const config = cloudConfigFromEnv({
      OHMAIL_MODE: "cloud",
      OHMAIL_DATA_DIR: at.dataDir,
      OHMAIL_CLOUD_URL: "https://ohmail.example.com/api",
      OHMAIL_MAILBOX_ADDRESS: "someone@example.com",
      OHMAIL_OPERATOR_CA_FILE: at.named,
    });
    expect(config.operatorCaFile).toBe(at.named);
  });

  it("a refusal on trust names the path the probe read", () => {
    const at = install();
    const untrusted = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("UNABLE_TO_GET_ISSUER_CERT_LOCALLY"), {
        code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      }),
    });
    const [message, kind] = describeProbeFailure(untrusted, "https://ohmail.example.com/api/hello", at.named);
    expect(kind).toBe("tls_trust");
    expect(message).toContain(at.named);
  });
});

/**
 * THE SAME TWO FACTS THROUGH THE ROUTE. `POST /cloud/probe` on an engine configured the way the
 * shell configures one: its data directory is `engine-cloud`, and the certificate authority's path
 * is the one beside it. The unit cases above cannot see which place the route hands the transport.
 */
describe("POST /cloud/probe reads the certificate authority from the path the engine was given", () => {
  let engine: CloudSidecar;
  let root = "";
  let named = "";

  beforeAll(async () => {
    root = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-operator-ca-route-"));
    named = join(root, OPERATOR_CA_FILE);
    engine = await createCloudSidecar({
      dataDir: join(root, "engine-cloud"),
      operatorCaFile: named,
      cloudUrl: "https://ohmail.example.com/api",
      address: "someone@example.com",
      keks: { 1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))) },
      pollIntervalMs: 3_600_000,
    });
  }, 60_000);

  afterAll(async () => {
    await engine?.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  const probe = async (): Promise<{ status: number; body: any }> => {
    const port = await listening;
    const res = await engine.handle(new Request("http://sidecar/cloud/probe", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${engine.sessionToken}` },
      body: JSON.stringify({ origin: `https://127.0.0.1:${port}` }),
    }));
    return { status: res.status, body: await res.json() };
  };

  it("with no file, the refusal names the path where the file goes", async () => {
    const out = await probe();
    expect(out.body.error?.details?.kind, JSON.stringify(out.body)).toBe("tls_trust");
    expect(String(out.body.error.message)).toContain(named);
  });

  it("with the file at that path, the chain verifies and the refusal moves to the name", async () => {
    writeFileSync(named, cert, { mode: 0o600 });
    const out = await probe();
    expect(out.body.error?.details?.kind, JSON.stringify(out.body)).toBe("tls_name");
  });
});

/**
 * THE LOCAL ENGINE ANSWERS THE SAME CHECK, FROM THE SAME PATH. A desktop on the local door asks
 * its running engine about a self-hosted server; it read the authority from its own data folder
 * while the cloud engine the door then starts reads the shell's path, so a check could admit a
 * server the chosen door could not verify.
 */
describe("the local engine's check reads the path the engine was given", () => {
  let engine: Sidecar;
  let root = "";
  let named = "";

  beforeAll(async () => {
    root = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-operator-ca-local-"));
    named = join(root, OPERATOR_CA_FILE);
    engine = await createSidecar({
      dataDir: await freshDataDir("ohmail-operator-ca-local-store-"),
      operatorCaFile: named,
      address: "owner@trafficflow.test",
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
      pollIntervalMs: 3_600_000,
      vitalsIntervalMs: 3_600_000,
      profileFlushIntervalMs: 3_600_000,
      adapterFactory: () => ({ close: async () => undefined }) as unknown as MailboxAdapter,
      searchBackfillTiming: { waitMs: 3_600_000 },
    });
  }, PGLITE_STANDUP_BUDGET_MS * 2);

  afterAll(async () => {
    await engine?.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  const probe = async (): Promise<{ status: number; body: any }> => {
    const port = await listening;
    const res = await engine.handle(new Request("http://sidecar/cloud/probe", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${engine.sessionToken}` },
      body: JSON.stringify({ origin: `https://127.0.0.1:${port}` }),
    }));
    return { status: res.status, body: await res.json() };
  };

  it("with no file, the refusal names the shell's path", async () => {
    const out = await probe();
    expect(out.body.error?.details?.kind, JSON.stringify(out.body)).toBe("tls_trust");
    expect(String(out.body.error.message)).toContain(named);
  });

  it("with the file at that path, the chain verifies and the refusal moves to the name", async () => {
    writeFileSync(named, cert, { mode: 0o600 });
    const out = await probe();
    expect(out.body.error?.details?.kind, JSON.stringify(out.body)).toBe("tls_name");
  });

  it("the local launch takes the path the shell composed", () => {
    const config = configFromEnv({
      OHMAIL_DATA_DIR: root, OHMAIL_IMAP_HOST: "imap.invalid", OHMAIL_IMAP_USER: "u",
      OHMAIL_OPERATOR_CA_FILE: ` ${named} `,
    });
    expect(config.operatorCaFile).toBe(named);
  });
});
