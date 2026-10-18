import { describe, expect, it } from "vitest";
import { personalAt } from "../../../test/support/fixture-credentials.js";
import { BRANDS, UMBRELLA_DOMAINS } from "../src/brands.js";
import { isSharedProviderDomain } from "../src/rule-order.js";
import { ownedBrand, ownedSenderName } from "../src/sender-check.js";

/**
 * THE BRAND AN ADDRESS BELONGS TO: the dictionary row whose own domains hold the sender's registrable
 * domain. A fact about the address alone; whether a message really came from there is its provider's
 * verdict, which the callers read beside it. A shared provider's domain owns nothing.
 */
describe("ownedBrand", () => {
  it("names the brand at its own domain and at a subdomain of it, in any case", () => {
    expect(ownedBrand("service@paypal.com")?.name).toBe("PayPal");
    expect(ownedBrand("Service@Mail.PayPal.COM")?.name).toBe("PayPal");
    expect(ownedBrand("support@metanet.ch")?.name).toBe("Metanet");
  });

  it("a look-alike, a stranger and an address with no domain own nothing", () => {
    expect(ownedBrand("service@paypal-security.example")).toBeUndefined();
    expect(ownedBrand("anna@studio-nord.example")).toBeUndefined();
    expect(ownedBrand("no-at-sign")).toBeUndefined();
    expect(ownedBrand("")).toBeUndefined();
  });

  it("a shared provider's domain owns nothing, whichever row lists it", () => {
    // Microsoft lists outlook.com and Swisscom lists bluewin.ch: anyone can register there.
    expect(ownedBrand(personalAt("fixture.nadja", "outlook.com"))).toBeUndefined();
    expect(ownedBrand(personalAt("fixture.nadja", "bluewin.ch"))).toBeUndefined();
    // CONTROL: the same rows' own domains do own.
    expect(ownedBrand("account@microsoft.com")?.name).toBe("Microsoft");
    expect(ownedBrand("info@swisscom.ch")?.name).toBe("Swisscom");
  });
});

/**
 * THE NAME THE "DID NOT CONFIRM" LINE GIVES. Ownership is read registrable-domain-wide, so a
 * government's umbrella domain (`admin.ch`, `bund.de`: every federal office sends from a host under
 * it) is owned, and the act still refuses to let it through unconfirmed. But it names no ONE office:
 * the first row listing it put ESTV on a BAG letter. There the line names the domain.
 */
describe("ownedSenderName", () => {
  it("names the brand where its registrable domain is that one brand's", () => {
    expect(ownedSenderName("service@paypal.com")).toBe("PayPal");
    expect(ownedSenderName("Service@Mail.PayPal.COM")).toBe("PayPal");
    expect(ownedSenderName("info@ahv-iv.ch")).toBe("AHV");
    expect(ownedSenderName("info@bzst.de")).toBe("Bundeszentralamt für Steuern");
  });

  it("names the umbrella domain, never the first office that lists it", () => {
    for (const address of ["info@bag.admin.ch", "noreply@bazg.admin.ch", "info@zas.admin.ch", "info@estv.admin.ch"]) {
      expect(ownedSenderName(address), address).toBe("admin.ch");
    }
    expect(ownedSenderName("poststelle@bsi.bund.de")).toBe("bund.de");
    expect(ownedSenderName("poststelle@bzst.bund.de")).toBe("bund.de");
  });

  it("is defined exactly where ownedBrand is, so the act's refusal and the line read one fact", () => {
    for (const address of ["info@bag.admin.ch", "poststelle@bsi.bund.de", "service@paypal.com"]) {
      expect(ownedBrand(address), address).toBeDefined();
    }
    for (const address of ["anna@studio-nord.example", personalAt("fixture.nadja", "outlook.com"), "no-at-sign", ""]) {
      expect(ownedBrand(address), address).toBeUndefined();
      expect(ownedSenderName(address), address).toBeUndefined();
    }
  });

  it("a domain two rows list names neither row, whichever it is", () => {
    const rows = new Map<string, number>();
    for (const b of BRANDS) for (const d of b.domains) rows.set(d, (rows.get(d) ?? 0) + 1);
    const shared = [...rows].filter(([d, n]) => n > 1 && !isSharedProviderDomain(d)).map(([d]) => d);
    expect(shared, "the dictionary has a domain two rows list: the arm below is live").toContain("admin.ch");
    for (const d of shared) expect(ownedSenderName(`info@office.${d}`), d).toBe(d);
  });

  it("every umbrella domain is one a dictionary row owns: a listed umbrella nobody owns would say nothing", () => {
    for (const d of UMBRELLA_DOMAINS) expect(ownedBrand(`info@${d}`), d).toBeDefined();
  });
});
