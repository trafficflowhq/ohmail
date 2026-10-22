/**
 * SIGNED LETTERS FOR THE LOCAL DKIM CHECK, made by code the check does not share: nodemailer's own
 * signer (rsa-sha256, relaxed/relaxed) where it can make the shape, and below it a small signer built
 * on nodemailer's canonicalisation helpers and `node:crypto` for the shapes it cannot (simple
 * canonicalisation, EdDSA, sha1, `l=`, `i=`, `x=`). Keys come from a fake lookup that counts.
 */
import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import type { DkimKeyAnswer, DkimKeyLookup } from "../../src/adapters/dkim.js";

const req = createRequire(import.meta.url);
type Signer = { sign(input: Buffer): NodeJS.ReadableStream };
const DKIM = req("nodemailer/lib/dkim/index.js") as new (o: Record<string, unknown>) => Signer;
const { relaxedHeaders } = req("nodemailer/lib/dkim/sign.js") as {
  relaxedHeaders(h: { key: string; line: string }[], names: string): { headers: string; fieldNames: string };
};
const RelaxedBody = req("nodemailer/lib/dkim/relaxed-body.js") as new (o: { hashAlgo: string }) => NodeJS.ReadWriteStream;

export interface RsaKey { kind: "rsa"; privateKey: KeyObject; pem: string; record: string }
export interface EdKey { kind: "ed25519"; privateKey: KeyObject; record: string }

/** An RSA key pair and the TXT record publishing it. */
export function rsaKey(bits = 2048, flags = ""): RsaKey {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: bits });
  const p = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  return {
    kind: "rsa", privateKey, pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    record: `v=DKIM1; k=rsa;${flags ? ` ${flags};` : ""} p=${p}`,
  };
}

/** An Ed25519 key pair and its record: RFC 8463 publishes the bare 32-byte key. */
export function edKey(): EdKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const type = "ed25519";
  return { kind: type, privateKey, record: `v=DKIM1; k=${type}; p=${raw.toString("base64")}` };
}

/** A plain letter, CRLF throughout. `top` lines go above From, `extra` below Subject. */
export function letter(o: {
  from?: string; subject?: string | null; top?: string[]; extra?: string[]; body?: string; messageId?: string;
} = {}): string {
  return [
    ...(o.top ?? []),
    `From: ${o.from ?? "PayPal <service@paypal.com>"}`,
    "To: mila@lichtgrat.example",
    ...(o.subject === null ? [] : [`Subject: ${o.subject ?? "Your receipt"}`]),
    "Date: Thu, 22 Oct 2026 10:00:00 +0000",
    `Message-ID: ${o.messageId ?? "<r1@paypal.com>"}`,
    ...(o.extra ?? []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    o.body ?? "Thank you for your payment.\r\n",
  ].join("\r\n");
}

/** The default header list a fixture signs: nodemailer's own, plus the one-click post it leaves out. */
export const SIGNED = "from:to:subject:date:message-id:mime-version:content-type:list-unsubscribe:list-unsubscribe-post";

/** nodemailer's signer, unchanged: rsa-sha256, relaxed/relaxed, the names it finds of `names`. */
export async function nodemailerSign(raw: string, domain: string, selector: string, key: RsaKey, names = SIGNED): Promise<string> {
  const out: Buffer[] = [];
  const stream = new DKIM({ domainName: domain, keySelector: selector, privateKey: key.pem, headerFieldNames: names })
    .sign(Buffer.from(raw, "latin1"));
  for await (const c of stream) out.push(Buffer.from(c as Buffer));
  return Buffer.concat(out).toString("latin1");
}

interface Field { key: string; line: string }

function split(raw: string): { fields: Field[]; body: string } {
  const end = raw.indexOf("\r\n\r\n");
  const fields: Field[] = [];
  for (const line of raw.slice(0, end).split("\r\n")) {
    if (/^[ \t]/.test(line)) fields[fields.length - 1]!.line += `\r\n${line}`;
    else fields.push({ key: line.slice(0, line.indexOf(":")).trim().toLowerCase(), line });
  }
  return { fields, body: raw.slice(end + 4) };
}

async function relaxedBodyHash(body: string, algo: string): Promise<string> {
  const rb = new RelaxedBody({ hashAlgo: algo });
  const hash = new Promise<string>((res) => rb.on("hash", (h: string) => res(h)));
  rb.on("data", () => undefined);
  const src = new PassThrough();
  src.pipe(rb);
  src.end(Buffer.from(body, "latin1"));
  return hash;
}

function simpleBody(body: string): string {
  let b = body;
  while (b.endsWith("\r\n")) b = b.slice(0, -2);
  return `${b}\r\n`;
}

export interface SignOpts {
  domain: string;
  selector: string;
  key: RsaKey | EdKey;
  a?: "rsa-sha256" | "rsa-sha1" | "ed25519-sha256";
  c?: "relaxed/relaxed" | "simple/simple" | "relaxed/simple" | "simple/relaxed";
  /** Header names to sign, in order; listed once each unless repeated here. */
  h?: string[];
  /** `l=`: sign only this many bytes of the canonical body. */
  l?: number;
  i?: string;
  t?: number;
  x?: number;
  v?: string;
}

/**
 * THE SECOND SIGNER — every tag under the test's control. Headers are taken bottom-up, a name
 * listed but absent contributes nothing (RFC 6376 §5.4.2); the signature is prepended on one line.
 */
export async function testSign(raw: string, o: SignOpts): Promise<string> {
  const a = o.a ?? (o.key.kind === "ed25519" ? "ed25519-sha256" : "rsa-sha256");
  const c = o.c ?? "relaxed/relaxed";
  const [hc, bc] = c.split("/") as ["relaxed" | "simple", "relaxed" | "simple"];
  const algo = a.endsWith("sha1") ? "sha1" : "sha256";
  const { fields, body } = split(raw);
  const names = o.h ?? SIGNED.split(":").filter((n) => fields.some((f) => f.key === n));

  let bh: string;
  if (bc === "simple") {
    const canonBody = simpleBody(body);
    bh = createHash(algo).update(o.l === undefined ? canonBody : canonBody.slice(0, o.l), "latin1").digest("base64");
  } else if (o.l === undefined) {
    bh = await relaxedBodyHash(body, algo);
  } else {
    throw new Error("the fixture signs l= under simple body canonicalisation only");
  }

  const tags = [
    `v=${o.v ?? "1"}`, `a=${a}`, `c=${c}`, `d=${o.domain}`, `s=${o.selector}`,
    ...(o.i !== undefined ? [`i=${o.i}`] : []),
    ...(o.l !== undefined ? [`l=${o.l}`] : []),
    ...(o.t !== undefined ? [`t=${o.t}`] : []),
    ...(o.x !== undefined ? [`x=${o.x}`] : []),
    `h=${names.join(":")}`, `bh=${bh}`, "b=",
  ];
  const sigLine = `DKIM-Signature: ${tags.join("; ")}`;

  let data = "";
  const used = new Set<Field>();
  for (const n of names) {
    for (let k = fields.length - 1; k >= 0; k--) {
      const f = fields[k]!;
      if (f.key !== n || used.has(f)) continue;
      used.add(f);
      data += hc === "simple" ? `${f.line}\r\n` : relaxedHeaders([f], n).headers;
      break;
    }
  }
  data += hc === "simple" ? sigLine : relaxedHeaders([{ key: "dkim-signature", line: sigLine }], "dkim-signature").headers.slice(0, -2);

  const bytes = Buffer.from(data, "latin1");
  const b = o.key.kind === "ed25519"
    ? cryptoSign(null, createHash("sha256").update(bytes).digest(), o.key.privateKey)
    : cryptoSign(algo, bytes, o.key.privateKey);
  return `${sigLine}${b.toString("base64")}\r\n${raw}`;
}

/** A key lookup answering from a table, counting every name it is asked. */
export function fakeKeys(table: Record<string, DkimKeyAnswer | string>): DkimKeyLookup & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async lookup(name: string): Promise<DkimKeyAnswer> {
      calls.push(name);
      const hit = table[name];
      if (hit === undefined) return { kind: "none" };
      return typeof hit === "string" ? { kind: "records", records: [hit] } : hit;
    },
  };
}
