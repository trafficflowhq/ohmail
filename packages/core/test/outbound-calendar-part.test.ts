import { describe, it, expect } from "vitest";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { simpleParser } from "mailparser";
import { outboundToMail } from "../src/adapters/imap.js";
import type { OutboundMessage } from "../src/adapters/imap-types.js";
import { invitationReplyText } from "../src/invitation-reply.js";
import { normalizeMime } from "../src/mime.js";

/**
 * AN INVITATION'S ANSWER, AS THE LETTER LEAVES. `outboundToMail` builds the options nodemailer
 * compiles for BOTH the delivery and the Sent copy, so compiling them here is what the adapter
 * sends and files. With a calendar part the letter is two alternatives, the words and the REPLY
 * (`text/calendar; method=REPLY`), and no file; without one the options are what they always were.
 * The Sent copy, read back by the ingest, is the person's own REPLY.
 */

const ME = "mila@lichtgrat.example";
const TEXT = invitationReplyText({
  uid: "kickoff-17@studio.example", recurrenceId: "", sequence: 2, startRaw: "20261201T100000Z",
  startsAt: new Date("2026-12-01T10:00:00Z"), organizer: "giulia@studio.example", invitedAddress: ME,
  answer: "accepted", stamp: new Date("2026-11-15T09:30:12Z"),
})!;

const LETTER: OutboundMessage = {
  from: ME, to: ["giulia@studio.example"], subject: "Accepted", text: `${ME} has accepted this invitation.`,
  messageId: "<answer-1@lichtgrat.example>", inReplyTo: "kickoff-17@studio.example",
};
const DATE = new Date("2026-11-15T09:30:13Z");

const build = async (msg: OutboundMessage): Promise<Buffer> =>
  new MailComposer(outboundToMail(msg, msg.messageId!, DATE)).compile().build();

/** The leaf parts of a compiled letter: each one's type and its decoded text. */
function leaves(raw: Buffer): Array<{ type: string; text: string }> {
  const out: Array<{ type: string; text: string }> = [];
  const walk = (part: string): void => {
    const [head, ...rest] = part.split("\r\n\r\n");
    const body = rest.join("\r\n\r\n");
    const type = /^Content-Type:\s*([^\r\n]*(?:\r\n[ \t][^\r\n]*)*)/im.exec(head!)?.[1]!.replace(/\r\n[ \t]/g, " ") ?? "text/plain";
    const boundary = /boundary="?([^";\r\n]+)"?/i.exec(type)?.[1];
    if (boundary !== undefined) {
      for (const child of body.split(`--${boundary}`).slice(1, -1)) walk(child.replace(/^\r\n/, ""));
      return;
    }
    const encoding = /^Content-Transfer-Encoding:\s*(\S+)/im.exec(head!)?.[1]?.toLowerCase();
    const text = encoding === "base64" ? Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8")
      : encoding === "quoted-printable" ? body.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
        : body;
    out.push({ type: type.toLowerCase(), text: text.replace(/\r\n$/, "") });
  };
  walk(raw.toString("utf8"));
  return out;
}

describe("the letter an answer sends", () => {
  it("is two alternatives, the words and the REPLY, and carries no file", async () => {
    const raw = await build({ ...LETTER, calendar: { method: "REPLY", text: TEXT } });
    const head = raw.toString("utf8").split("\r\n\r\n")[0]!;
    expect(head).toMatch(/^Content-Type: multipart\/alternative;/m);
    const parts = leaves(raw);
    expect(parts.map((p) => p.type.split(";")[0])).toEqual(["text/plain", "text/calendar"]);
    expect(parts[1]!.type).toContain("method=reply");
    expect(parts[1]!.type).toContain("charset=utf-8");
    expect(parts[1]!.text).toBe(TEXT);
    expect(raw.toString("utf8")).not.toMatch(/Content-Disposition: attachment|application\/ics|filename=/i);
    const parsed = await simpleParser(raw);
    expect(parsed.text?.trim()).toBe(LETTER.text);
    // The envelope the mail server is handed: the organizer, and no one else.
    const envelope = new MailComposer(outboundToMail({ ...LETTER, calendar: { method: "REPLY", text: TEXT } }, LETTER.messageId!, DATE))
      .compile().getEnvelope();
    expect(envelope).toEqual({ from: ME, to: ["giulia@studio.example"] });
  });

  it("read back as its Sent copy, it is the person's own REPLY to the invitation", async () => {
    const normalized = await normalizeMime(await build({ ...LETTER, calendar: { method: "REPLY", text: TEXT } }));
    expect(normalized.calendar?.invitation).toMatchObject({
      method: "REPLY", uid: "kickoff-17@studio.example", recurrenceId: "", sequence: 2, attendees: [ME],
      organizer: "giulia@studio.example", reply: { answer: "accepted", at: new Date("2026-11-15T09:30:12Z") },
    });
  });

  it("without a calendar part the options are what they always were", async () => {
    const options = outboundToMail(LETTER, LETTER.messageId!, DATE);
    expect(Object.keys(options).sort()).toEqual(
      ["date", "from", "html", "inReplyTo", "messageId", "references", "subject", "text", "to"],
    );
    expect(leaves(await build(LETTER)).map((p) => p.type.split(";")[0])).toEqual(["text/plain"]);
  });

  it("maps only the method and the text: nothing else of the caller's object reaches nodemailer", () => {
    const hostile = { method: "REPLY", text: TEXT, path: "/etc/passwd", href: "http://169.254.169.254/", raw: "x" } as unknown as OutboundMessage["calendar"];
    const options = outboundToMail({ ...LETTER, calendar: hostile }, LETTER.messageId!, DATE);
    expect(options.alternatives).toEqual([{ contentType: "text/calendar; charset=utf-8; method=REPLY", content: TEXT }]);
  });
});
