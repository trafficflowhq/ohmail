import { describe, it, expect } from "vitest";
import { classifySensitivity } from "../src/sensitive.js";
import type { NormalizedMessage } from "../src/types.js";
import {
  BUSINESS_CORPUS, DOCUMENTS_CARRYING_A_CODE, LONG_NOTICES, LONG_SENSITIVE,
  businessMessage, noticeMessage,
} from "./fixtures/sensitive-business-corpus.js";

/**
 * A long document is not a one-time code. A fiduciary's tax return for review read `otp`, so it
 * was prioritised, Forward asked about it and AI was off for it. Every document below read
 * `sensitive` before this change (30 of 30) because it MENTIONS a code, a PIN or "bestätigen Sie
 * Ihre"; a mention is not a delivery. The positive half is asserted from the same file: real
 * code, reset, alert and verification mail stays `sensitive` at 72–261 words.
 */
describe("long business mail reads ordinary", () => {
  it.each(BUSINESS_CORPUS.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const r = classifySensitivity(businessMessage(c));
    expect(r.verdict, `${c.id} → ${r.category ?? r.reasons.join(",")}`).toBe("ordinary");
    expect(r.reasons).toEqual([]);
    expect(r.flags).toEqual({ no_ai: false, no_forward: false, no_kb: false, priority: false });
  });

  it("covers seven kinds of business mail in four languages", () => {
    const cells = new Set(BUSINESS_CORPUS.map((c) => `${c.category}/${c.lang}`));
    expect(cells.size).toBe(7 * 4);
  });
});

describe("real sensitive mail stays sensitive at any length", () => {
  it.each(LONG_SENSITIVE.map((c) => [c.id, c] as const))("long: %s", (_id, c) => {
    const r = classifySensitivity(noticeMessage(c));
    expect(r.verdict, c.id).toBe("sensitive");
    expect(r.category, c.id).toBe(c.category);
    expect(r.flags).toEqual({ no_ai: true, no_forward: true, no_kb: true, priority: true });
  });

  it("the long corpus is long: every one is over 200 prose words", () => {
    const n = (s: string): number => (s.replace(/https?:\/\/\S+/g, " ").match(/\p{L}{2,}/gu) ?? []).length;
    const short = LONG_SENSITIVE.filter((c) => n(c.subject) + n(c.text) < 200).map((c) => c.id);
    expect(short).toEqual([]);
    expect(new Set(LONG_SENSITIVE.map((c) => c.category)).size).toBe(4);
  });

  it.each(LONG_NOTICES.map((c) => [c.id, c] as const))("notice: %s", (_id, c) => {
    const r = classifySensitivity(noticeMessage(c));
    expect(r.verdict, c.id).toBe("sensitive");
    expect(r.category, c.id).toBe(c.category);
  });

  it.each(DOCUMENTS_CARRYING_A_CODE.map((row) => [row[0], row] as const))(
    "a document carrying the code beside its cue is otp: %s", (_id, [, base, sentence]) => {
      const c = BUSINESS_CORPUS.find((x) => x.id === base)!;
      const paras = c.text.split("\n\n");
      paras.splice(2, 0, sentence);
      const r = classifySensitivity(businessMessage(c, paras.join("\n\n")));
      expect(r.verdict).toBe("sensitive");
      expect(r.category).toBe("otp");
    },
  );
});

/**
 * Each way a longer message backs its cue, alone: the subject names it, a code stands beside it or
 * alone on a line, an auth link delivers a token. The same body with the backing removed is a mention.
 */
describe("a cue counts once the message backs it", () => {
  const body = BUSINESS_CORPUS.find((c) => c.id === "de/contract commercial lease")!;

  it("the subject naming it", () => {
    const r = classifySensitivity(businessMessage({ ...body, subject: "Ihr Zugangscode für das Haupttor" }));
    expect(r.category).toBe("otp");
  });

  it("a code beside the cue", () => {
    const text = body.text.replace("Den Zugangscode für das Haupttor", "Der Zugangscode 4829 1374 für das Haupttor");
    expect(text).not.toBe(body.text);
    expect(classifySensitivity(businessMessage(body, text)).category).toBe("otp");
  });

  it("a code alone on its line, far below the cue, under a subject that names only the brand", () => {
    const c = LONG_SENSITIVE.find((x) => x.id === "en/platform recovery verification code")!;
    const r = classifySensitivity(noticeMessage({ ...c, subject: "Northwind" }));
    expect(r.category).toBe("otp");
  });

  it("an HTML table cell is not a code on its own line", () => {
    const c = BUSINESS_CORPUS.find((x) => x.id === "de/invoice payment reminder")!;
    const table = "<table>\n<tr>\n<td>Kundennummer</td>\n<td>\n482913\n</td>\n</tr>\n</table>";
    const htmlBody = "<html><body><p>Den Sicherheitscode Ihrer Karte geben wir nie weiter, auch nicht "
      + `auf Nachfrage am Telefon.</p>\n<p>${c.text.replace(/\n/g, "<br>")}</p>\n${table}\n</body></html>`;
    expect(classifySensitivity({ ...businessMessage(c), textBody: "", htmlBody }).verdict).toBe("ordinary");
  });

  it("a delivered auth link", () => {
    const link = "\n\nhttps://portal.example.invalid/account/activate?token=Qk9EWS1MSU5LLTQ4MjkxMw9x";
    expect(classifySensitivity(businessMessage(body, body.text + link)).sensitive).toBe(true);
  });

  it("none of them: a mention", () => {
    expect(classifySensitivity(businessMessage(body)).verdict).toBe("ordinary");
  });
});

/**
 * An HTML-only message backs its cue the way its plain text would: a code alone in its table row or
 * its block is a code alone on a line, whatever line breaks the source carries, and a label beside
 * its value in one row is not. The document corpus sent as HTML only is the control.
 */
describe("an HTML-only message is read as it is laid out", () => {
  type Layout = "lines" | "minified" | "indented";
  const LAYOUTS: Layout[] = ["lines", "minified", "indented"];
  const join = (layout: Layout, parts: string[]): string =>
    `<html><body>${parts.join(layout === "minified" ? "" : "\n")}</body></html>`;
  const table = (layout: Layout, rows: string[][], cell = "td"): string => {
    const tr = (cells: string[]): string => layout === "indented"
      ? `  <tr>\n${cells.map((c) => `    <${cell}>\n      ${c}\n    </${cell}>`).join("\n")}\n  </tr>`
      : `<tr>${cells.map((c) => `<${cell}>${c}</${cell}>`).join(layout === "lines" ? "\n" : "")}</tr>`;
    return `<table role="presentation">${layout === "minified" ? "" : "\n"}${rows.map(tr).join(layout === "minified" ? "" : "\n")}${layout === "minified" ? "" : "\n"}</table>`;
  };
  const htmlOnly = (subject: string, htmlBody: string): NormalizedMessage => ({ ...msg(subject, ""), htmlBody });

  const passcodeMail = (layout: Layout): NormalizedMessage => htmlOnly("Welcome back", join(layout, [
    "<h1>Your one-time passcode</h1>",
    "<p>We received a request to sign in to your Harbourline account from a new browser. Enter the "
      + "passcode below on the sign-in page to finish. It works once and expires in ten minutes.</p>",
    table(layout, [["482913"]]),
    "<p>This request came from a browser on Linux near Zurich. If it was not you, ignore this "
      + "message and nothing changes on your account.</p>",
  ]));

  it.each(LAYOUTS)("a code alone in its table row, far below the cue, subject naming nothing: %s", (layout) => {
    const r = classifySensitivity(passcodeMail(layout));
    expect(r.verdict, layout).toBe("sensitive");
    expect(r.category, layout).toBe("otp");
  });

  it.each(["en/platform recovery verification code", "de/platform sign-in code"])(
    "a notice sent as HTML only reads as its plain text does: %s", (id) => {
      const c = LONG_SENSITIVE.find((x) => x.id === id)!;
      const m = noticeMessage({ ...c, html: true, subject: "Northwind" });
      expect(classifySensitivity({ ...m, htmlBody: null }).category, "plain text").toBe("otp");
      expect(classifySensitivity({ ...m, textBody: "" }).category, "HTML only").toBe("otp");
    });

  it("every business document sent as HTML only still reads ordinary", () => {
    const flagged = BUSINESS_CORPUS
      .map((c) => [c.id, classifySensitivity({ ...businessMessage({ ...c, html: true }), textBody: "" })] as const)
      .filter(([, r]) => r.verdict !== "ordinary").map(([id, r]) => `${id} → ${r.category ?? r.reasons.join(",")}`);
    expect(flagged).toEqual([]);
    expect(BUSINESS_CORPUS.length).toBeGreaterThanOrEqual(30);
  });

  const invoice = BUSINESS_CORPUS.find((x) => x.id === "en/invoice payment reminder")!;
  const invoiceWith = (layout: Layout, tail: string): NormalizedMessage => htmlOnly(invoice.subject, join(layout, [
    "<p>We never pass on the security code of your card, not even when asked on the phone.</p>",
    ...invoice.text.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`),
    tail,
  ]));

  it.each(LAYOUTS)("a label beside its number in one row is not a code alone: %s", (layout) => {
    const r = classifySensitivity(invoiceWith(layout, table(layout, [["Customer number", "482913"]])));
    expect(r.verdict, `${layout} → ${r.category ?? r.reasons.join(",")}`).toBe("ordinary");
  });

  it.each(LAYOUTS)("a numeric table under a header row is not a code alone: %s", (layout) => {
    const rows = [["Invoice", "Due", "Amount"], ["482913", "30.09.2026", "USD 1,240.00"], ["482914", "31.10.2026", "USD 980.50"]];
    const r = classifySensitivity(invoiceWith(layout, table(layout, rows)));
    expect(r.verdict, `${layout} → ${r.category ?? r.reasons.join(",")}`).toBe("ordinary");
  });
});

function msg(subject: string, body: string): NormalizedMessage {
  return {
    canonical: { messageIdHeader: null, bodyHash: "x" }, subject,
    from: { name: null, address: "office@example.invalid" }, to: [], cc: [], date: null, headers: {},
    textBody: body, htmlBody: null, hasAttachments: false, attachments: [],
  };
}

/**
 * The numeric backstop read a business letter's numbers as a code: a customer code, a bank's sort
 * code, a payroll tax code, an amount with a space thousands separator, and "TAN" anywhere paired
 * with any number anywhere. Each pair: the business shape is ordinary, its credential twin is not.
 */
describe("the numeric backstop reads business numbers as numbers", () => {
  const PAD = "Grazie per la collaborazione, restiamo a disposizione per ogni domanda.";
  it.each([
    ["codice cliente", `Codice cliente: 482913. ${PAD}`, `Il tuo codice: 482913. ${PAD}`],
    ["code client", "Code client : 482913, merci de le rappeler.", "Votre code : 482913, ne le partagez pas."],
    ["sort code", "Sort code: 40-11-62\nAccount number: 48291374", "Your code: 40-11-62"],
    ["tax code", "Income tax (tax code 1257L): £741.20", "Your code: 1257 for today"],
    ["an amount", "Die Lohnsumme: CHF 842 000.00 gemeldet.\n\nDas Kennwort erhalten Sie telefonisch.",
      "Das Kennwort: 842 000 gilt ab heute."],
    ["TAN far from the number", "Kontonummer 16 482.913.07, IBAN CH56 0483 5012 3456 7800 9. Die Freigabe per "
      + "App ersetzt bei uns seit Januar jedes andere Verfahren, eine TAN per SMS gibt es nicht mehr.",
      "Ihre TAN lautet 481920."],
  ])("%s", (_label, ordinary, credential) => {
    const a = classifySensitivity(msg("Info", ordinary));
    expect(a.verdict, `${ordinary} → ${a.reasons.join(",")}`).toBe("ordinary");
    const b = classifySensitivity(msg("Info", credential));
    expect(b.flags.no_ai, credential).toBe(true);
  });
});
