import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { Agent, request as httpsRequest } from "node:https";
import { join } from "node:path";
import { Readable } from "node:stream";
import { rootCertificates } from "node:tls";

import { OPERATOR_CA_FILE } from "./cloud-origin.js";
import type { Diagnostic } from "./log.js";

/**
 * THE OPERATOR'S OWN CERTIFICATE AUTHORITY, ACTIVE IN THE PROCESS THAT IS DOING THE PROBING. A
 * self-hosted server usually issues its own certificates, trusted by a `cloud-ca.pem` in the app's
 * data folder. That file used to reach the engine only as `NODE_EXTRA_CA_CERTS` at LAUNCH, so an
 * install moving to a private-CA server probed through the already-running engine — started before
 * the door was chosen — and failed on a trust nothing typeable could fix. So the CANDIDATE probe
 * reads the file at probe time and adds it to the system roots for that one connection, verifying
 * just as strictly and widening only WHO may vouch. Nothing here can turn a check off; the word for
 * doing so lives in one other file in this directory, which `host-pin-probe.test.ts` counts.
 */

/**
 * WHERE THE FILE IS. The shell resolves the one path (`config.rs`'s `operator_ca_file`) and hands
 * it over as `OHMAIL_OPERATOR_CA_FILE`, so the probe reads the file the launch composes. Absent on
 * an engine started by hand, which reads its own data directory as it always did.
 */
interface OperatorCaPlace {
  dataDir: string;
  operatorCaFile?: string;
}

/**
 * The file to read, and the folder read for ONE more release: the engine's own data directory,
 * where this probe looked before it was handed the path. `oldFile` is null when the two are one.
 */
export function operatorCaFiles(place: OperatorCaPlace): { file: string; oldFile: string | null } {
  const inDataDir = join(place.dataDir, OPERATOR_CA_FILE);
  const file = place.operatorCaFile?.trim() || inDataDir;
  return { file, oldFile: file === inDataDir ? null : inDataDir };
}

/** Old-folder paths already said by this process: a door walk probes more than once. */
const oldFolderSaid = new Set<string>();

/** How long a probe connection waits. The caller's own deadline bounds the request above this. */
const CONNECT_TIMEOUT_MS = 12_000;

/** The file's text, or null when there is no file to read. */
function readPem(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * The operator's CA, or null when there is none to load. A file that is absent is the ordinary
 * case and says nothing; a file that is present and unusable is LOGGED with its path, because
 * somebody put it there on purpose and a silent fallback would send them to check their server.
 * The named file wins over the old folder's copy, and an old-folder copy is said once, by name.
 */
export function operatorCa(place: OperatorCaPlace, log?: Diagnostic): string | null {
  const { file, oldFile } = operatorCaFiles(place);
  const named = readPem(file);
  const old = oldFile === null ? null : readPem(oldFile);
  const used = named !== null ? file : old !== null ? oldFile : null;
  const pem = named ?? old;
  if (used === null || pem === null) return null;
  if (oldFile !== null && old !== null && log && !oldFolderSaid.has(oldFile)) {
    oldFolderSaid.add(oldFile);
    log("cloud_operator_ca_old_folder", {
      reason: used === oldFile
        ? `${OPERATOR_CA_FILE} was read from ${oldFile}, a folder this version reads for one more ` +
          `release; move it to ${file}`
        : `${file} is used and the copy in ${oldFile} is not read; that copy can be removed`,
    });
  }
  try {
    /* PARSED, not pattern-matched: a truncated or PEM-looking file handed to the TLS agent throws
       inside the handshake, where the refusal a person reads is about their server. */
    new X509Certificate(pem);
  } catch {
    log?.("cloud_operator_ca_unavailable", {
      reason: `${used} could not be read as a certificate, so it is not being used to check the ` +
        "server's identity",
    });
    return null;
  }
  return pem;
}

/**
 * WHO MAY VOUCH FOR THE CANDIDATE — the system roots PLUS the operator's certificate authority.
 *
 * Written out as its own function because `ca` REPLACES the default set rather than extending it,
 * so the wrong line here (`ca: [caPem]`) is one character shorter and makes this transport refuse
 * every publicly-trusted server — including the hosted service, which the same door can be pointed
 * at. A fixture dialling its own authority cannot tell the two apart; the list can be counted.
 */
/**
 * A `fetch` for ONE question — the probe's `GET /hello` — that verifies against the system roots
 * plus `caPem`.
 *
 * GET only, https only, no body, no redirects: this is not a general transport and a narrow one
 * cannot be quietly reused for a request that carries a credential. Anything else is refused by
 * name rather than half-sent.
 */
export function probeTrustAnchors(caPem: string): readonly string[] {
  return [...rootCertificates, caPem];
}

export function createOperatorCaFetch(caPem: string): typeof fetch {
  const agent = new Agent({ ca: [...probeTrustAnchors(caPem)], keepAlive: false });

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : null;
    if (url === null) throw new TypeError("the probe transport takes a URL, not a Request object");
    if (url.protocol !== "https:") {
      throw new TypeError(`the probe transport is https only; refused ${url.protocol}//`);
    }
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") throw new TypeError(`the probe transport is GET only; refused ${method}`);
    if (init?.body) throw new TypeError("the probe transport sends no body");

    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const incoming = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const req = httpsRequest(
        url,
        { method: "GET", agent, headers, timeout: CONNECT_TIMEOUT_MS, ...(init?.signal ? { signal: init.signal } : {}) },
        resolve,
      );
      req.on("error", reject);
      /* A TIMEOUT IS NOT AN ERROR EVENT on `http.ClientRequest` — the socket goes quiet and the
         promise would never settle. Destroying it raises the error the caller classifies. */
      req.on("timeout", () => req.destroy(Object.assign(new Error("probe timed out"), { code: "ETIMEDOUT" })));
      req.end();
    });

    const out = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) for (const one of value) out.append(name, one);
      else if (typeof value === "string") out.append(name, value);
    }
    const status = incoming.statusCode ?? 502;
    const bodyless = status === 204 || status === 205 || status === 304;
    if (bodyless) incoming.resume();
    return new Response(bodyless ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>), {
      status,
      headers: out,
    });
  };
}

/**
 * The transport a CANDIDATE probe should dial with: the operator's CA when one is installed, and
 * the platform's `fetch` when there is none. Read at PROBE TIME — the whole point is that this
 * process may have started before the file existed.
 */
export function probeTransport(place: OperatorCaPlace, log?: Diagnostic): typeof fetch {
  const ca = operatorCa(place, log);
  return ca === null ? fetch : createOperatorCaFetch(ca);
}
