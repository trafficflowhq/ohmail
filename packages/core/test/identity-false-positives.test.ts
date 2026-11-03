import { describe, it, expect } from "vitest";
import { effectForDestination, evaluateRules, type Rule } from "../src/rules.js";
import { claimedIdentity } from "../src/sender-check.js";
import { BRANDS } from "../src/brands.js";
import { isSharedProviderDomain } from "../src/rule-order.js";
import type { NormalizedMessage } from "../src/types.js";
import { personalAt } from "../../../test/support/fixture-credentials.js";

/* People at a shared provider, where the provider is what the gate reads: assembled, fixture locals. */
const GMAIL = "gmail.com";
const ANNA = personalAt("fixture.anna", GMAIL);
const STRANGER = personalAt("fixture.reto", GMAIL);

/**
 * THE IDENTITY FACT'S FALSE POSITIVES, measured through the gate (mail 0148). Every sender below
 * stands behind an allow domain rule for its OWN domain — the shape a person makes for a firm they
 * deal with — and must be admitted with no fact: names that wear a brand's word, a short needle
 * beside an ordinary word, a brand mentioned mid-subject, and every brand's own mail from its own
 * domains. The positive controls in the same file are held, so a matcher that claims nothing
 * cannot pass by silence.
 */
const msg = (name: string | null, from: string, subject = "Hallo"): NormalizedMessage => ({
  canonical: { messageIdHeader: null, bodyHash: "x" },
  subject, from: { name, address: from }, to: [], cc: [],
  date: null, headers: {}, textBody: "", htmlBody: null, hasAttachments: false, attachments: [],
});

const allowDomain = (domain: string): Rule => ({
  id: `d-${domain}`, kind: "domain", match: domain, destination: "INBOX",
  effect: effectForDestination("INBOX"), priority: 0, provenance: "manual", enabled: true,
  subjectContains: null, bodyContains: null,
});

const gate = (m: NormalizedMessage, person: string[] = []) => {
  const domain = m.from.address.slice(m.from.address.lastIndexOf("@") + 1);
  return evaluateRules({
    msg: m, rules: [allowDomain(domain)],
    knownSenders: { addresses: new Set(person), inferred: new Set<string>(), lists: new Map() },
    auth: "unauthenticated", ohboxPolicy: "people_and_replied", ownAddresses: new Set<string>(),
    identity: claimedIdentity({ fromName: m.from.name, fromAddress: m.from.address, subject: m.subject }) ?? null,
  });
};

const ADMITTED: Array<[string | null, string, string?]> = [
  ["Dipl.-Ing. Anna Huber", "a.huber@ingenieurbuero-huber.example"],
  ["Ing. Peter Gruber", "p.gruber@gruber-bau.example"],
  ["CSS-Tricks", "newsletter@css-tricks.example"],
  ["CSS Weekly", "news@css-weekly.example"],
  ["Meta Brunner", "meta.brunner@firma.example"],
  ["Salt & Pepper Restaurant", "info@saltandpepper.example"],
  ["Post Shop Zürich", "info@postshop.example"],
  ["Finanzamt München", "poststelle@fa-muenchen.example"],
  ["Apple Pie Café", "hello@applepie.example"],
  ["Orange Gallery", "info@orange-gallery.example"],
  // Spelled through a template: the push gate reads a capital and a digit as an internal id.
  [`The ${"O"}2`, "tickets@theo2.example"],
  [`${"A"}1 Garage`, "info@a1garage.example"],
  ["VFS Global – Visa Application Centre", "info@vfsglobal.example"],
  ["Hermès Boutique", "boutique@hermes-paris.example"],
  ["Nintendo Switch News", "news@nintendo.example"],
  ["Sunrise Yoga", "hello@sunriseyoga.example"],
  ["Digitec", "news@digitec.ch"],
  ["Finanzblog", "news@finanzblog.example", "PostFinance erhöht die Gebühren"],
  // An empty display name: the local part speaks, and it claims nothing.
  ["", "info@firma.example"],
  // The corpus' holds of the two-reading round: a brand's skeleton keeps its rn, Post CH is a token
  // pair, and a local part claims whole tokens only.
  ["Stucki Amanda", "stucki.amanda@firma.example"],
  ["Stucki Arnaud", "arnaud.stucki@firma.example"],
  ["Daniel Sterner", "daniel.sterner@firma.example"],
  ["Michael Sternberg", "m.sternberg@firma.example"],
  ["Elodie Post", "elodie.post@firma.example"],
  ["Klamath Outdoor", "info@klamath.example"],
  ["Post Christian", "post.christian@firma.example"],
  ["Shop", "news@shop.example", "Post-Christmas Sale: 20% auf alles"],
  ["Bank", "info@bank.example", "Postcheck-Konto: Ihr Auszug"],
  ["IT Support", "administrator@firma.example"],
  ["Anna Keller", "anna@firma.example", "Administrator: Ihr Postfach ist voll"],
  ["Anna Keller", "anna@firma.example", "revolution: update for next week"],
  ["Anna Keller", "anna@firma.example", "Amazons: update for next week"],
  [null, "revolution@firma.example"],
];

describe("the identity fact admits what it must not hold", () => {
  it.each(ADMITTED)("%s <%s> is admitted with no fact", (name, from, subject) => {
    const d = gate(msg(name, from, subject));
    expect(d.source).toBe("rule");
    expect(d.destination).toBe("INBOX");
    expect(d.identity).toBeUndefined();
  });

  it("a person contact at a shared provider is admitted with no fact", () => {
    // The allow rule at gmail.com admits nobody (the shared-provider rule): the contact admits her,
    // so the mail keeps the place the mailbox gave it.
    const d = gate(msg("Anna Brunner", ANNA), [ANNA]);
    expect(d).toEqual({ destination: null, matchedRuleId: null, source: "unclear" });
    // CONTROL: without the contact she is a stranger there, held as one, still with no fact.
    expect(gate(msg("Anna Brunner", ANNA))).toEqual({ destination: "ohmail/Screener", matchedRuleId: null, source: "screener" });
  });

  it("every brand's own mail from its own domains — the seven shared ones pinned apart", () => {
    const held: string[] = [];
    for (const b of BRANDS) {
      for (const d of b.domains.filter((x) => !isSharedProviderDomain(x))) {
        const r = gate(msg(b.name, `service@${d}`, `${b.name}: Ihre Rechnung`));
        if (r.destination !== "INBOX" || r.identity !== undefined) held.push(`${b.name} ${d}`);
      }
    }
    expect(held).toEqual([]);
  });
});

describe("the positive controls — held, with the fact", () => {
  it.each([
    ["ING Kundenservice", STRANGER, "Hallo", "ING"],
    ["UBS Sicherheit", STRANGER, "Hallo", "UBS"],
    ["Kartenservice", STRANGER, "PostFinance: Reaktivierung Ihrer Karte", "PostFinance"],
    [null, "postfinance.kundendienst@firma.example", "Hallo", "PostFinance"],
    [null, personalAt("fixture.postfinance", GMAIL), "Hallo", "PostFinance"],
  ] as Array<[string | null, string, string, string]>)("%s <%s> is held", (name, from, subject, brand) => {
    const d = gate(msg(name, from, subject));
    expect(d.destination).toBe("ohmail/Screener");
    expect(d.identity?.brand).toBe(brand);
  });

  it("NAMED COST, not a control: a sponsorship name is held once and let through with one press", () => {
    const d = gate(msg("SCB – PostFinance Arena", "tickets@scb.example"));
    expect(d.destination).toBe("ohmail/Screener");
    expect(gate(msg("SCB – PostFinance Arena", "tickets@scb.example"), ["tickets@scb.example"]).destination).toBe("INBOX");
  });
});
