import { describe, it, expect } from "vitest";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import DataStream from "nodemailer/lib/smtp-connection/data-stream.js";
import { outboundToMail } from "../src/adapters/imap.js";
import type { OutboundMessage } from "../src/adapters/imap-types.js";

/**
 * A FORWARDED message/* PART LEAVES BASE64. From nodemailer 7 a message/* attachment goes out 8bit,
 * as it is, and a forward re-attaches a third party's bytes: a NUL, a bare CR and a line over 998
 * octets then reach SMTP DATA and the Sent copy unencoded. Composed as `buildRaw` composes and
 * framed by nodemailer's own DATA stream, as `sendMail` frames it. Watched red with the encoding
 * dropped from `outboundToMail`'s attachment map (the part read 8bit, the NUL reached DATA).
 */

const ORIGINAL = Buffer.concat([
  Buffer.from("From: a@example.test\r\nSubject: inner\r\n\r\nfirst\rsecond\r\n", "latin1"),
  Buffer.from([0x00, 0xe9]),
  Buffer.from(`\r\n${"A".repeat(1200)}\r\nend\r\n`, "latin1"),
]);

const forward: OutboundMessage = {
  from: "me@trafficflow.test",
  to: ["friend@example.test"],
  subject: "Fwd: outer",
  text: "see below",
  attachments: [{ filename: "fwd.eml", contentType: "message/rfc822", content: new Uint8Array(ORIGINAL) }],
};

function sentCopy(msg: OutboundMessage): Promise<Buffer> {
  const mail = outboundToMail(msg, "<fwd-1@trafficflow.test>", new Date());
  return new Promise((resolve, reject) => {
    new MailComposer({ ...mail, disableFileAccess: true, disableUrlAccess: true }).compile()
      .build((err: Error | null, raw: Buffer) => (err ? reject(err) : resolve(raw)));
  });
}

function onTheWire(raw: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const data = new DataStream();
    const out: Buffer[] = [];
    data.on("data", (chunk: Buffer) => out.push(chunk));
    data.on("end", () => resolve(Buffer.concat(out)));
    data.on("error", reject);
    data.end(raw);
  });
}

/** The forwarded part's own headers and body, read off the composed message. */
function forwardedPart(raw: Buffer): { headers: string; body: string } {
  const s = raw.toString("latin1");
  const at = s.indexOf("Content-Type: message/rfc822");
  expect(at, "the composed message carries no message/rfc822 part").toBeGreaterThan(-1);
  const bodyAt = s.indexOf("\r\n\r\n", at);
  return { headers: s.slice(at, bodyAt), body: s.slice(bodyAt + 4, s.indexOf("\r\n--", bodyAt)) };
}

describe("a forwarded message/rfc822 part", () => {
  it("goes out base64, so no NUL, bare CR or line over 998 octets reaches DATA or the Sent copy", async () => {
    const raw = await sentCopy(forward);
    const wire = await onTheWire(raw);
    const text = wire.toString("latin1");
    expect(forwardedPart(raw).headers).toMatch(/Content-Transfer-Encoding: base64/);
    expect(raw.includes(0x00), "a NUL in the Sent copy").toBe(false);
    expect(wire.includes(0x00), "a NUL in SMTP DATA").toBe(false);
    expect(text.match(/\r(?!\n)/g) ?? [], "a bare CR in SMTP DATA").toEqual([]);
    expect(Math.max(...text.split("\r\n").map((line) => line.length)), "the longest DATA line").toBeLessThanOrEqual(998);
  });

  it("decodes back to the forwarded bytes, every one of them", async () => {
    const { body } = forwardedPart(await sentCopy(forward));
    expect(Buffer.from(body.replace(/\s+/g, ""), "base64").equals(ORIGINAL)).toBe(true);
  });

  it("is asked of every message/* type in any case, and of no other type", () => {
    const types = ["message/rfc822", "Message/RFC822", "message/global", "message/delivery-status", "text/plain", "application/octet-stream", "image/png"];
    const mail = outboundToMail({ ...forward, attachments: types.map((contentType, i) => ({ filename: `p${i}`, contentType, content: new Uint8Array([0x41]) })) }, "<fwd-2@trafficflow.test>", new Date());
    const asked = (mail.attachments ?? []).map((a) => [a.contentType, a.contentTransferEncoding ?? "nodemailer's own"]);
    expect(asked).toEqual([
      ["message/rfc822", "base64"], ["Message/RFC822", "base64"], ["message/global", "base64"], ["message/delivery-status", "base64"],
      ["text/plain", "nodemailer's own"], ["application/octet-stream", "nodemailer's own"], ["image/png", "nodemailer's own"],
    ]);
  });
});
