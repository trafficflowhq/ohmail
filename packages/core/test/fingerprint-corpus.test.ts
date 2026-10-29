import { describe, it, expect } from "vitest";
import { normalizeMime } from "../src/mime.js";
import { messageFingerprint } from "../src/identity.js";

/**
 * THE FINGERPRINT DOES NOT MOVE WHEN A CALENDAR PART KEEPS ITS METHOD (ITIP-METHOD-HAS-NO-STORED-HOME).
 * A part's stored `content_type` now carries `method=` for calendar parts, and that field is a
 * fingerprint input: fed raw, every iTIP REPLY re-observed would insert a second `messages` row.
 * The digests below were computed by the code BEFORE the method was kept, one per shape, so a
 * change that moves any stored `fp1` for these shapes reddens here.
 */

const CRLF = (lines: string[]): string => lines.join("\r\n");
const head = (extra: string[]): string[] => [
  "Message-ID: <corpus-1@example.test>", "From: A <a@example.test>", "To: b@example.test",
  "Subject: corpus", "Date: Mon, 14 Sep 2026 10:00:00 +0000", "MIME-Version: 1.0", ...extra,
];

const PNG = ["Content-Type: image/png", "Content-ID: <pic@x>", "Content-Transfer-Encoding: base64", "", "iVBORw0KGgo="];
const PDF = ['Content-Type: application/pdf; name="a.pdf"', 'Content-Disposition: attachment; filename="a.pdf"',
  "Content-Transfer-Encoding: base64", "", "JVBERi0xLjQK"];
const LETTER = '<style>.x{color:red}</style><table><tr><td>Hello</td><td>World</td></tr></table>'
  + '<div>Line one</div><div>Line two</div><img src="cid:pic@x">';

const CORPUS: Record<string, string> = {
  plain: CRLF([...head(["Content-Type: text/plain; charset=utf-8"]), "", "hello", ""]),
  html: CRLF([...head(['Content-Type: text/html; charset="utf-8"']), "", "<p>hello</p>", ""]),
  pdf: CRLF([...head(['Content-Type: multipart/mixed; boundary="B"']), "", "--B", "Content-Type: text/plain", "", "see file",
    "--B", 'Content-Type: Application/PDF; name="a.pdf"', 'Content-Disposition: attachment; filename="a.pdf"',
    "Content-Transfer-Encoding: base64", "", "JVBERi0xLjQK", "--B--", ""]),
  octetNamed: CRLF([...head(['Content-Type: multipart/mixed; boundary="B"']), "", "--B", "Content-Type: text/plain", "", "x",
    "--B", "Content-Type: application/octet-stream", 'Content-Disposition: attachment; filename="photo.png"',
    "Content-Transfer-Encoding: base64", "", "iVBORw0KGgo=", "--B--", ""]),
  inlineImage: CRLF([...head(['Content-Type: multipart/related; boundary="R"']), "", "--R", "Content-Type: text/html", "",
    '<img src="cid:logo@x">', "--R", "Content-Type: image/png", "Content-ID: <logo@x>", "Content-Transfer-Encoding: base64",
    "", "iVBORw0KGgo=", "--R--", ""]),
  calendarRequest: CRLF([...head(['Content-Type: multipart/alternative; boundary="A"']), "", "--A", "Content-Type: text/plain", "",
    "meeting", "--A", "Content-Type: text/calendar; charset=utf-8; method=REQUEST", "", "BEGIN:VCALENDAR", "METHOD:REQUEST",
    "END:VCALENDAR", "--A--", ""]),
  calendarReply: CRLF([...head(['Content-Type: multipart/mixed; boundary="B"']), "", "--B", "Content-Type: text/plain", "", "yes",
    "--B", "Content-Type: text/calendar; method=REPLY; charset=utf-8", 'Content-Disposition: attachment; filename="reply.ics"',
    "", "BEGIN:VCALENDAR", "METHOD:REPLY", "END:VCALENDAR", "--B--", ""]),
  applicationIcs: CRLF([...head(['Content-Type: multipart/mixed; boundary="B"']), "", "--B", "Content-Type: text/plain", "", "x",
    "--B", "Content-Type: application/ics; method=CANCEL", 'Content-Disposition: attachment; filename="c.ics"', "",
    "BEGIN:VCALENDAR", "END:VCALENDAR", "--B--", ""]),
  // Letters with no text part: `textBody` now carries the html's words, and these digests were
  // computed before it did, so the words must not reach the fingerprint.
  relatedHtmlRoot: CRLF([...head(['Content-Type: multipart/related; boundary="R"']), "", "--R", "Content-Type: text/html; charset=utf-8", "",
    LETTER, "--R", ...PNG, "--R--", ""]),
  htmlWithPdf: CRLF([...head(['Content-Type: multipart/mixed; boundary="B"']), "", "--B", "Content-Type: text/html; charset=utf-8", "",
    "<p>See the invoice</p>", "--B", ...PDF, "--B--", ""]),
  emptyTextAlternative: CRLF([...head(['Content-Type: multipart/alternative; boundary="A"']), "", "--A", "Content-Type: text/plain", "", "",
    "--A", "Content-Type: text/html; charset=utf-8", "", "<p>Only the html has words</p>", "--A--", ""]),
  relatedInMixed: CRLF([...head(['Content-Type: multipart/mixed; boundary="B"']), "", "--B", 'Content-Type: multipart/related; boundary="R"', "",
    "--R", "Content-Type: text/html; charset=utf-8", "", LETTER, "--R", ...PNG, "--R--", "", "--B", ...PDF, "--B--", ""]),
  oversizeHtmlRoot: CRLF([...head(["Content-Type: text/html; charset=utf-8"]), "", "<p>Early words</p>" + "<div>x</div>".repeat(90_000), ""]),
};

const GOLDEN: Record<string, string> = {
  plain: "7fad5c7c258db7059c837d025a48f688ad8b1a79e8a7bd3c2dbc4e6682a766d7",
  html: "37d5b2b97fd224ae90b3ed3e7c047882099dd76161fd835f10109a26112f5862",
  pdf: "986d265b3e02f0edf35c8aa42175512c21d8977af3b198615e6bf11bab394660",
  octetNamed: "f67b5079ba6cba9ad4b61c26548843a4af1020a446385cdab6fc8c1cc08f25f7",
  inlineImage: "e34daf87e25bfcc7ed91528e0263d98628d2826e66a226861f9dbe294d4f3160",
  calendarRequest: "16088aaec66b2d62c840d231c4e0f60013f1b92607f9f179bbc3630f6f57a594",
  calendarReply: "0f419646c493f3fcedbed887edb11a7a11e38a72c46507ea482340685091fcbc",
  applicationIcs: "f409b6a99b587afb560320bf254cbf7dae1bf77d95ea314f8622dbfe82419d62",
  relatedHtmlRoot: "3eda3285dbdeb0b56e4151b794481dd1e14038e46a777267d9f448f1ae3ce6da",
  htmlWithPdf: "d03c0e189676114db0ac950fe4a80b510037e3b9c42fcca3792b5a774c3ee47c",
  emptyTextAlternative: "5748f4ac6208e9a35918ce5da8b9171e6bcc813de24fb04c98dc036c9a89ffb5",
  relatedInMixed: "631e99c8ed7b0ae15bef78cc630379bdaca5ff4c8c9735bcd0c39fbbfbec2660",
  oversizeHtmlRoot: "8295671195c502faca99bf9a769e28545ff768013f4091e0bafb1c4b294a4553",
};

describe("fp1 digests over the corpus are the ones the base code computed", () => {
  it.each(Object.keys(CORPUS))("%s", async (name) => {
    const fp = messageFingerprint(await normalizeMime(CORPUS[name]!));
    expect(fp, name).toBe(GOLDEN[name]);
  });

  it("a REPLY part fingerprints the same with and without its stored method", async () => {
    const m = await normalizeMime(CORPUS.calendarReply!);
    expect(m.attachments.map((a) => a.contentType)).toContain("text/calendar; method=REPLY");
    const bare = { ...m, attachments: m.attachments.map((a) => ({ ...a, contentType: a.contentType.split(";")[0]! })) };
    expect(messageFingerprint(m)).toBe(messageFingerprint(bare));
  });

  it("the corpus and the pins are one list", () => {
    expect(Object.keys(GOLDEN).sort()).toEqual(Object.keys(CORPUS).sort());
  });
});
