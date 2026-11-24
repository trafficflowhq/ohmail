import { describe, expect, it } from "vitest";
import { owaInvitationItemId } from "../src/ics.js";
import {
  OWA_ANSWER_LINKS, OWA_BASE as BASE, OWA_DEEP_LINK, OWA_ITEM_ID as ID, OWA_ORDINARY, OWA_STUB as STUB, OWA_STUB_ONPREM,
} from "./fixtures/owa-invitation-stub.js";

/**
 * The Exchange item id of a meeting invitation sent as an Outlook Web App link. It is only ever
 * handed to the person's own Microsoft calendar connection to look the event up; the link is never
 * fetched. So it is read only from the shapes Exchange writes, and only when it has an id's shape.
 */

describe("owaInvitationItemId: the shapes an invitation link comes in", () => {
  it("reads the stub's item link, percent-decoded", () => {
    expect(owaInvitationItemId(STUB)).toBe(ID);
  });

  it("reads an on-premises stub as well: the host is never dialled", () => {
    expect(owaInvitationItemId(OWA_STUB_ONPREM)).toBe(ID);
  });

  it("reads Outlook's calendar item page, as an answer block links it", () => {
    expect(owaInvitationItemId(OWA_DEEP_LINK)).toBe(ID);
  });

  it("reads the classic /owa/ answer links", () => {
    expect(owaInvitationItemId(OWA_ANSWER_LINKS)).toBe(ID);
  });

  it("reads the URL-safe form of an id", () => {
    const safe = "AAMkADJh_TaHJ8AAV95f1jAAA-";
    expect(owaInvitationItemId(STUB.replace(encodeURIComponent(ID), safe))).toBe(safe);
  });
});

describe("owaInvitationItemId: what is no invitation link", () => {
  it("ordinary mail that links the options page has no item", () => {
    expect(owaInvitationItemId(OWA_ORDINARY)).toBeNull();
  });

  it("a calendar view link names no item", () => {
    expect(owaInvitationItemId("Calendar: https://outlook.office365.com/calendar/view/month\n")).toBeNull();
  });

  it("an item page on a host that is not Microsoft 365's is not read outside the stub", () => {
    expect(owaInvitationItemId(OWA_DEEP_LINK.replaceAll("outlook.office.com", "outlook.office.com.evil.example"))).toBeNull();
    expect(owaInvitationItemId(OWA_DEEP_LINK.replaceAll("https://outlook.office.com/", "https://mail.corp.example/"))).toBeNull();
    expect(owaInvitationItemId(OWA_DEEP_LINK.replaceAll("https://outlook.office.com/", "http://outlook.office.com/"))).toBeNull();
    expect(owaInvitationItemId(OWA_DEEP_LINK.replaceAll("outlook.office.com/", "outlook.office.com:8443/"))).toBeNull();
  });
});

describe("owaInvitationItemId: a malformed id is refused", () => {
  const withId = (id: string) => STUB.replace(encodeURIComponent(ID), encodeURIComponent(id));

  it.each([
    ["a path that climbs", "../../me/messages"],
    ["a query of its own", "AAMkADJhTaHJ8AAV95f1jAAA?$select=body"],
    ["a whole address", "https://evil.example/AAMkADJhTaHJ8AAV95"],
    ["a space", "AAMkADJh TaHJ8AAV95f1jAAA="],
    ["too short to be an id", "AAMk"],
    ["longer than any id", "A".repeat(600)],
    ["padding in the middle", "AAMkAD==Jh/TaHJ8AAV95f1jAAA"],
  ])("refuses %s", (_what, id) => {
    expect(owaInvitationItemId(withId(id))).toBeNull();
  });

  it("refuses an item page whose id is not an id, and reads none of the text after it", () => {
    const bad = OWA_DEEP_LINK.replaceAll(encodeURIComponent(ID), "%2E%2E%2Fme%2Fmessages");
    expect(owaInvitationItemId(bad)).toBeNull();
  });

  it("refuses bad percent-encoding", () => {
    expect(owaInvitationItemId(OWA_DEEP_LINK.replaceAll(encodeURIComponent(ID), "AAMkADJh%E0%A4%A"))).toBeNull();
  });

  it("the stub's base is no part of the id", () => {
    expect(BASE).not.toContain(ID);
  });
});
