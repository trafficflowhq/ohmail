import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { createServer as createTlsServer } from "node:tls";

/** A key and the chain presented with it, the leaf first. */
export type Identity = { readonly key: string; readonly cert: string };

/** A change of protocol, with the two lines that ask for one: the answer a pinned request never takes. */
export const SWITCH = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n";

/** Bytes that are no HTTP answer: no parser takes them. */
export const NOT_HTTP = "\x00\x01 not http\r\n\r\n";

/**
 * A far side of a test's own on 127.0.0.1, raw: it answers a request's first bytes with `act` and ends nothing
 * by itself. With an `identity` it speaks TLS first and presents that chain. `close` ends the listener and every
 * connection it took.
 */
export async function farSide(act: (socket: Socket) => void, identity?: Identity): Promise<{ url: string; close: () => Promise<void> }> {
  const taken: Socket[] = [];
  const answer = (socket: Socket): void => {
    socket.on("error", () => undefined);
    socket.once("data", () => act(socket));
  };
  // A sender's server presents whatever chain it likes, so this one loads any (`SECLEVEL=0` is the far side's own
  // level). The asker's check is the platform's, untouched.
  const server: Server = identity === undefined
    ? createServer(answer)
    : createTlsServer({ ...identity, ciphers: "DEFAULT@SECLEVEL=0" }, answer);
  server.on("connection", (socket: Socket) => taken.push(socket));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `${identity === undefined ? "http" : "https"}://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      for (const socket of taken) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

/** Answers every request head that arrives on `socket` with `body`, on the same connection, and ends nothing by itself. */
export function answerEach(socket: Socket, body: string): void {
  socket.on("error", () => undefined);
  let pending = "";
  socket.on("data", (chunk: Buffer) => {
    pending += chunk.toString("latin1");
    for (let end = pending.indexOf("\r\n\r\n"); end >= 0; end = pending.indexOf("\r\n\r\n")) {
      pending = pending.slice(end + 4);
      socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    }
  });
}

/** The addresses of this machine tried beside 127.0.0.1, in order: a second loopback address, else IPv6's. */
const SECOND_ADDRESSES = ["127.0.0.2", "::1"] as const;

function listen(server: Server, port: number, address: string): Promise<NodeJS.ErrnoException | null> {
  return new Promise((done) => {
    server.once("error", done);
    server.listen(port, address, () => done(null));
  });
}

/** Ends a listener and every connection it took. */
function shut(server: Server, taken: Set<Socket>): Promise<void> {
  for (const socket of taken) socket.destroy();
  return new Promise((done) => server.close(() => done()));
}

/**
 * Two far sides on ONE port of this machine, at 127.0.0.1 and at a second address of its own (127.0.0.2, else ::1),
 * each made by `make` for its address: one name and one port, two addresses. `null` where this machine listens at no
 * second address. `close` ends both and every connection they took.
 */
export async function onOnePort(
  make: (address: string) => Server,
): Promise<{ port: number; addresses: readonly [string, string]; close: () => Promise<void> } | null> {
  const made = (address: string) => {
    const server = make(address);
    const taken = new Set<Socket>();
    server.on("connection", (socket: Socket) => taken.add(socket));
    return { server, taken };
  };
  for (const second of SECOND_ADDRESSES) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const a = made("127.0.0.1");
      if (await listen(a.server, 0, "127.0.0.1")) return null;
      const port = (a.server.address() as AddressInfo).port;
      const b = made(second);
      const refused = await listen(b.server, port, second);
      if (refused === null) {
        return { port, addresses: ["127.0.0.1", second], close: async () => { await shut(a.server, a.taken); await shut(b.server, b.taken); } };
      }
      await shut(a.server, a.taken);
      // Somebody else holds the port at the second address: another port. Any other refusal: no such address here.
      if (refused.code !== "EADDRINUSE") break;
    }
  }
  return null;
}

/** A key and a certificate for `localhost`, made for this run by `openssl` and handed back on its output: none is kept anywhere. */
export function localhostIdentity(): { key: string; cert: string } {
  const out = execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "-", "-out", "-", "-days", "1", "-subj", "/CN=localhost",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const LAST = "-----END CERTIFICATE-----";
  const begin = out.indexOf("-----BEGIN CERTIFICATE-----");
  const end = out.indexOf(LAST, begin) + LAST.length;
  return { cert: `${out.slice(begin, end)}\n`, key: out.slice(0, begin) + out.slice(end) };
}

/**
 * What can be wrong with a chain a sender made under a root of its own, besides the root. The platform refuses each
 * with `UNSPECIFIED`, its code for a fault of a certificate that its table does not name.
 */
export const UNNAMED_CHAIN_FAULTS = [
  "a leaf signed with SHA-1",
  "a root whose name constraints exclude the name",
  "a leaf with a critical extension nobody knows",
] as const;

/**
 * A chain for `localhost` under a root a sender made, the root sent along, with `fault` when one is named. Written
 * and signed in this process for this run: no tool is asked, no file is read, and no key is kept anywhere.
 */
export function sendersChain(fault?: (typeof UNNAMED_CHAIN_FAULTS)[number]): Identity {
  const root = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const leaf = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const rootExtensions = fault === "a root whose name constraints exclude the name" ? [IS_CA, EXCLUDES_LOCALHOST] : [IS_CA];
  const leafExtensions = fault === "a leaf with a critical extension nobody knows"
    ? [NOT_CA, NAMES_LOCALHOST, UNKNOWN_CRITICAL]
    : [NOT_CA, NAMES_LOCALHOST];
  const leafHash = fault === "a leaf signed with SHA-1" ? "sha1" : "sha256";
  return {
    key: leaf.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    cert: certificate("localhost", leaf.publicKey, root.privateKey, leafHash, leafExtensions)
      + certificate(ROOT_NAME, root.publicKey, root.privateKey, "sha256", rootExtensions),
  };
}

// A certificate as RFC 5280 shapes it, in just enough DER (X.690) to write one.

/** One DER element: its tag, its length, its content. */
function der(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  const n = body.length;
  const length = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
}

const sequence = (...content: Buffer[]): Buffer => der(0x30, ...content);

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [40 * first + second];
  for (const arc of rest) {
    const sevens = [arc & 0x7f];
    for (let high = arc >> 7; high > 0; high >>= 7) sevens.unshift((high & 0x7f) | 0x80);
    bytes.push(...sevens);
  }
  return der(0x06, Buffer.from(bytes));
}

const TRUE = der(0x01, Buffer.from([0xff]));
const commonName = (name: string): Buffer => sequence(der(0x31, sequence(oid("2.5.4.3"), der(0x0c, Buffer.from(name)))));
const utcTime = (ms: number): Buffer => der(0x17, Buffer.from(`${new Date(ms).toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`));
const dnsName = (name: string): Buffer => der(0x82, Buffer.from(name));
const extension = (id: string, critical: boolean, value: Buffer): Buffer => sequence(oid(id), ...(critical ? [TRUE] : []), der(0x04, value));

const ROOT_NAME = "a sender's own root";
const IS_CA = extension("2.5.29.19", true, sequence(TRUE));
const NOT_CA = extension("2.5.29.19", true, sequence());
const NAMES_LOCALHOST = extension("2.5.29.17", false, sequence(dnsName("localhost")));
/** Name constraints whose excluded subtrees hold `localhost`. */
const EXCLUDES_LOCALHOST = extension("2.5.29.30", true, sequence(der(0xa1, sequence(dnsName("localhost")))));
const UNKNOWN_CRITICAL = extension("1.2.3.4.5.6.7", true, der(0x0c, Buffer.from("x")));
/** ecdsa-with-SHA256 and ecdsa-with-SHA1. */
const SIGNED_WITH = { sha256: "1.2.840.10045.4.3.2", sha1: "1.2.840.10045.4.1" } as const;

/** One certificate issued by the sender's root, as PEM: valid from an hour ago for a day. */
function certificate(subject: string, key: KeyObject, issuerKey: KeyObject, hash: keyof typeof SIGNED_WITH, extensions: Buffer[]): string {
  const algorithm = sequence(oid(SIGNED_WITH[hash]));
  const serial = randomBytes(8);
  // A positive number with no leading zero byte, as DER writes an integer.
  serial.writeUInt8((serial.readUInt8(0) & 0x7f) | 0x01, 0);
  const now = Date.now();
  const toBeSigned = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    algorithm,
    commonName(ROOT_NAME),
    sequence(utcTime(now - 3_600_000), utcTime(now + 86_400_000)),
    commonName(subject),
    key.export({ type: "spki", format: "der" }),
    der(0xa3, sequence(...extensions)),
  );
  const signed = sequence(toBeSigned, algorithm, der(0x03, Buffer.from([0]), sign(hash, toBeSigned, issuerKey)));
  const lines = signed.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}
