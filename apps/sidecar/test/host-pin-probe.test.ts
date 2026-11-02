import { createServer, type Server } from "node:https";
import { X509Certificate, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { TLSSocket } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";

import { buildSelfSignedCert, ensureLanIdentity, type LanIdentity } from "../src/host-lan-tls.js";
import {
  HOST_LEAF_FILE,
  PIN_CHANGED_SENTENCE,
  createHostFetch,
  createPinnedFetch,
  loadHostLeaf,
  pinOfCertificate,
  pinnedIdentity,
  probeHostPin,
  readLoopbackMailCertificate,
} from "../src/host-pin-probe.js";

/**
 * THE CLIENT DOOR'S TRUST, MEASURED AGAINST REAL TLS.
 *
 * Every server below is a real `node:https` listener serving the certificate the HOST door
 * actually generates (`ensureLanIdentity`, unchanged, called here exactly as the host calls it).
 * That matters more than it usually would: the claim under test is "a self-signed leaf passed as
 * `ca` verifies as a chain of one", and a test that built its own certificate could satisfy that
 * claim with a certificate the host will never serve — the host's own carries a critical
 * `basicConstraints` saying it is NOT a certificate authority, which is exactly the property a
 * reader would expect to break this. So the fixture IS the production identity.
 */

const tmp = (): string => mkdtempSync(join(tmpdir(), "ohmail-pin-"));

function identity(): LanIdentity {
  const out = ensureLanIdentity(tmp());
  if (out.kind !== "identity") throw new Error("the fixture could not mint a door identity");
  return out.identity;
}

interface Door {
  port: number;
  /**
   * DECRYPTED application bytes this door received.
   *
   * Counted on `secureConnection` — the TLS socket — and NOT on `connection`. The first spelling
   * of this counted the raw socket and read ZERO for a completed request with a body, because the
   * TLS engine consumes the raw stream and the listener never fires: an assertion that the
   * bootstrap sends nothing would have been vacuous, passing whatever the bootstrap did. There is
   * a positive control below that drives a real request through and requires this to move.
   */
  bytesIn(): number;
  /**
   * TIMES THE CLIENT DIALLED this door — counted on the RAW connection, not on
   * `secureConnection`.
   *
   * The discriminator for two branches that are indistinguishable by their outcome: a recovery
   * that refuses and one that retries with the anchor it already knows is wrong both end in a
   * throw, and the difference between them is a whole extra dial at a machine that has just been
   * refused.
   *
   * ON THE RAW CONNECTION BECAUSE THE INTERESTING DIALS DO NOT FINISH. A client that rejects a
   * certificate tears the socket down mid-verification, and the bootstrap hangs up the moment it
   * has read one — so `secureConnection` counted ZERO for a case with two real dials in it, which
   * is measured rather than reasoned: the first spelling of this counter asserted 2 and read 0.
   * The raw event fires for every dial however the TLS ends, which is the question being asked.
   */
  dials(): number;
  close(): Promise<void>;
}

async function door(
  id: LanIdentity,
  onRequest: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<Door> {
  let bytesIn = 0;
  let dials = 0;
  const server: Server = createServer({ key: id.key, cert: id.cert }, onRequest);
  server.on("connection", () => { dials += 1; });
  server.on("secureConnection", (socket) => {
    socket.on("data", (chunk: Buffer) => { bytesIn += chunk.byteLength; });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    bytesIn: () => bytesIn,
    dials: () => dials,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve(); }); }),
  };
}

const open: Door[] = [];
const stand = async (
  id: LanIdentity,
  onRequest: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void =
    (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"product":"ohmail"}'); },
): Promise<Door> => {
  const d = await door(id, onRequest);
  open.push(d);
  return d;
};

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
});

describe("the pin is derived the same way on both sides of the ceremony", () => {
  it("the fingerprint the host prints in its link is the one the client reads off the wire", () => {
    const id = identity();
    const der = Buffer.from(
      id.cert.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""),
      "base64",
    );
    // The HOST composed `id.fingerprint` from the KEY it generated; the CLIENT composes its pin
    // from the CERTIFICATE that arrives on the wire. One definition, reached two ways — a mutation
    // to either derivation reddens here rather than at somebody's kitchen table.
    expect(pinOfCertificate(der)).toBe(id.fingerprint);
    expect(id.fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("the identity check that replaces the hostname check", () => {
  const derOf = (pem: string): Buffer =>
    Buffer.from(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""), "base64");

  it("ADMITS the key the ceremony carried", () => {
    const id = identity();
    expect(pinnedIdentity(id.fingerprint)("anything", { raw: derOf(id.cert) } as never)).toBeUndefined();
  });

  it("refuses a different key, with the sentence a person reads", () => {
    const paired = identity();
    const other = identity();
    const err = pinnedIdentity(paired.fingerprint)("anything", { raw: derOf(other.cert) } as never);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe(PIN_CHANGED_SENTENCE);
  });

  it("refuses a peer that presented nothing, rather than reading absence as agreement", () => {
    const id = identity();
    expect(pinnedIdentity(id.fingerprint)("anything", {} as never)).toBeInstanceOf(Error);
  });
});

describe("the bootstrap — one unverified handshake, judged against the pin", () => {
  it("accepts the door the link named, keeps its certificate, and sends NOTHING to get there", async () => {
    const id = identity();
    const d = await stand(id);
    const dataDir = tmp();

    const out = await probeHostPin({ host: "127.0.0.1", port: d.port, pin: id.fingerprint, dataDir });

    expect(out.ok, out.ok ? "" : out.message).toBe(true);
    if (!out.ok) return;
    expect(out.pin).toBe(id.fingerprint);
    expect(out.leafPem).toContain("BEGIN CERTIFICATE");
    // THE EFFECT, not the return value: the anchor is on disk where a later launch reads it.
    expect(loadHostLeaf(dataDir)).toBe(out.leafPem);
    expect(existsSync(join(dataDir, HOST_LEAF_FILE))).toBe(true);
    // ZERO APPLICATION BYTES. A peer that fails the pin must learn nothing it could not learn from
    // a port scan, and the pairing token is spent only over the verified connection afterwards.
    expect(d.bytesIn(), "the bootstrap wrote application bytes to an unverified peer").toBe(0);

    // AND THE COUNTER CAN MOVE. Without this the zero above is indistinguishable from a listener
    // that never fires — which is exactly what the first version of this fixture was: it counted
    // the RAW socket, the TLS engine consumed that stream, and a completed POST with a body still
    // read zero. A guard that cannot fire is the same failure as one that fires wrongly.
    const f = createPinnedFetch({ leafPem: out.leafPem, pin: out.pin });
    await (await f(`https://127.0.0.1:${d.port}/hello`)).text();
    expect(d.bytesIn(), "the byte counter never fires, so the zero above proves nothing")
      .toBeGreaterThan(0);
  });

  it("refuses a DIFFERENT key at the same address, and leaves no anchor behind", async () => {
    const paired = identity();
    const impostor = identity();
    expect(impostor.fingerprint).not.toBe(paired.fingerprint);
    // The certificates carry the SAME subject name — `ohmail-desktop-host.invalid` for both — so
    // nothing but the key tells them apart. That is the case the pin exists for.
    const d = await stand(impostor);
    const dataDir = tmp();

    const out = await probeHostPin({ host: "127.0.0.1", port: d.port, pin: paired.fingerprint, dataDir });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("pin_changed");
    expect(out.message).toBe(PIN_CHANGED_SENTENCE);
    // NOTHING PERSISTED — a refused peer must not leave a trust anchor a later connection picks up.
    expect(loadHostLeaf(dataDir)).toBeNull();
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it("says the machine could not be reached when nothing is listening", async () => {
    const id = identity();
    const d = await stand(id);
    const port = d.port;
    await d.close();
    open.length = 0;

    const out = await probeHostPin({ host: "127.0.0.1", port, pin: id.fingerprint, dataDir: tmp(), timeoutMs: 3_000 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("unreachable");
    // The sentence names the machine and what to check, and never the fingerprint.
    expect(out.message).toContain("127.0.0.1");
    expect(out.message).not.toContain(id.fingerprint);
  });
});

describe("the pinned fetch — ordinary verified TLS against one door", () => {
  it("ADMITS the door it was pinned to, and the proof is the answer coming back", async () => {
    const id = identity();
    const d = await stand(id, (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ product: "ohmail", flavor: "desktop-host", path: req.url }));
    });
    const f = createPinnedFetch({ leafPem: id.cert, pin: id.fingerprint });

    const res = await f(`https://127.0.0.1:${d.port}/hello`);

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ product: "ohmail", flavor: "desktop-host", path: "/hello" });
  });

  it("refuses a door whose key is not the pinned one — same address, same certificate name", async () => {
    const paired = identity();
    const impostor = identity();
    const d = await stand(impostor);
    // Pinned to the paired machine's key while the impostor's certificate is what arrives. Both
    // halves are wrong for it: the anchor does not verify the chain, and the pin does not match.
    const f = createPinnedFetch({ leafPem: paired.cert, pin: paired.fingerprint });

    await expect(f(`https://127.0.0.1:${d.port}/hello`)).rejects.toThrow();
  });

  it("refuses the pinned key served under a chain the anchor does not cover", async () => {
    // The OTHER half of the pair: the certificate that arrives IS the pinned one, so the pin
    // comparison would pass — and the anchor is a different machine's, so OpenSSL refuses first.
    // Both checks are load-bearing and this is the case that shows the second one is.
    const paired = identity();
    const other = identity();
    const d = await stand(paired);
    const f = createPinnedFetch({ leafPem: other.cert, pin: paired.fingerprint });

    await expect(f(`https://127.0.0.1:${d.port}/hello`)).rejects.toThrow();
  });

  it("refuses http, which cannot be pinned at all", async () => {
    const id = identity();
    const f = createPinnedFetch({ leafPem: id.cert, pin: id.fingerprint });
    await expect(f("http://127.0.0.1:1/hello")).rejects.toThrow(/https only/);
  });
});

describe("the other computer restarts — its certificate changes and its key does not", () => {
  it("the host rebuilds its certificate every launch, keeping the key: the fact this all turns on", () => {
    const dir = tmp();
    const first = ensureLanIdentity(dir);
    const again = ensureLanIdentity(dir);
    if (first.kind !== "identity" || again.kind !== "identity") throw new Error("no identity");
    // THE KEY IS FOR EVER, THE CERTIFICATE IS NOT. `ensureLanIdentity` mints only on ENOENT and
    // rebuilds the certificate around the stored key with a fresh random serial — deliberately, so
    // a corrupt certificate file costs a rebuild instead of un-pairing a household.
    expect(again.identity.fingerprint).toBe(first.identity.fingerprint);
    expect(again.identity.cert).not.toBe(first.identity.cert);
  });

  it("a cached leaf does NOT cover the new certificate — the failure the recovery exists for", async () => {
    const dir = tmp();
    const before = ensureLanIdentity(dir);
    const after = ensureLanIdentity(dir);
    if (before.kind !== "identity" || after.kind !== "identity") throw new Error("no identity");
    const d = await stand(after.identity);
    // No recovery wired: this is the bare behaviour, and it is why one is needed. Measured rather
    // than assumed — a chain of one is anchored on exact bytes, so the same key in a new wrapper
    // is refused DEPTH_ZERO_SELF_SIGNED_CERT.
    const f = createPinnedFetch({ leafPem: before.identity.cert, pin: before.identity.fingerprint });
    await expect(f(`https://127.0.0.1:${d.port}/hello`)).rejects.toThrow();
  });

  it("recovers by RE-CHECKING THE KEY, and the proof is the answer coming back", async () => {
    const dir = tmp();
    const before = ensureLanIdentity(dir);
    const after = ensureLanIdentity(dir);
    if (before.kind !== "identity" || after.kind !== "identity") throw new Error("no identity");
    const d = await stand(after.identity, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"product":"ohmail","flavor":"desktop-host"}');
    });
    const clientDir = tmp();
    let refreshes = 0;

    const f = createPinnedFetch({
      leafPem: before.identity.cert,
      pin: before.identity.fingerprint,
      refreshLeaf: async () => {
        refreshes += 1;
        // THE RECOVERY IS THE BOOTSTRAP, so the KEY is judged again before anything is sent.
        const out = await probeHostPin({
          host: "127.0.0.1", port: d.port, pin: before.identity.fingerprint, dataDir: clientDir,
        });
        return out.ok ? out.leafPem : null;
      },
    });

    const res = await f(`https://127.0.0.1:${d.port}/hello`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ product: "ohmail", flavor: "desktop-host" });
    expect(refreshes).toBe(1);
    // The fresh leaf is on disk for the next launch, and it is the one being served now.
    expect(loadHostLeaf(clientDir)).toBe(after.identity.cert);

    // AND THE REPAIR IS KEPT: a second request must not re-probe.
    await (await f(`https://127.0.0.1:${d.port}/hello`)).text();
    expect(refreshes, "every request after a restart re-ran the bootstrap").toBe(1);
  });

  it("a CHANGED KEY is refused even with a recovery wired — re-pairing is explicit, never silent", async () => {
    const paired = identity();
    const stranger = identity();
    const d = await stand(stranger);
    const clientDir = tmp();
    let refreshes = 0;

    const f = createPinnedFetch({
      leafPem: paired.cert,
      pin: paired.fingerprint,
      refreshLeaf: async () => {
        refreshes += 1;
        const out = await probeHostPin({
          host: "127.0.0.1", port: d.port, pin: paired.fingerprint, dataDir: clientDir,
        });
        return out.ok ? out.leafPem : null;
      },
    });

    // The recovery RUNS — this is the case that looks identical to a restart from the outside —
    // and the bootstrap refuses on the pin, so nothing is accepted and nothing is written.
    await expect(f(`https://127.0.0.1:${d.port}/hello`)).rejects.toThrow();
    expect(refreshes).toBe(1);
    expect(loadHostLeaf(clientDir), "a stranger's certificate was cached as this door's identity")
      .toBeNull();
    // EXACTLY TWO DIALS: the request that failed, and the bootstrap that judged the key and said
    // no. A third would mean the refusal was retried with the anchor already known to be wrong —
    // the same outcome for the caller, and one more dial at a machine that has just been refused.
    // The count is what tells those two apart; the thrown error does not.
    expect(d.dials(), "the refused recovery was retried anyway").toBe(2);
  });

  it("does not re-probe for a machine that is simply not there", async () => {
    const id = identity();
    const d = await stand(id);
    const port = d.port;
    await d.close();
    open.length = 0;
    let refreshes = 0;

    const f = createPinnedFetch({
      leafPem: id.cert,
      pin: id.fingerprint,
      refreshLeaf: async () => { refreshes += 1; return null; },
    });

    // A refused connection is an answer about the NETWORK. Re-running a handshake ceremony for it
    // would turn a computer that is off into a loop of handshakes against nothing.
    await expect(f(`https://127.0.0.1:${port}/hello`)).rejects.toThrow();
    expect(refreshes, "a connection refusal was treated as a stale certificate").toBe(0);
  });
});

describe("the composed Response is the shape the sidecar's callers are written against", () => {
  it("keeps repeated set-cookie values apart, so a session pair can be lifted from them", async () => {
    const id = identity();
    const d = await stand(id, (_req, res) => {
      res.setHeader("set-cookie", [
        "tf_session=access-abc; Path=/; Expires=Wed, 09 Jun 2027 10:18:14 GMT",
        "tf_refresh=refresh-def; Path=/; Expires=Wed, 09 Jun 2027 10:18:14 GMT",
      ]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const f = createPinnedFetch({ leafPem: id.cert, pin: id.fingerprint });

    const cookies = (await f(`https://127.0.0.1:${d.port}/auth/login`, { method: "POST", body: "{}" }))
      .headers.getSetCookie();

    // TWO values, not one joined string. A cookie's own Expires carries the separator, so a join
    // here is unrecoverable and the sign-in path would read no session at all.
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain("tf_session=access-abc");
    expect(cookies[1]).toContain("tf_refresh=refresh-def");
  });

  it("streams a held response, which is what the wake channel reads", async () => {
    const id = identity();
    let push: ((line: string) => void) | null = null;
    const d = await stand(id, (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": open\n\n");
      push = (line: string) => res.write(line);
    });
    const f = createPinnedFetch({ leafPem: id.cert, pin: id.fingerprint });

    const res = await f(`https://127.0.0.1:${d.port}/events`, { headers: { accept: "text/event-stream" } });
    expect(res.body, "a held response with no body cannot be read for wakes").toBeTruthy();
    const reader = res.body!.getReader();
    const decode = new TextDecoder();

    // THE FIRST CHUNK ARRIVES WHILE THE RESPONSE IS STILL OPEN. A buffering implementation would
    // park here for ever and look exactly like a host that never sends anything.
    const first = await reader.read();
    expect(decode.decode(first.value)).toContain(": open");
    push!("data: sync\n\n");
    const second = await reader.read();
    expect(decode.decode(second.value)).toContain("data: sync");
    await reader.cancel();
  });

  it("carries a body through, and sends the length rather than a chunked frame", async () => {
    const id = identity();
    let seen: { body: string; length: string | undefined; method: string } | null = null;
    const d = await stand(id, (req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString("utf8"); });
      req.on("end", () => {
        seen = { body, length: req.headers["content-length"], method: req.method ?? "" };
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    const f = createPinnedFetch({ leafPem: id.cert, pin: id.fingerprint });

    await f(`https://127.0.0.1:${d.port}/pair/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant: "device-pair", token: "t" }),
    });

    expect(seen).not.toBeNull();
    expect(seen!.method).toBe("POST");
    expect(seen!.body).toBe('{"grant":"device-pair","token":"t"}');
    expect(seen!.length).toBe("35");
  });

  it("answers a 204 without constructing a body the platform refuses", async () => {
    const id = identity();
    const d = await stand(id, (_req, res) => { res.writeHead(204); res.end(); });
    const f = createPinnedFetch({ leafPem: id.cert, pin: id.fingerprint });

    const res = await f(`https://127.0.0.1:${d.port}/devices/x`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });

  it("hands a redirect back rather than chasing it off the pinned door", async () => {
    const id = identity();
    const d = await stand(id, (_req, res) => {
      res.writeHead(307, { location: "https://example.invalid/elsewhere" });
      res.end();
    });
    const f = createPinnedFetch({ leafPem: id.cert, pin: id.fingerprint });

    const res = await f(`https://127.0.0.1:${d.port}/sync`, { method: "POST", body: "{}" });
    // NOT followed: a 3xx is the refusal it is, and the body is not re-sent anywhere.
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://example.invalid/elsewhere");
  });

  it("refuses a body kind it cannot send instead of sending an empty request", async () => {
    const id = identity();
    const f = createPinnedFetch({ leafPem: id.cert, pin: id.fingerprint });
    const form = new URLSearchParams({ a: "b" });
    await expect(f("https://127.0.0.1:1/x", { method: "POST", body: form })).rejects.toThrow(/cannot send/);
  });
});

describe("the dangerous option appears exactly once in this directory", () => {
  const SRC = join(__dirname, "..", "src");
  const sources = readdirSync(SRC).filter((n) => n.endsWith(".ts"));

  it("walked a real file list", () => {
    expect(sources.length).toBeGreaterThan(20);
    expect(sources).toContain("host-pin-probe.ts");
    expect(sources).toContain("cloud-engine.ts");
  });

  it("only host-pin-probe.ts can turn certificate verification off", () => {
    // The whole file, comments included, and that is deliberate: this is not a taste rule about
    // where a word may be written, it is a count of the places a reviewer has to read before
    // believing the client's TLS is verified. A mention in prose is a place to read.
    const holders = sources.filter((n) => readFileSync(join(SRC, n), "utf8").includes("rejectUnauthorized"));
    expect(holders).toEqual(["host-pin-probe.ts"]);
  });

  /**
   * Comments and strings out, so what remains is what the program DOES. Not a general parser and
   * not trying to be: it is the same strip `one-pipeline.test.ts` uses, and its job here is to
   * tell a variable a file NAMES in prose from one it composes.
   */
  const code = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

  it("no source here composes the process-wide trust variable", () => {
    // THE VARIABLE IS PROCESS-WIDE, and this engine also holds a hosted session: a trust anchor
    // for one machine on somebody's LAN must never become one for the account's own service. The
    // pinned anchor is attached to one TLS client and is a value in memory, which is the difference.
    const holders = sources.filter((n) => code(readFileSync(join(SRC, n), "utf8")).includes("NODE_EXTRA_CA_CERTS"));
    expect(holders, "a sidecar source composes NODE_EXTRA_CA_CERTS").toEqual([]);
    // The detector is proven on a planted composition, or "none" is indistinguishable from a
    // strip that ate the whole file.
    expect(code('env.push(pair("NODE_EXTRA_CA_CERTS", ca));')).toContain("NODE_EXTRA_CA_CERTS");
  });

  it("names the files that MENTION it, so a new one has to be classified rather than absorbed", () => {
    // Two files discuss the variable, and both are discussing `apps/desktop/src-tauri/src/config.rs`
    // — the SHELL's environment composition for the self-hosted door, whose sentence the engine's
    // probe has to quote back to an operator. Prose about another process is not this process
    // widening its trust, and pinning the set as an exact list is what keeps that judgement from
    // quietly covering a third file somebody adds.
    const mentions = sources.filter((n) => readFileSync(join(SRC, n), "utf8").includes("NODE_EXTRA_CA_CERTS"));
    expect(new Set(mentions)).toEqual(new Set([
      "cloud-probe.ts",      // the server probe's private-CA refusal names the file to install
      "cloud-origin.ts",     // OPERATOR_CA_FILE's header — the whole private-CA story, named once
      "host-pin-probe.ts",   // this module's header, saying why it is never the mechanism here
      /* The candidate probe's own transport, which exists BECAUSE the variable is read once at
         launch: it loads the operator's authority itself instead, so its header has to say what it
         is replacing. It composes nothing — the case above is what proves that. */
      "operator-ca-fetch.ts",
    ]));
  });
});

/**
 * THE SEAM THE ENGINE ACTUALLY GETS — bootstrap, cache and recovery behind one `fetch`.
 *
 * The engine composes ONE `fetchImpl` and hands it to the bearer client, the mirror, the
 * write-through proxy and the wake channel. That is the property under test here: there is no
 * second way to reach the host, so there is no second place the pin could be forgotten.
 */
describe("createHostFetch", () => {
  it("bootstraps on FIRST USE when nothing is cached, and the proof is the answer", async () => {
    const id = identity();
    const d = await stand(id, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"product":"ohmail","flavor":"desktop-host"}');
    });
    const dataDir = tmp();

    const f = createHostFetch({ origin: `https://127.0.0.1:${d.port}`, pin: id.fingerprint, dataDir });
    const res = await f(`https://127.0.0.1:${d.port}/hello`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ product: "ohmail", flavor: "desktop-host" });
    // …and the certificate is now on disk, so the next launch does not repeat the ceremony.
    expect(loadHostLeaf(dataDir)).toBe(id.cert);
  });

  it("uses the CACHED certificate without dialling twice", async () => {
    const id = identity();
    const d = await stand(id);
    const dataDir = tmp();
    // A returning install: the bootstrap already happened, on some earlier launch.
    await probeHostPin({ host: "127.0.0.1", port: d.port, pin: id.fingerprint, dataDir });
    const before = d.dials();

    const f = createHostFetch({ origin: `https://127.0.0.1:${d.port}`, pin: id.fingerprint, dataDir });
    expect((await f(`https://127.0.0.1:${d.port}/hello`)).status).toBe(200);

    // ONE dial for the request and none for a ceremony that did not need repeating.
    expect(d.dials() - before).toBe(1);
  });

  it("recovers across a restart and KEEPS the repair, rather than re-probing every request", async () => {
    const dir = tmp();
    const before = ensureLanIdentity(dir);
    const after = ensureLanIdentity(dir);
    if (before.kind !== "identity" || after.kind !== "identity") throw new Error("no identity");
    const d = await stand(after.identity);
    const dataDir = tmp();
    /* THE STALE CACHE IS WRITTEN DIRECTLY, and the first spelling of this got it wrong in a way
       worth recording: it ran the bootstrap against the running server, which of course stored the
       certificate that server is CURRENTLY serving — the post-restart one — so the test set up the
       state it meant to arrive at. Seeding is what a returning install actually has on disk. */
    writeFileSync(join(dataDir, HOST_LEAF_FILE), before.identity.cert, { mode: 0o600 });
    expect(loadHostLeaf(dataDir)).toBe(before.identity.cert);

    const f = createHostFetch({
      origin: `https://127.0.0.1:${d.port}`, pin: before.identity.fingerprint, dataDir,
    });
    expect((await f(`https://127.0.0.1:${d.port}/hello`)).status).toBe(200);
    expect(loadHostLeaf(dataDir), "the fresh certificate was not cached").toBe(after.identity.cert);

    const afterFirst = d.dials();
    for (let i = 0; i < 3; i += 1) await (await f(`https://127.0.0.1:${d.port}/hello`)).text();
    // THREE requests, THREE dials at most — the repair is kept. A recovery that only fixed the
    // request it was serving would re-probe every time, which is two dials per request against a
    // machine that has just come back.
    expect(d.dials() - afterFirst).toBeLessThanOrEqual(3);
  });

  it("makes ONE bootstrap serve every request that was in flight", async () => {
    const id = identity();
    const d = await stand(id);
    const dataDir = tmp();
    const f = createHostFetch({ origin: `https://127.0.0.1:${d.port}`, pin: id.fingerprint, dataDir });

    // The pull loop's shape: several requests start together against a host with nothing cached.
    const all = await Promise.all(
      [0, 1, 2, 3].map(() => f(`https://127.0.0.1:${d.port}/hello`).then((r) => r.status)),
    );

    expect(all).toEqual([200, 200, 200, 200]);
    // Four requests plus at most one ceremony. Each starting its own would open a handshake per
    // in-flight request at a machine that is already busy coming back.
    expect(d.dials()).toBeLessThanOrEqual(5);
  });

  it("refuses with a sentence about the OTHER machine when the identity cannot be established", async () => {
    const paired = identity();
    const impostor = identity();
    const d = await stand(impostor);
    const dataDir = tmp();

    const f = createHostFetch({ origin: `https://127.0.0.1:${d.port}`, pin: paired.fingerprint, dataDir });

    // NAMED, not a bare socket error: a person reading this has to be sent to the machine that is
    // wrong, and a transport failure would send them to this one.
    await expect(f(`https://127.0.0.1:${d.port}/hello`)).rejects.toThrow(/identity could not be confirmed/);
    expect(loadHostLeaf(dataDir)).toBeNull();
  });
});

/**
 * A MAIL SERVER ON THIS COMPUTER, READ FOR ITS OWN CERTIFICATE (a gateway such as Proton Mail
 * Bridge). The servers below take STARTTLS for real and count what they are sent: in cleartext only
 * the protocol's own way into TLS, and nothing at all once encrypted — never a credential.
 */
describe("reading a mail server's own certificate on this computer", () => {
  interface MailFake { port: number; cleartext: string[]; encryptedBytes: () => number; close: () => Promise<void> }
  const fakes: MailFake[] = [];
  afterEach(async () => { while (fakes.length > 0) await fakes.pop()!.close(); });

  /** A STARTTLS server for `protocol` serving `tls` (key and certificate PEM). */
  async function mailServer(protocol: "imap" | "smtp", tlsId: { key: string; cert: string }): Promise<MailFake> {
    const cleartext: string[] = [];
    let encrypted = 0;
    const live = new Set<Socket>();
    const server = createNetServer((raw) => {
      live.add(raw);
      raw.on("error", () => { /* the reader hangs up once it has the certificate */ });
      raw.on("close", () => live.delete(raw));
      let buf = "";
      const onData = (chunk: Buffer): void => {
        buf += chunk.toString("latin1");
        let end: number;
        while ((end = buf.indexOf("\r\n")) >= 0) {
          const line = buf.slice(0, end);
          buf = buf.slice(end + 2);
          cleartext.push(line);
          const upgrade = protocol === "imap" ? /^a1 STARTTLS$/i.test(line) : /^STARTTLS$/i.test(line);
          if (protocol === "smtp" && /^EHLO /i.test(line)) raw.write("250-bridge\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n");
          if (upgrade) {
            raw.write(protocol === "imap" ? "a1 OK begin TLS\r\n" : "220 go ahead\r\n");
            raw.removeListener("data", onData);
            const secured = new TLSSocket(raw, { isServer: true, key: tlsId.key, cert: tlsId.cert });
            secured.on("error", () => { /* closed by the reader */ });
            secured.on("data", (d: Buffer) => { encrypted += d.byteLength; });
            return;
          }
        }
      };
      raw.on("data", onData);
      raw.write(protocol === "imap" ? "* OK [CAPABILITY IMAP4rev1 STARTTLS] bridge ready\r\n" : "220 bridge ESMTP ready\r\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const fake: MailFake = {
      port: (server.address() as AddressInfo).port, cleartext, encryptedBytes: () => encrypted,
      close: () => new Promise<void>((resolve) => { for (const s of live) s.destroy(); server.close(() => resolve()); }),
    };
    fakes.push(fake);
    return fake;
  }

  it("IMAP: sends only STARTTLS, nothing once encrypted, and answers the certificate's fingerprint", async () => {
    const id = identity();
    const srv = await mailServer("imap", id);
    const seen = await readLoopbackMailCertificate({ host: "127.0.0.1", port: srv.port, secure: false, protocol: "imap" });
    expect(seen?.sha256).toBe(new X509Certificate(id.cert).fingerprint256);
    expect(seen?.pem).toContain("BEGIN CERTIFICATE");
    expect(srv.cleartext).toEqual(["a1 STARTTLS"]);
    expect(srv.encryptedBytes(), "bytes were written over the unverified connection").toBe(0);
  });

  it("SMTP: sends only EHLO and STARTTLS, nothing once encrypted", async () => {
    const id = identity();
    const srv = await mailServer("smtp", id);
    const seen = await readLoopbackMailCertificate({ host: "localhost", port: srv.port, secure: false, protocol: "smtp" });
    expect(seen?.sha256).toBe(new X509Certificate(id.cert).fingerprint256);
    expect(srv.cleartext).toEqual(["EHLO [127.0.0.1]", "STARTTLS"]);
    expect(srv.encryptedBytes()).toBe(0);
  });

  it("an implicit-TLS server is read with nothing written at all", async () => {
    const id = identity();
    const d = await stand(id);
    const seen = await readLoopbackMailCertificate({ host: "127.0.0.1", port: d.port, secure: true, protocol: "imap" });
    expect(seen?.sha256).toBe(new X509Certificate(id.cert).fingerprint256);
    expect(d.bytesIn()).toBe(0);
  });

  it("refuses an address that is not this computer by its spelling, without dialling it", async () => {
    const id = identity();
    const srv = await mailServer("imap", id);
    for (const host of ["0.0.0.0", "localhost.example.com", "192.168.1.20", "::ffff:127.0.0.1"]) {
      expect(await readLoopbackMailCertificate({ host, port: srv.port, secure: false, protocol: "imap" }), host).toBeNull();
    }
    expect(srv.cleartext).toEqual([]);
  });

  it("answers nothing for a certificate that is not its own signer's, or not valid now", async () => {
    const own = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const forged = new X509Certificate(buildSelfSignedCert(own.publicKey, other.privateKey)).toString();
    const srv = await mailServer("imap", { key: own.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), cert: forged });
    expect(await readLoopbackMailCertificate({ host: "127.0.0.1", port: srv.port, secure: false, protocol: "imap" })).toBeNull();
    const id = identity();
    const later = await mailServer("imap", id);
    expect(await readLoopbackMailCertificate(
      { host: "127.0.0.1", port: later.port, secure: false, protocol: "imap" }, { now: () => new Date("2100-01-02T00:00:00Z") },
    ), "an expired certificate was offered").toBeNull();
  });
});
