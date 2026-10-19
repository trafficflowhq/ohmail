import { describe, expect, it } from "vitest";
import { owaInvitationStub } from "../src/ics.js";
import { normalizeMime } from "../src/mime.js";
import { OWA_BASE as BASE, OWA_ITEM as ITEM, OWA_OPTIONS as OPTS, OWA_SETTING_HREF as HREF, OWA_STUB as STUB } from "./fixtures/owa-invitation-stub.js";

/**
 * An Exchange or Microsoft 365 meeting invitation served over IMAP as an Outlook Web App link
 * instead of the event (reported 2026-10-19). Recognized from the body text's two OWA URLs,
 * never its sentences (they follow the mailbox language); the options link is rebuilt, and only
 * for Microsoft 365's own hosts.
 */

describe("owaInvitationStub: the stub shapes", () => {
  it("recognizes the reported text/plain shape and rebuilds the options link", () => {
    expect(owaInvitationStub(STUB)).toEqual({ optionsHref: HREF });
  });

  it("tolerates a BOM, leading blank lines and CRLF", () => {
    expect(owaInvitationStub(`﻿\r\n\r\n${STUB.replaceAll("\n", "\r\n")}`)).toEqual({ optionsHref: HREF });
  });

  it("recognizes the label and the link on one line, German sentences, meeting text after it", () => {
    const de = [
      `Microsoft Outlook Web Access: ${ITEM}`,
      "",
      `Um Besprechungseinladungen als iCalendar-Anlagen statt als Outlook Web App-Links zu erhalten, rufen Sie ${OPTS} auf.`,
      "",
      "Agenda: Q4",
      "https://teams.microsoft.com/l/meetup-join/x",
    ].join("\n");
    expect(owaInvitationStub(de)).toEqual({ optionsHref: HREF });
  });

  it("recognizes the html-only stub through the ingest parse", async () => {
    const amp = (s: string) => s.replaceAll("&", "&amp;");
    const eml = [
      "Message-ID: <owa-html@sender.test>", "From: a@sender.test", "To: me@x.test", "Subject: Think tank",
      "Content-class: urn:content-classes:calendarmessage", 'Content-Type: text/html; charset="utf-8"', "",
      `<html><body><p>Microsoft Outlook Web Access: <a href="${amp(ITEM)}">${amp(ITEM)}</a></p>`
        + `<p>To receive meeting invitations as .iCalendar attachments instead of Outlook Web App links, go to `
        + `<a href="${OPTS}">${OPTS}</a> and select Send meeting invitations in iCalendar format.</p></body></html>`,
      "",
    ].join("\r\n");
    const m = await normalizeMime(eml);
    expect(owaInvitationStub(m.textBody)).toEqual({ optionsHref: HREF });
  });

  it("recognizes on-premises Exchange, with no link", () => {
    const onprem = STUB.replaceAll(BASE, "https://mail.corp.example/owa/");
    expect(owaInvitationStub(onprem)).toEqual({ optionsHref: null });
  });

  it("accepts outlook.office.com and a bare /owa path", () => {
    const office = STUB.replaceAll(BASE, "https://outlook.office.com/owa/");
    expect(owaInvitationStub(office)).toEqual({ optionsHref: "https://outlook.office.com/owa/?path=/options/popandimap" });
  });

  it("reads the query percent-decoded and case-insensitively", () => {
    const enc = STUB
      .replace("path=/calendar/item", "PATH=%2Fcalendar%2FItem")
      .replace("?path=/options/popandimap", "?path=%2FOptions%2FPopAndImap");
    expect(owaInvitationStub(enc)).toEqual({ optionsHref: HREF });
  });
});

describe("owaInvitationStub: ordinary mail stays ordinary", () => {
  it("an ordinary Outlook calendar link is not a stub", () => {
    expect(owaInvitationStub(`Here is the meeting:\n${ITEM}\nSee you.`)).toBeNull();
    expect(owaInvitationStub(`${ITEM}\nCan you make it?`)).toBeNull();
    expect(owaInvitationStub("Calendar: https://outlook.office365.com/calendar/view/month\n")).toBeNull();
  });

  it("a Teams invitation is not a stub", () => {
    expect(owaInvitationStub("Join Microsoft Teams Meeting\nhttps://teams.microsoft.com/l/meetup-join/abc\n")).toBeNull();
  });

  it("a forwarded stub is not one", () => {
    const fwd = `________________________________\nFrom: A\nSent: Thursday\nSubject: Think tank\n\n${STUB}`;
    expect(owaInvitationStub(fwd)).toBeNull();
  });

  it("a quoted stub in a reply is not one", () => {
    expect(owaInvitationStub(`Thanks!\n\nOn Thu someone wrote:\n> ${STUB.replaceAll("\n", "\n> ")}`)).toBeNull();
  });

  it("a stub pasted under a note is not one", () => {
    expect(owaInvitationStub(`FYI\n\n${STUB}`)).toBeNull();
  });

  it("the options link alone is not one", () => {
    expect(owaInvitationStub(`To change it go to ${OPTS}`)).toBeNull();
    expect(owaInvitationStub(`${OPTS}\n`)).toBeNull();
  });

  it("an item link without an itemid is not one", () => {
    expect(owaInvitationStub(STUB.replace("itemid=AAMkADJh%2FTaHJ8AAV95f1jAAA%3D&", ""))).toBeNull();
  });

  it("an options link on another origin is not one", () => {
    expect(owaInvitationStub(STUB.replace(OPTS, "https://evil.example/owa/?path=/options/popandimap"))).toBeNull();
    expect(owaInvitationStub(STUB.replace(OPTS, OPTS.replace("https:", "http:")))).toBeNull();
  });

  it("an options link that sits past the head is not read", () => {
    const far = STUB.replace(`${OPTS} and`, `${"x".repeat(2100)}\n${OPTS} and`);
    expect(owaInvitationStub(far)).toBeNull();
  });

  it("empty and odd input answers null and never throws", () => {
    expect(owaInvitationStub("")).toBeNull();
    expect(owaInvitationStub("https://")).toBeNull();
    expect(owaInvitationStub("Microsoft Outlook Web Access: https://x/owa/?itemid=%E0%A4%A&path=/calendar/item")).toBeNull();
  });
});

describe("owaInvitationStub: the link it offers", () => {
  it("a look-alike host gets no link", () => {
    const lookalike = STUB.replaceAll("outlook.office365.com", "outlook.office365.com.evil.example");
    expect(owaInvitationStub(lookalike)).toEqual({ optionsHref: null });
  });

  it("userinfo in the authority is refused", () => {
    const userinfo = STUB.replaceAll("https://outlook.office365.com/", "https://outlook.office365.com@evil.example/");
    expect(owaInvitationStub(userinfo)).toBeNull();
  });

  it("a port in the authority is refused", () => {
    expect(owaInvitationStub(STUB.replaceAll("outlook.office365.com/", "outlook.office365.com:8443/"))).toBeNull();
  });

  it("extra parameters and a fragment are dropped from the rebuilt link", () => {
    const extra = STUB.replace(OPTS, `${OPTS}&redirect=https%3A%2F%2Fevil.example#x`);
    expect(owaInvitationStub(extra)).toEqual({ optionsHref: HREF });
  });

  it("a path outside the tenant shape gets no link", () => {
    const deep = STUB.replaceAll(BASE, "https://outlook.office365.com/owa/a/b/");
    expect(owaInvitationStub(deep)).toEqual({ optionsHref: null });
  });

  it("the link never carries the message's /owa/<segment>/: it names a sign-in realm", () => {
    for (const segment of ["attacker-federated.example", "othertenant.onmicrosoft.com", "x"]) {
      const realm = STUB.replaceAll(BASE, `https://outlook.office365.com/owa/${segment}/`);
      expect(owaInvitationStub(realm), segment).toEqual({ optionsHref: HREF });
    }
    const office = STUB.replaceAll(BASE, "https://outlook.office.com/owa/attacker-federated.example/");
    expect(owaInvitationStub(office)).toEqual({ optionsHref: "https://outlook.office.com/owa/?path=/options/popandimap" });
  });

  it("plain http gets no link", () => {
    expect(owaInvitationStub(STUB.replaceAll("https://", "http://"))).toEqual({ optionsHref: null });
  });
});
