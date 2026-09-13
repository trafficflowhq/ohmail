import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { Agent, request as httpsRequest } from "node:https";
import { join } from "node:path";
import { Readable } from "node:stream";
import { rootCertificates } from "node:tls";

import { OPERATOR_CA_FILE } from "./cloud-origin.js";
import type { Diagnostic } from "./log.js";

/**
 * THE OPERATOR'S OWN CERTIFICATE AUTHORITY, ACTIVE IN THE PROCESS THAT IS DOING THE PROBING.
 *
 * A self-hosted server usually issues its own certificates, and the way somebody tells this app to
 * trust theirs is a file named `cloud-ca.pem` in the data folder. Until now that file reached the
 * engine only as `NODE_EXTRA_CA_CERTS` at LAUNCH — which closes a fresh install and leaves the
 * TRANSITION open: an install that already holds a door and moves to a private-CA server probes
 * the candidate through the engine that is already running, and that process started before the
 * person chose the door. The probe failed on trust, and nothing they could type would have helped,
 * because a running Node cannot be given another root.
 *
 * So the CANDIDATE probe carries its own trust instead of borrowing the launch environment's: the
 * file is read at probe time and added to the system roots for that connection. Verification stays
 * exactly as strict — every default check runs, the hostname included — and this widens only WHO
 * may vouch for the certificate. Nothing here can turn a check off, and the word for doing so
 * appears in one file in this directory, which is not this one (`host-pin-probe.test.ts` counts).
 */

/** How long a probe connection waits. The caller's own deadline bounds the request above this. */
const CONNECT_TIMEOUT_MS = 12_000;

/**
 * The operator's CA, or null when there is none to load. A file that is absent is the ordinary
 * case and says nothing; a file that is present and unusable is LOGGED, because somebody put it
 * there on purpose and a silent fallback would send them to check their server instead of the file.
 */
export function operatorCa(dataDir: string, log?: Diagnostic): string | null {
  let pem: string;
  try {
    pem = readFileSync(join(dataDir, OPERATOR_CA_FILE), "utf8");
  } catch {
    return null;
  }
  try {
    /* PARSED, not pattern-matched: a truncated or PEM-looking file handed to the TLS agent throws
       inside the handshake, where the refusal a person reads is about their server. */
    new X509Certificate(pem);
  } catch {
    log?.("cloud_operator_ca_unusable", {
      reason: "a certificate authority file is present in this app's data folder but could not be " +
        "read as a certificate, so it is not being used to check the server's identity",
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
export function probeTransport(dataDir: string, log?: Diagnostic): typeof fetch {
  const ca = operatorCa(dataDir, log);
  return ca === null ? fetch : createOperatorCaFetch(ca);
}
