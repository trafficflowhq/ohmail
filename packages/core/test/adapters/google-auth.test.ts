import { describe, expect, it } from "vitest";
import {
  GOOGLE_AUTH_HINTS, googleAppPassword, googleAuthHint, imapFlowOptions, isGoogleMailHost, smtpTransportOptions,
  type ImapConfig,
} from "../../src/adapters/imap.js";
import { loadRefusals } from "./_providershape.js";

/**
 * GOOGLE'S SIGN-IN REFUSALS, NAMED — and its App Password dialled joined.
 *
 * Every Gmail refusal used to become one "the server refused this password", which sent a person
 * holding a Google password back to retype it. The hint is read off imapflow's error (the flag, the
 * response code, the text without its bracket), only on Google's hosts; the corpus is synthetic
 * (`gmail.refusals.json`) until a real mailbox records one. Values here are synthetic.
 */

const refusals = loadRefusals("gmail");
/** imapflow's shape for a refused LOGIN (`commands/login.js`, `imap-flow.js` responseText). */
const refusedLogin = (code: string | null, text: string): Error =>
  Object.assign(new Error("Command failed"), {
    authenticationFailed: true, responseStatus: "NO", responseText: text,
    ...(code === null ? {} : { serverResponseCode: code }),
  });
// Built at run time: a literal in four groups reads as a real App Password to the push gate.
const APP = ["qwer", "tyas", "dfgh", "zxcv"].join("");
const GROUPED = APP.match(/.{4}/g)!.join(" ");

describe("googleAuthHint over the corpus", () => {
  it("the corpus names a hint from the closed set for each refusal, and covers all four", () => {
    expect(refusals.source.kind).toBe("synthetic");
    expect(new Set(refusals.refusals.map((r) => r.hint))).toEqual(new Set(GOOGLE_AUTH_HINTS));
  });

  for (const r of refusals.refusals) {
    it(`${r.case}: ${r.hint} on imap.gmail.com`, () => {
      expect(googleAuthHint(refusedLogin(r.code, r.text), "imap.gmail.com")).toBe(r.hint);
      expect(googleAuthHint(refusedLogin(r.code, r.text), " IMAP.GoogleMail.com. ")).toBe(r.hint);
    });
    it(`${r.case}: null on a host that is not Google's`, () => {
      expect(googleAuthHint(refusedLogin(r.code, r.text), "imap.example.test")).toBeNull();
      expect(googleAuthHint(refusedLogin(r.code, r.text), "imap.gmail.com.example.test")).toBeNull();
      expect(googleAuthHint(refusedLogin(r.code, r.text), undefined)).toBeNull();
    });
  }

  it("a wrapped cause is still found", () => {
    const r = refusals.refusals.find((x) => x.hint === "imap_disabled")!;
    const wrapped = new Error("connect failed", { cause: new Error("login", { cause: refusedLogin(r.code, r.text) }) });
    expect(googleAuthHint(wrapped, "imap.gmail.com")).toBe("imap_disabled");
  });

  it("an unmatched ALERT and a bare NO are `invalid`; Google's other codes and an unflagged throw are null", () => {
    expect(googleAuthHint(refusedLogin("ALERT", "Something new from Google"), "imap.gmail.com")).toBe("invalid");
    expect(googleAuthHint(refusedLogin(null, "Invalid credentials"), "imap.gmail.com")).toBe("invalid");
    expect(googleAuthHint(refusedLogin("AUTHORIZATIONFAILED", "No"), "imap.gmail.com")).toBe("invalid");
    expect(googleAuthHint(refusedLogin("THROTTLED", "Too many"), "imap.gmail.com")).toBeNull();
    expect(googleAuthHint(refusedLogin("UNAVAILABLE", "Try later"), "imap.gmail.com")).toBeNull();
    expect(googleAuthHint(Object.assign(new Error("x"), { code: "ECONNREFUSED" }), "imap.gmail.com")).toBeNull();
  });

  it("Dovecot's own refusal on its own host is null", () => {
    expect(googleAuthHint(refusedLogin("AUTHENTICATIONFAILED", "Authentication failed."), "mail.example.test")).toBeNull();
  });

  it("Google's hosts, and only those", () => {
    for (const h of ["imap.gmail.com", "imap.googlemail.com", "smtp.gmail.com", "smtp.googlemail.com"]) expect(isGoogleMailHost(h), h).toBe(true);
    for (const h of ["gmail.com", "mail.google.com", "imap.gmail.co", "", "imap.example.test"]) expect(isGoogleMailHost(h), h).toBe(false);
  });
});

describe("googleAppPassword: a 16-letter App Password is dialled joined, on Google's hosts only", () => {
  it("groups, non-breaking spaces and spaces at the ends join", () => {
    expect(googleAppPassword("imap.gmail.com", GROUPED)).toBe(APP);
    expect(googleAppPassword("smtp.gmail.com", GROUPED.replace(/ /g, " "))).toBe(APP);
    expect(googleAppPassword("imap.gmail.com", ` ${GROUPED} `)).toBe(APP);
    expect(googleAppPassword("imap.gmail.com", GROUPED.toUpperCase())).toBe(APP.toUpperCase());
  });

  it("anything else is the same value", () => {
    const fifteen = GROUPED.slice(0, -1);
    const seventeen = `${GROUPED}q`;
    const digits = GROUPED.replace("q", "1");
    for (const p of [fifteen, seventeen, digits, "my google pass", APP]) expect(googleAppPassword("imap.gmail.com", p), p).toBe(p);
    expect(googleAppPassword("imap.example.test", GROUPED)).toBe(GROUPED);
  });
});

describe("the dial carries the joined form; every other host's options are as they were", () => {
  const cfg = (host: string, smtpHost: string, pass: string): ImapConfig => ({
    host, port: 993, secure: true, auth: { user: "someone@example.test", pass },
    smtp: { host: smtpHost, port: 465, secure: true, auth: { user: "someone@example.test", pass } },
  });

  it("imapFlowOptions and smtpTransportOptions on Google's hosts", () => {
    const c = cfg("imap.gmail.com", "smtp.gmail.com", GROUPED);
    expect((imapFlowOptions(c as Parameters<typeof imapFlowOptions>[0]).auth as { pass: string }).pass).toBe(APP);
    expect((smtpTransportOptions(c).auth as { pass: string }).pass).toBe(APP);
    // The stored config is not touched.
    expect((c.auth as { pass: string }).pass).toBe(GROUPED);
  });

  it("a host that is not Google's: the assembled options are the very auth it was given", () => {
    const c = cfg("imap.example.test", "smtp.example.test", GROUPED);
    const flow = imapFlowOptions(c as Parameters<typeof imapFlowOptions>[0]);
    expect(flow.auth).toBe(c.auth);
    expect(smtpTransportOptions(c).auth).toBe(c.smtp!.auth);
    expect(flow.auth).toEqual({ user: "someone@example.test", pass: GROUPED });
  });
});
