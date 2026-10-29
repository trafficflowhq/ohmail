import { describe, it, expect } from "vitest";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { outboundToMail } from "../src/adapters/imap.js";
import type { OutboundMessage } from "../src/adapters/imap-types.js";

/**
 * THE BCC-ENVELOPE-ONLY INVARIANT, WATCHED WITHOUT A SOCKET.
 *
 * A Bcc recipient must be DELIVERED (they are on the SMTP RCPT list) and INVISIBLE (their address
 * appears in no header of the delivered message, and no header of the Sent-folder copy). A Cc
 * recipient is the opposite of invisible — a `Cc:` header on both. This is the one correctness
 * property a Bcc feature exists to keep: a leak here forwards the blind list to everyone on the
 * message.
 *
 * `outboundToMail` is the pure `OutboundMessage → nodemailer options` map pulled out of
 * `ImapAdapter.send`, and `send` compiles the SAME options for BOTH the SMTP delivery (via
 * `sendMail`, whose envelope is to+cc+bcc) and the Sent append (via `buildRaw`). So compiling it
 * here and reading the envelope and the header bytes is exactly what the adapter does — the only
 * thing not exercised is the socket, which cannot change what the bytes say.
 *
 * ── MUTATION-WATCHED ────────────────────────────────────────────────────────────────────
 *
 * Dropping `bcc` from `outboundToMail` was watched RED here (the envelope loses the two blind
 * recipients — the "envelope carries everyone" case fails, which in production is a bcc silently
 * NOT delivered) and restored to green.
 *
 * The Bcc-HEADER absence, by contrast, is STRUCTURAL and cannot be flipped from `outboundToMail`:
 * `MailComposer` never passes `keepBcc` to its root MimeNode, and MimeNode's build skips the Bcc
 * header whenever `keepBcc` is false — which is always, on this Sent-append path. Setting
 * `keepBcc: true` on the mail options is therefore a no-op through this builder (verified: the
 * header assertions stay green with it set). So these header assertions are a LOCK on that
 * structural property: they go red the day the Sent copy is built by some other path — a
 * hand-assembled MIME message, a `keepBcc`-enabled MimeNode, a raw string with a `Bcc:` line — any
 * of which would put the blind list into the sender's Sent folder and, if reused for the wire,
 * into every recipient's copy.
 */

const HEADER_END = /\r\n\r\n/;

function compiled(msg: OutboundMessage) {
  return new MailComposer(outboundToMail(msg, "<mid-1@trafficflow.test>", new Date())).compile();
}

function rawOf(msg: OutboundMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    compiled(msg).build((err: Error | null, buf: Buffer) => {
      if (err) reject(err);
      else resolve(buf.toString("utf8"));
    });
  });
}

/** Just the header block — the body could legitimately mention an address and is not the subject. */
function headersOf(raw: string): string {
  return raw.split(HEADER_END)[0]!;
}

const base: OutboundMessage = {
  from: "me@trafficflow.test",
  to: ["to@example.test"],
  cc: ["cc@example.test"],
  bcc: ["bcc-one@example.test", "bcc-two@example.test"],
  subject: "quarterly numbers",
  text: "see attached",
};

describe("cc is a header, bcc is envelope-only", () => {
  it("the SMTP envelope (RCPT list) carries To, Cc AND Bcc — every recipient is delivered", () => {
    const envelope = compiled(base).getEnvelope() as { from: string; to: string[] };
    // nodemailer flattens to+cc+bcc into the RCPT list. Every one of these must be a recipient, or
    // the blind copies never leave the building.
    expect(envelope.to).toContain("to@example.test");
    expect(envelope.to).toContain("cc@example.test");
    expect(envelope.to).toContain("bcc-one@example.test");
    expect(envelope.to).toContain("bcc-two@example.test");
    expect(envelope.to).toHaveLength(4);
  });

  it("the built message carries a Cc header and NO Bcc header, and never names a bcc recipient", async () => {
    const headers = headersOf(await rawOf(base));

    // Cc is visible — the header is present and names the cc recipient.
    expect(headers).toMatch(/^cc:/im);
    expect(headers).toContain("cc@example.test");

    // Bcc is invisible — no `Bcc:` header line, and neither blind address appears in the headers at
    // all (a `Bcc:` OR a stray `To:`/`Cc:` listing them would both be a leak).
    expect(headers).not.toMatch(/^bcc:/im);
    expect(headers).not.toContain("bcc-one@example.test");
    expect(headers).not.toContain("bcc-two@example.test");
  });

  it("the Sent-folder copy is built from the same options, so it leaks no bcc either", async () => {
    // `ImapAdapter.send` appends `buildRaw(mail)` to Sent — the very bytes this produces. A sender
    // reviewing their own Sent folder sees the Cc but not who they blind-copied, which is correct.
    const raw = await rawOf(base);
    const headers = headersOf(raw);
    expect(headers).toContain("cc@example.test");
    expect(headers).not.toMatch(/^bcc:/im);
    expect(headers).not.toContain("bcc-one@example.test");
  });

  it("a plain send with no cc/bcc builds no Cc/Bcc header and a single-recipient envelope", async () => {
    const plain: OutboundMessage = { from: base.from, to: ["only@example.test"], subject: "x", text: "y" };
    const envelope = compiled(plain).getEnvelope() as { to: string[] };
    expect(envelope.to).toEqual(["only@example.test"]);
    const headers = headersOf(await rawOf(plain));
    expect(headers).not.toMatch(/^cc:/im);
    expect(headers).not.toMatch(/^bcc:/im);
  });
});

/**
 * `outboundToMail` MAPS ATTACHMENTS ONTO THE ONE MESSAGE, so the SMTP delivery and the
 * Sent-folder append (both `buildRaw` of these same options — see the header above) carry the file
 * from a single assembly. This is the passthrough the SEND-path plumbing depends on; the bytes it
 * carries are never persisted (the zero-at-rest half is asserted in the client-engine send suite).
 *
 * Mutation-watched: gate the `attachments` map in `outboundToMail` behind `false` and the
 * multipart/mixed, the filename and the base64-content assertions all go red — a compiled message
 * that is a bare `text/plain` with the file dropped, which in production is a send that silently
 * loses its attachment.
 */
describe("attachments ride the one compiled message", () => {
  const withFile: OutboundMessage = {
    from: base.from,
    to: ["only@example.test"],
    subject: "here it is",
    text: "see attached",
    attachments: [{
      filename: "note.txt",
      contentType: "text/plain",
      content: new TextEncoder().encode("attach-me-payload"),
    }],
  };

  it("builds a multipart/mixed carrying the filename and the file's bytes", async () => {
    const raw = await rawOf(withFile);
    expect(headersOf(raw)).toMatch(/content-type:\s*multipart\/mixed/i);
    expect(raw).toContain("note.txt");
    expect(raw).toMatch(/content-disposition:\s*attachment/i);
    // The part body is the base64 of the content; short enough not to be line-wrapped.
    expect(raw).toContain(Buffer.from("attach-me-payload").toString("base64"));
  });

  it("a forwarded inline part keeps its Content-ID so the quoted body's cid: refs resolve", async () => {
    const inline: OutboundMessage = {
      ...withFile,
      html: '<p>see <img src="cid:logo-1"></p>',
      attachments: [{
        filename: "logo.png",
        contentType: "image/png",
        content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        cid: "logo-1",
      }],
    };
    const raw = await rawOf(inline);
    expect(raw).toMatch(/content-id:\s*<logo-1>/i);
  });

  it("a send with no attachments builds no multipart/mixed", async () => {
    const raw = await rawOf({ from: base.from, to: ["x@example.test"], subject: "s", text: "t" });
    expect(headersOf(raw)).not.toMatch(/multipart\/mixed/i);
  });
});
