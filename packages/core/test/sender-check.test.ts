import { describe, it, expect } from "vitest";
import {
  CAP_CONFIDENCE, SOFT_CEILING, capSuggestion, claimedIdentity, denyMayRuleTheAddress, identityOfRow, normalizeSubject,
  registrableDomain, senderCheck, senderCheckAll, senderDomainOf, senderFacts,
  type CheckedSuggestion, type SenderCheckInput, type SenderReasonCode,
} from "../src/sender-check.js";
import { BRANDS } from "../src/brands.js";
import { isSharedProviderDomain } from "../src/rule-order.js";
import { personalAt } from "../../../test/support/fixture-credentials.js";

/**
 * WHO THE MAIL IS REALLY FROM — the check that runs before the model, and the cap it puts on the
 * answer. The measured defect: two first-time senders at unrelated domains, one subject between
 * them, both suggested `ohmail/News` at 0.95 as "an automated service notification from your
 * hosting provider". Every fixture domain here is invented (`.example`) but the shared providers
 * a case reads by name, whose addresses are assembled with a fixture local part; the BRANDS named
 * are real, because the dictionary is the half of the comparison that has to be.
 */

const GMAIL = "gmail.com";
/** A sender at a shared provider whose local part claims nothing. */
const SENDER = personalAt("fixture.reto", GMAIL);

/** The model's answer in the reported screenshot, as this file reads one. */
const READS_095: CheckedSuggestion = {
  destination: "ohmail/News", confidence: 0.95, spam: false,
  rationale: "an automated service notification from your hosting provider",
};

const A: SenderCheckInput = {
  fromAddress: "info@domain-renewals-ch.example",
  fromName: "Kundensupport",
  subject: "Metanet-Hosting: Ihre Domain läuft in den nächsten 2 Tagen ab",
  snippet: "Ihre bei metanet registrierte Domain läuft ab. Jetzt verlängern.",
};

const B: SenderCheckInput = {
  fromAddress: "billing@hosting-alert.example",
  fromName: "Support",
  subject: "Metanet-Hosting: Ihre Domain läuft in den nächsten 3 Tagen ab",
  snippet: "Bitte bestätigen Sie Ihre Zahlung.",
};

const C: SenderCheckInput = {
  fromAddress: "rechnung@billing-notice.example",
  fromName: "Support",
  subject: "Swisscom: Ihre Rechnung ist überfällig",
  snippet: "Ihre Rechnung ist seit 5 Tagen überfällig. Bitte zahlen Sie sofort.",
};

describe("the sender's registrable domain", () => {
  it("reads the address, the subdomain and the two-label suffix", () => {
    expect(senderDomainOf("info@mail.eu.metanet.ch")).toBe("metanet.ch");
    expect(senderDomainOf("a@b.example")).toBe("b.example");
    expect(senderDomainOf("a@x.b.example")).toBe("b.example");
    // `admin.ch` is an ordinary registrable domain, not a public suffix: reading the federal
    // offices as separate registrable units would make one office's mail impersonate another's.
    expect(registrableDomain("ESTV.ADMIN.CH")).toBe("admin.ch");
    expect(senderDomainOf("nonsense")).toBe("");
  });
});

describe("fixture A — the claimed brand against the sending address", () => {
  const s = senderCheck(A);

  it("names the brand and the sender's own domain", () => {
    expect(s.impersonation?.brand).toBe("Metanet");
    expect(s.senderDomain).toBe("domain-renewals-ch.example");
    expect(s.reasonCode).toBe("impersonation");
  });

  it("caps the model's Reads 0.95 to Quarantine at the floor, and drops the sentence it wrote", () => {
    const capped = capSuggestion(READS_095, s);
    expect(capped.destination).toBe("ohmail/Quarantine");
    // The model was SURER than the floor, so its own number stands: the cap is a floor under the
    // verdict, never a ceiling on it.
    expect(capped.confidence).toBe(0.95);
    expect(capSuggestion({ ...READS_095, confidence: 0.4 }, s).confidence).toBe(CAP_CONFIDENCE);
    expect(capped.spam).toBe(true);
    expect(capped.rationale).toBe("");
    expect(capped.reasonCode).toBe("impersonation");
  });

  it("keeps the model's own sentence where it AGREED, and never lowers its number", () => {
    const agreeing: CheckedSuggestion = {
      destination: "ohmail/Quarantine", confidence: 0.97, spam: true,
      rationale: "the sender domain does not belong to the hoster it names",
    };
    const capped = capSuggestion(agreeing, s);
    expect(capped.rationale).toBe(agreeing.rationale);
    expect(capped.confidence).toBe(0.97);
  });

  it("states the facts for the prompt without stating a verdict", () => {
    const facts = senderFacts(s);
    expect(facts).toContain("Facts ohmail checked");
    expect(facts).toContain("domain-renewals-ch.example");
    expect(facts).toContain("Metanet");
    expect(facts).toContain("metanet.ch");
    expect(facts).not.toMatch(/quarantine|spam|phish/i);
  });
});

describe("fixture B — one subject, two strangers", () => {
  it("counts the campaign across the pass and not within one sender", () => {
    const [a, b] = senderCheckAll([A, B]);
    expect(a?.campaign?.count).toBe(2);
    expect(b?.campaign?.count).toBe(2);
    expect(senderCheck(A).campaign).toBeUndefined();
  });

  it("folds the digits so 2 Tagen and 3 Tagen are one subject", () => {
    expect(normalizeSubject(A.subject)).toBe(normalizeSubject(B.subject));
  });

  it("refuses a campaign of two addresses at ONE domain", () => {
    const twin = { ...B, fromAddress: "second@domain-renewals-ch.example", subject: A.subject };
    const [a] = senderCheckAll([A, twin]);
    expect(a?.campaign).toBeUndefined();
  });

  it("caps on the campaign alone, with no brand in the mail", () => {
    const one = { fromAddress: "a@one.example", subject: "Your parcel could not be delivered today", snippet: "" };
    const two = { fromAddress: "b@two.example", subject: "Your parcel could not be delivered today", snippet: "" };
    const [x] = senderCheckAll([one, two]);
    expect(x?.reasonCode).toBe("campaign");
    expect(capSuggestion(READS_095, x!).destination).toBe("ohmail/Quarantine");
  });
});

/* WHICH STORED REASON A DENY MAY STAND ON AS A RULE (the act on suggestions). Only facts about the
   sender's own letter: none, its forged identity, a brand it names. The crowd is other senders' mail;
   NULL is a row stored before the reason was, and an unknown word is no reason. Both fail closed. */
describe("a stored reason, and whether a deny may rule the address", () => {
  const CODES: Record<SenderReasonCode | "none", boolean> = {
    none: true, impersonation: true, brand_mismatch: true,
    campaign: false, auth_fail: false, correspondent: false,
  };
  it.each(Object.entries(CODES))("%s → %s", (reason, may) => {
    expect(denyMayRuleTheAddress(reason)).toBe(may);
  });

  it("NULL, absent and unknown words may not", () => {
    for (const reason of [null, undefined, "", "None", "campaign ", "spam"]) {
      expect(denyMayRuleTheAddress(reason), String(reason)).toBe(false);
    }
  });

  it("the crowd's cap is the one a confirmed shop's receipt meets: Quarantine at the act's bar, reason campaign", () => {
    const shop = (d: string) => ({ fromAddress: `orders@${d}`, subject: "Your order has shipped", snippet: "" });
    const [a] = senderCheckAll([shop("shop-a.example"), shop("shop-b.example")]);
    const receipts: CheckedSuggestion = { destination: "ohmail/Receipts", confidence: 0.95, rationale: "a receipt", spam: false };
    const capped = capSuggestion(receipts, a!);
    expect(capped).toMatchObject({ destination: "ohmail/Quarantine", confidence: 0.95, spam: true, reasonCode: "campaign" });
    expect(denyMayRuleTheAddress(capped.reasonCode ?? "none")).toBe(false);
    // CONTROL: the same answer with no signal is stored as it came, and its reason is none.
    const alone = capSuggestion(receipts, senderCheck(shop("shop-a.example")));
    expect(alone).toBe(receipts);
    expect(denyMayRuleTheAddress(alone.reasonCode ?? "none")).toBe(true);
  });
});

describe("fixture C — a brand in the subject, urgency in the body", () => {
  const s = senderCheck(C);
  it("is impersonation and urgency together", () => {
    expect(s.impersonation?.brand).toBe("Swisscom");
    expect(s.urgency).toBe(true);
    expect(s.reasonCode).toBe("impersonation");
  });
});

describe("the positive controls — no signal, and the answer stands", () => {
  it("the same subject from the brand's own domain fires nothing at all", () => {
    const own = { ...A, fromAddress: "support@metanet.ch", fromName: "Metanet" };
    const s = senderCheck(own);
    expect(s.impersonation).toBeUndefined();
    expect(s.brandMismatch).toBeUndefined();
    expect(s.reasonCode).toBeUndefined();
    expect(senderFacts(s)).toBeUndefined();
  });

  it("the stored suggestion is the model's own object, field for field", () => {
    const s = senderCheck({ ...A, fromAddress: "support@metanet.ch", fromName: "Metanet" });
    const capped = capSuggestion(READS_095, s);
    expect(capped).toBe(READS_095);
    expect(Object.keys(capped)).toEqual(Object.keys(READS_095));
    expect("reasonCode" in capped).toBe(false);
  });

  it("a newsletter from a brand's own domain fires nothing", () => {
    const s = senderCheck({
      fromAddress: "news@digitec.ch", fromName: "Digitec",
      subject: "Digitec: die Angebote dieser Woche", snippet: "Neu im Sortiment.",
    });
    expect(s.reasonCode).toBeUndefined();
  });

  it("a personal sender naming no brand fires nothing", () => {
    const s = senderCheck({
      fromAddress: "anna@studio-nord.example", fromName: "Anna Brunner",
      subject: "Quick question about Thursday", snippet: "Are you free after four?",
    });
    expect(s.reasonCode).toBeUndefined();
    // The display name is a PERSON's and their domain carries neither of its words. That used to
    // read as an unmatched organisation, on most personal mail there is.
    expect(s.brandMismatch).toBeUndefined();
    expect(senderFacts(s)).toBeUndefined();
  });

  /* THREE ESCAPES THE IDENTITY FACT REMOVED (mail 0148). Each of these asserted the opposite
     until the fact became the one definition: a domain carrying the brand's token, a Reply-To at
     the brand, and a preview mention beside urgency. */
  it("a sender domain carrying the brand's own token IS the fact now: only the brand's domains own it", () => {
    const s = senderCheck({ ...C, fromAddress: "billing@swisscom-rechnungen.example" });
    expect(s.impersonation?.brand).toBe("Swisscom");
    expect(s.reasonCode).toBe("impersonation");
  });

  it("a Reply-To at the brand's own domain answers nothing: the fact reads From alone", () => {
    const s = senderCheck({ ...A, replyToAddress: "support@metanet.ch" } as SenderCheckInput);
    expect(s.impersonation?.brand).toBe("Metanet");
  });

  it("a snippet MENTION is advice: with urgency it bounds the suggestion softly, never the fact", () => {
    const mention = {
      fromAddress: "anna@studio-nord.example", fromName: "Anna Brunner",
      subject: "Thursday", snippet: "We finally moved to Swisscom last month, much better.",
    };
    expect(senderCheck(mention).impersonation).toBeUndefined();
    expect(senderCheck(mention).brandMention).toBeUndefined();
    const urgent = senderCheck({ ...mention, snippet: `${mention.snippet} Bitte zahlen Sie sofort.` });
    expect(urgent.impersonation).toBeUndefined();
    expect(urgent.brandMention?.brand).toBe("Swisscom");
    expect(urgent.reasonCode).toBe("brand_mismatch");
    expect(capSuggestion(READS_095, urgent).confidence).toBe(SOFT_CEILING);
    expect(capSuggestion(READS_095, urgent).destination).toBe("ohmail/News");
    expect(senderFacts(urgent)).toContain("the mail names Swisscom, whose own addresses are at");
  });
});

describe("the soft claim — a fact for the prompt, a ceiling and nothing more", () => {
  const soft = senderCheck({
    fromAddress: "post@mailings-eu.example", fromName: "Support",
    subject: "Aarepark AG: Ihr Vertrag läuft ab", snippet: "Bitte erneuern Sie innerhalb von 48 Stunden.",
  });

  it("never quotes the sender's own words into the facts block", () => {
    // `claimed` is a fragment of the RAW subject and the model's copy of the subject has been
    // redacted; carrying it here would route sender text around that sink.
    const facts = senderFacts(soft);
    expect(facts).toContain("does not match the sending domain");
    expect(facts).not.toContain("Aarepark");
  });

  it("names the claim it could not match, and does not call it forgery", () => {
    expect(soft.brandMismatch?.claimed).toBe("Aarepark AG");
    expect(soft.impersonation).toBeUndefined();
    expect(soft.reasonCode).toBe("brand_mismatch");
  });

  it("bounds an admitting pile at the ceiling and moves nothing", () => {
    const capped = capSuggestion(READS_095, soft);
    expect(capped.destination).toBe("ohmail/News");
    expect(capped.confidence).toBe(SOFT_CEILING);
    expect(capped.rationale).toBe(READS_095.rationale);
    expect(capped.reasonCode).toBe("brand_mismatch");
  });

  it("leaves a Quarantine answer and an already-quiet number alone", () => {
    expect(capSuggestion({ ...READS_095, destination: "ohmail/Quarantine", spam: true }, soft).confidence)
      .toBe(0.95);
    expect(capSuggestion({ ...READS_095, confidence: 0.3 }, soft).confidence).toBe(0.3);
  });

  it("stays silent without urgency beside it", () => {
    const quiet = senderCheck({
      fromAddress: "post@mailings-eu.example", fromName: "Support",
      subject: "Aarepark AG: Unsere Neuigkeiten", snippet: "Lesen Sie, was diesen Monat passiert ist.",
    });
    expect(quiet.brandMismatch?.claimed).toBe("Aarepark AG");
    expect(quiet.reasonCode).toBeUndefined();
    expect(capSuggestion(READS_095, quiet)).toBe(READS_095);
  });

  it("does not fire on a generic service word or on the sender's own name", () => {
    expect(senderCheck({
      fromAddress: "info@aarepark.example", fromName: "Aarepark Kundensupport",
      subject: "Aarepark: Ihr Vertrag läuft ab", snippet: "Bitte erneuern.",
    }).brandMismatch).toBeUndefined();
    expect(senderCheck({
      fromAddress: "info@mailings-eu.example", fromName: "Kundensupport",
      subject: "Ihr Vertrag läuft ab", snippet: "Bitte erneuern.",
    }).brandMismatch).toBeUndefined();
  });
});

describe("the authentication verdict — read, never required", () => {
  it("a failed verdict caps on its own", () => {
    const s = senderCheck({ ...A, fromAddress: "anna@studio-nord.example", fromName: "Anna",
      subject: "Thursday", snippet: "", authVerdict: "fail" });
    expect(s.auth).toBe("fail");
    expect(s.reasonCode).toBe("auth_fail");
    expect(capSuggestion(READS_095, s).destination).toBe("ohmail/Quarantine");
  });

  it("NULL is permissive and every other member decides nothing by itself", () => {
    for (const v of [null, undefined, "", "unsigned", "unavailable", "temperror", "aligned",
      "signed_unaligned"]) {
      const s = senderCheck({
        fromAddress: "anna@studio-nord.example", fromName: "Anna Brunner",
        subject: "Thursday", snippet: "Are you free?", authVerdict: v as string | null,
      });
      expect(s.reasonCode).toBeUndefined();
      expect(capSuggestion(READS_095, s)).toBe(READS_095);
    }
  });

  it("states an unsigned verdict to the model when a brand is claimed", () => {
    const facts = senderFacts(senderCheck({ ...A, authVerdict: "unsigned" }));
    expect(facts).toContain("authentication of the claimed author: unsigned");
  });
});

describe("the dictionary", () => {
  it("carries no row without a domain, and no domain that is not registrable", () => {
    expect(BRANDS.length).toBeGreaterThanOrEqual(60);
    for (const b of BRANDS) {
      expect(b.domains.length, b.name).toBeGreaterThan(0);
      for (const d of b.domains) {
        expect(d, `${b.name} ${d}`).toBe(d.toLowerCase());
        expect(registrableDomain(d), `${b.name} ${d}`).toBe(d);
      }
    }
  });

  it("never claims a brand's own mail is impersonating it — a shared provider's domain owns nothing", () => {
    for (const b of BRANDS) {
      // The seven shared domains are pinned apart (`brands-gate-needles.test.ts`): anyone can
      // register an address there, so the brand's name on one is the fact by design.
      for (const d of b.domains.filter((x) => !isSharedProviderDomain(x))) {
        const s = senderCheck({
          fromAddress: `service@${d}`, fromName: b.name,
          subject: `${b.name}: Ihre Rechnung ist überfällig`, snippet: "Bitte zahlen Sie sofort.",
        });
        expect(s.impersonation, `${b.name} ${d}`).toBeUndefined();
      }
    }
  });
});

describe("the identity fact — claimedIdentity, the one definition the gate reads", () => {
  const fact = (fromName: string | null, fromAddress: string, subject = "Hallo") =>
    claimedIdentity({ fromName, fromAddress, subject });

  it("a reported phish: PostFinance by name at gmail.com", () => {
    expect(fact("PostFinance", personalAt("fixture.mila", GMAIL),
      "Bitte bestätigen: Reaktivierung Ihrer PostFinance Karte erforderlich"))
      .toEqual({ brand: "PostFinance", via: "name" });
    expect(fact("PostFinance", "info@postfinance.ch")).toBeUndefined();
  });

  it("folds every disguise of the name onto the needle (acceptance 12)", () => {
    for (const name of [
      "\u0420\u043Estfinance", "PostF\u0131nance", "Post\u200BFinance", "Post\u00ADFinance",
      "\uFF30\uFF4F\uFF53\uFF54\uFF26\uFF49\uFF4E\uFF41\uFF4E\uFF43\uFF45",
      "PostFinanceCard | PostFinance", "MyPostFinance", "P0stFinance", "Post-Finance", "Post Finance",
      "P.o.s.t.F.i.n.a.n.c.e", "PostFinanceCH", "P\u00F6stFinance",
    ]) {
      expect(fact(name, SENDER)?.brand, JSON.stringify(name)).toBe("PostFinance");
    }
  });

  it("reads EVERY occurrence: a 5-letter needle glued first and standing second (the loop's own case)", () => {
    // TWINT is under the skeleton's six letters, so only the occurrence loop finds the second hit.
    expect(fact("TWINTPay | TWINT", SENDER)?.brand).toBe("TWINT");
    expect(fact("TWINTPay", SENDER)).toBeUndefined();
  });

  it("the local part speaks beside any name; the subject only through its lead-in", () => {
    expect(fact(null, `postfinance.kundendienst@${GMAIL}`)).toEqual({ brand: "PostFinance", via: "local_part" });
    expect(fact("Hans Muster", `postfinance.kundendienst@${GMAIL}`)).toEqual({ brand: "PostFinance", via: "local_part" });
    expect(fact("Hans Muster", "hans.muster@mail.example")).toBeUndefined();
    expect(fact("Kartenservice", SENDER, "PostFinance: Reaktivierung Ihrer Karte"))
      .toEqual({ brand: "PostFinance", via: "subject_lead" });
    expect(fact("Finanzblog", "news@finanzblog.example", "PostFinance erhöht die Gebühren")).toBeUndefined();
    // NFKC before the lead-in shape: a full-width P and colon are the lead-in they imitate.
    expect(fact("Kartenservice", SENDER, "\uFF30ostFinance\uFF1A Konto gesperrt"))
      .toEqual({ brand: "PostFinance", via: "subject_lead" });
  });

  it("a short needle claims only beside a service word", () => {
    expect(fact("ING Kundenservice", SENDER)?.brand).toBe("ING");
    expect(fact("UBS Sicherheit", SENDER)?.brand).toBe("UBS");
    expect(fact("Ing. Peter Gruber", "p.gruber@mail.example")).toBeUndefined();
    expect(fact("Meta Brunner", personalAt("fixture.meta", GMAIL))).toBeUndefined();
  });

  it("a shared provider owns no brand; Reply-To and token domains own nothing either (acceptance 13)", () => {
    expect(fact("Apple Support", personalAt("fixture.reto", "icloud.com"))?.brand).toBe("Apple");
    expect(fact("Apple ID", personalAt("fixture.reto", "icloud.com"))?.brand).toBe("Apple");
    expect(fact("iCloud Support", personalAt("fixture.reto", "icloud.com"))?.brand).toBe("Apple");
    expect(fact("Microsoft Konto", personalAt("fixture.reto", "outlook.com"))?.brand).toBe("Microsoft");
    expect(fact("Swisscom", personalAt("fixture.reto", "bluewin.ch"))?.brand).toBe("Swisscom");
    expect(fact("PostFinance", "info@postfinance-sicherheit.example")?.brand).toBe("PostFinance");
    expect(fact("Microsoft 365", "admin@x.onmicrosoft.example")?.brand).toBe("Microsoft");
    expect(fact("Google", "group@googlegroups.example")?.brand).toBe("Google");
  });

  it("a brand that names another owns the address for both (a brand at its own domain is not a fact by the brand inside its name)", () => {
    expect(fact("Deutsche Telekom", "info@telekom.de")).toBeUndefined();
    expect(fact("Migros Bank", "info@migrosbank.ch")).toBeUndefined();
  });

  it("a second brand excuses the claim only where its match overlaps the owning brand's: the relay shapes hold", () => {
    for (const [name, from] of [
      ["PostFinance Sicherheit (via Google Drive)", "drive-shares-dm-noreply@google.com"],
      ["PostFinance via DocuSign", "dse@docusign.net"],
      ["PostFinance Kartenservice via Booking.com", "x@guest.booking.example"],
      ["PostFinance (via LinkedIn)", "messages-noreply@linkedin.com"],
      ["PostFinance via PayPal", "service@paypal.com"],
      ["PostFinance Microsoft 365", "x@microsoft.com"],
    ] as const) {
      expect(fact(name, from), name).toEqual({ brand: "PostFinance", via: "name" });
    }
    // A brand named inside the address's own match is its owner: no fact.
    expect(fact("Migros Bank", "info@migrosbank.ch")).toBeUndefined();
    expect(fact("Google Drive", "drive-shares-dm-noreply@google.com")).toBeUndefined();
    // A relay's own brand in the name excuses nothing in the subject's lead-in either.
    expect(fact("Kartenservice (via Google Drive)", "drive-shares-dm-noreply@google.com",
      "PostFinance: Kontoverifizierung")).toEqual({ brand: "PostFinance", via: "subject_lead" });
  });

  it("the advice keeps the base's cap on a relay shape: the first brand wins and the answer is capped", () => {
    const s = senderCheck({
      fromName: "PostFinance Sicherheit (via Google Drive)", fromAddress: "drive-shares-dm-noreply@google.com",
      subject: "Dokument freigegeben: Kontoverifizierung", snippet: "",
    });
    expect(s.impersonation?.brand).toBe("PostFinance");
    expect(s.reasonCode).toBe("impersonation");
    expect(capSuggestion(READS_095, s).destination).toBe("ohmail/Quarantine");
  });

  it("the local part claims beside any name, an invisible or punctuation-only name included", () => {
    expect(fact("\u200B", `postfinance.service@${GMAIL}`)).toEqual({ brand: "PostFinance", via: "local_part" });
    expect(fact(".", `postfinance.service@${GMAIL}`)).toEqual({ brand: "PostFinance", via: "local_part" });
    expect(fact("Kundendienst", `postfinance.kundendienst@${GMAIL}`)).toEqual({ brand: "PostFinance", via: "local_part" });
    expect(fact("Anna Brunner", "anna.brunner@mail.example")).toBeUndefined();
    expect(fact("PostFinance", "postfinance.news@postfinance.ch")).toBeUndefined();
  });

  it("the lead-in past reply prefixes, in a tag, before a pipe, in any case and in quotes", () => {
    for (const subject of [
      "Re: PostFinance: Reaktivierung Ihrer Karte", "AW: PostFinance - Reaktivierung", "WG: PostFinance: Ihre Karte",
      "Fwd: PostFinance: Ihre Karte", "RE: AW: PostFinance: Ihre Karte", "[PostFinance] Reaktivierung Ihrer Karte",
      "[PostFinance Sicherheit] Ihre Karte", "PostFinance | Reaktivierung Ihrer Karte", "postfinance: Reaktivierung Ihrer Karte",
      "\u201EPostFinance\u201C: Ihre Karte", "\u{1F512} PostFinance: Ihre Karte",
    ]) {
      expect(fact("Kartenservice", SENDER, subject), subject).toEqual({ brand: "PostFinance", via: "subject_lead" });
    }
    // A tag that is more than the brand names a list or a repository, not a sender.
    expect(fact("Someone", "notifications@github.com", "Re: [google/zx] Fix the build (#12)")).toBeUndefined();
    expect(fact("Liste", "list@lists.example", "[Swisscom-Kunden] Treffen am Montag")).toBeUndefined();
    expect(fact("Finanzblog", "news@finanzblog.example", "Re: PostFinance erhöht die Gebühren")).toBeUndefined();
  });

  it("1, l and i are one letter and rn is m in the skeleton", () => {
    expect(fact("PostF1nance", SENDER)?.brand).toBe("PostFinance");
    expect(fact("PostFlnance", SENDER)?.brand).toBe("PostFinance");
    expect(fact("Arnazon", SENDER)?.brand).toBe("Amazon");
    expect(fact("Arnold Brunner", "arnold.brunner@mail.example")).toBeUndefined();
  });

  it("rn is m in one reading of the name and never in the brand: a junction keeps the brand's letters", () => {
    for (const [name, brand] of [
      ["YourNetflix", "Netflix"], ["KundencenterNetflix", "Netflix"], ["Ihr N.e.t.f.l.i.x Konto", "Netflix"],
      ["ElsterNachricht", "ELSTER"], ["E L S T E R Nachricht", "ELSTER"], ["IhrHetznerTeam", "Hetzner"],
      ["Hetzner Nachricht", "Hetzner"], ["HostingerNachricht", "Hostinger"], ["Ihr Hostinger Newsletter", "Hostinger"],
      ["YourNamecheap", "Namecheap"], ["Arnazon", "Amazon"],
    ] as const) {
      expect(fact(name, "service@partner-firma.example")?.brand, name).toBe(brand);
    }
    // The brand's skeleton keeps its rn, so a name that only folds onto it names nobody.
    expect(fact("Stucki Amanda", "stucki.amanda@mail.example")).toBeUndefined();
    expect(fact("Klamath", "info@klamath.example")).toBeUndefined();
  });

  it("a skeleton match across words begins and ends with whole words", () => {
    for (const [name, brand] of [
      ["Post Finance", "PostFinance"], ["P.o.s.t.F.i.n.a.n.c.e", "PostFinance"], ["E L S T E R Nachricht", "ELSTER"],
    ] as const) {
      expect(fact(name, SENDER)?.brand, name).toBe(brand);
    }
    // The end of one word and the start of the next spell a brand by accident.
    expect(fact("Daniel Sterner", "daniel.sterner@mail.example")).toBeUndefined();
    expect(fact("Stucki Arnaud", "arnaud.stucki@mail.example")).toBeUndefined();
  });

  it("a word glued before a split brand claims it when that word ends with the brand's own first word", () => {
    for (const name of ["MyPost Finance", "MeinPost Finance", "IhrPost-Finance", "MyP0st Finance"]) {
      expect(fact(name, "service@partner-firma.example"), name).toEqual({ brand: "PostFinance", via: "name" });
    }
    // The match still ends on a whole word, and a brand named in two words keeps the whole-word rule.
    expect(fact("MyPost FinanceX", "service@partner-firma.example")).toBeUndefined();
    // A split inside the brand's own first word leaves no glued word before it.
    expect(fact("Expo Stfinance", "service@partner-firma.example")).toBeUndefined();
    expect(fact("Elodie Post", personalAt("fixture.post", GMAIL))).toBeUndefined();
    expect(fact("Daniel Sterner", "daniel.sterner@mail.example")).toBeUndefined();
    expect(fact("Stucki Arnaud", "arnaud.stucki@mail.example")).toBeUndefined();
  });

  it("a local part claims a brand only as whole tokens, never inside a word", () => {
    expect(fact("IT Support", "administrator@firma.example")).toBeUndefined();
    expect(fact(null, "revolution@firma.example")).toBeUndefined();
    expect(fact(null, "mynetflix@firma.example")).toBeUndefined();
    expect(fact(null, "netflix-billing@firma.example")).toEqual({ brand: "Netflix", via: "local_part" });
    expect(fact(null, "post.finance@firma.example")).toEqual({ brand: "PostFinance", via: "local_part" });
    expect(fact(null, "paypai_support@firma.example")?.brand).toBe("PayPal");
    expect(fact(null, "arnazon+konto@firma.example")?.brand).toBe("Amazon");
    expect(fact(null, "ubs-sicherheit@firma.example")?.brand).toBe("UBS");
    expect(fact(null, "ubs@firma.example")).toBeUndefined();
  });

  it("a lead-in claims whole words: the dotted, spaced and glued forms hold, a word that only contains a brand does not", () => {
    for (const subject of [
      "PostFinance: Reaktivierung Ihrer Karte", "[PostFinance] Reaktivierung Ihrer Karte", "P.o.s.t.F.i.n.a.n.c.e: Ihre Karte",
      "P o s t F i n a n c e: Ihre Karte", "Post Finance: Ihre Karte", "Post-Finance: Ihre Karte", "MyPostFinance: Ihre Karte",
      "PostFinanceCH: Ihre Karte", "PostFinanceCard: gesperrt", "P0stFinance: Ihre Karte", "\u0420\u043Estfinance: Konto gesperrt",
    ]) {
      expect(fact("Kartenservice", SENDER, subject), subject).toEqual({ brand: "PostFinance", via: "subject_lead" });
    }
    expect(fact("Info", SENDER, "YourNetflix: Zahlung fehlgeschlagen")?.brand).toBe("Netflix");
    expect(fact("Info", SENDER, "E L S T E R: Ihr Bescheid")?.brand).toBe("ELSTER");
    expect(fact("Info", SENDER, "Office 365: Ihr Konto")?.brand).toBe("Microsoft");
    for (const subject of [
      "administrator: update for next week", "Administrator: Ihr Postfach ist voll", "revolution: update for next week",
      "counterrevolution: update", "Amazons: update for next week", "googled: update for next week",
    ]) {
      expect(fact("Anna Keller", "anna@firma.example", subject), subject).toBeUndefined();
    }
  });

  /* A CRAFTED INPUT IS READ IN BOUNDED TIME (thousands of characters each, and as many the fold expands): every
     reading stops at twice the longest needle and a local part is read to 256 units after the fold,
     so the fastest of three calls stays under a bound the unbounded reading exceeds several times
     over (measured unbounded: the name about 1 s, the subject about 100 ms, the local part out of
     memory, the expanding characters seconds and hundreds of MB). The real claim at the end of a name
     or of a 256-unit local part, or in the lead-in, is still found. */
  const fastest = (f: () => unknown): number => {
    let best = Infinity;
    for (let k = 0; k < 3; k++) { const t = performance.now(); f(); best = Math.min(best, performance.now() - t); }
    return best;
  };
  const CRAFTED_NAME = "a".repeat(2000) + " ubs".repeat(250);
  const CRAFTED_LOCAL = "ab1cd2".repeat(500);
  const CRAFTED_SUBJECT = "Aa" + " ".repeat(2997) + "x";

  it("a crafted name of 3,000 characters claims nothing within 250 ms, and a brand at its end is found", () => {
    expect(CRAFTED_NAME).toHaveLength(3000);
    expect(fastest(() => expect(fact(CRAFTED_NAME, SENDER)).toBeUndefined())).toBeLessThan(250);
    expect(fact(`${CRAFTED_NAME.slice(0, 2988)} PostFinance`, SENDER)).toEqual({ brand: "PostFinance", via: "name" });
  });

  it("a crafted local part of 3,000 characters claims nothing within 100 ms, and a brand ending its first 256 units is found", () => {
    expect(CRAFTED_LOCAL).toHaveLength(3000);
    expect(fastest(() => expect(fact("Crafted Sender", `${CRAFTED_LOCAL}@example.com`)).toBeUndefined())).toBeLessThan(100);
    expect(fact(null, `${CRAFTED_LOCAL.slice(0, 244)}.postfinance@${GMAIL}`)).toEqual({ brand: "PostFinance", via: "local_part" });
    expect(fact(null, `${CRAFTED_LOCAL.slice(0, 2988)}.postfinance@${GMAIL}`)).toBeUndefined();
  });

  it("a local part of 4,096 characters the fold expands claims nothing within 100 ms", () => {
    // ⒜…⒵ fold to (a)…(z): three units each, every letter its own token.
    const paren = Array.from({ length: 4096 }, (_, i) => String.fromCodePoint(0x249c + ((i * 7 + (i >> 3)) % 26))).join("");
    expect(fastest(() => expect(fact("Crafted Sender", `${paren}@example.com`)).toBeUndefined())).toBeLessThan(100);
  });

  it("a local part and a name are read to their cap after the fold: a brand past it is not a claim, one inside it is", () => {
    expect(fact(null, `${"⒜".repeat(80)}.postfinance@${GMAIL}`)).toEqual({ brand: "PostFinance", via: "local_part" });
    expect(fact(null, `${"⒜".repeat(100)}.postfinance@${GMAIL}`)).toBeUndefined();
    expect(fact(`${"⒜".repeat(1300)} PostFinance`, SENDER)).toEqual({ brand: "PostFinance", via: "name" });
    expect(fact(`${"⒜".repeat(1400)} PostFinance`, SENDER)).toBeUndefined();
  });

  it("a local part with more runs than the belt stores still has every word and every short run read", () => {
    expect(fact(null, `${"a.".repeat(122)}postfinance@${GMAIL}`)).toEqual({ brand: "PostFinance", via: "local_part" });
    expect(fact(null, `${"a.".repeat(117)}p.o.s.t.f.i.n.a.n.c.e@${GMAIL}`)).toEqual({ brand: "PostFinance", via: "local_part" });
  });

  it("a crafted subject of 3,000 characters claims nothing within 40 ms, and a lead-in naming the brand is found", () => {
    expect(CRAFTED_SUBJECT).toHaveLength(3000);
    expect(fastest(() => expect(fact("Anna", SENDER, CRAFTED_SUBJECT)).toBeUndefined())).toBeLessThan(40);
    expect(fact("Anna", SENDER, `PostFinance: Ihre Karte${CRAFTED_SUBJECT.slice(23)}`)).toEqual({ brand: "PostFinance", via: "subject_lead" });
  });

  it("an input past its cap is read to the cap: a brand beyond it is not a claim, one inside it is", () => {
    const pad = "x ".repeat(2100);
    expect(fact(`${pad}PostFinance`, SENDER)).toBeUndefined();
    expect(fact(`PostFinance ${pad}`, SENDER)).toEqual({ brand: "PostFinance", via: "name" });
  });

  it("Post CH claims as its two tokens or fused, followed by a non-letter, never inside a word", () => {
    for (const name of ["Post CH", "Post-CH", "PostCH Kundendienst", "Die Post CH"]) {
      expect(fact(name, SENDER)?.brand, name).toBe("Die Post");
    }
    expect(fact(null, `postch@${GMAIL}`)?.brand).toBe("Die Post");
    expect(fact("Post Chalet", `post.x7@${GMAIL}`)).toBeUndefined();
    expect(fact("Shop", "news@shop.example", "Post-Christmas Sale: 20% auf alles")).toBeUndefined();
    expect(fact("Bank", "info@bank.example", "Postcheck-Konto: Ihr Auszug")).toBeUndefined();
  });

  it("Apple Support, Apple ID and Post CH claim; bare DHL and UBS stay advice", () => {
    expect(fact("Apple Support", SENDER)?.brand).toBe("Apple");
    expect(fact("Apple ID", SENDER)?.brand).toBe("Apple");
    expect(fact("Post CH", SENDER)?.brand).toBe("Die Post");
    expect(fact("Info", SENDER, "Post CH: Ihr Paket wartet")).toEqual({ brand: "Die Post", via: "subject_lead" });
    expect(fact("Apple Support", "support@apple.com")).toBeUndefined();
    expect(fact("Post CH", "noreply@post.ch")).toBeUndefined();
    expect(fact("Apple Pie Café", "hello@applepie.example")).toBeUndefined();
    expect(fact("DHL", SENDER)).toBeUndefined();
    expect(fact("UBS", SENDER)).toBeUndefined();
  });

  it("the customer-mail domains are shared providers: o2online.de owns no brand", () => {
    for (const d of [
      "protonmail.ch", "magenta.de", "mail.de", "email.de", "kabelmail.de", "aol.de", "posteo.ch", "posteo.at",
      "posteo.net", "keemail.me", "freenetmail.de", "green.ch", "netplus.ch", "quickline.ch", "o2online.de",
    ]) {
      expect(isSharedProviderDomain(d), d).toBe(true);
    }
    expect(fact("O" + "2 Kundenservice", "x@o2online.de")?.brand).toBe("O" + "2");
  });

  it("identityOfRow: the column when checked, the function when the row never was", () => {
    const row = { fromName: "PostFinance", fromAddress: SENDER, subject: "Hallo" };
    expect(identityOfRow({ ...row, senderCheck: null, senderCheckBrand: null })?.brand).toBe("PostFinance");
    expect(identityOfRow({ ...row, senderCheck: "none", senderCheckBrand: null })).toBeNull();
    expect(identityOfRow({ fromName: "Anna", fromAddress: personalAt("fixture.anna", GMAIL), subject: "Hi",
      senderCheck: "impersonation", senderCheckBrand: "UBS" })?.brand).toBe("UBS");
    expect(identityOfRow({ fromName: "Anna", fromAddress: personalAt("fixture.anna", GMAIL), subject: "Hi",
      senderCheck: null, senderCheckBrand: null })).toBeNull();
  });

  it("senderCheckAll's impersonation is the fact and nothing else", () => {
    const s = senderCheck({ fromAddress: SENDER, fromName: "PostFinance", subject: "Hallo", snippet: "" });
    expect(s.impersonation).toEqual({ brand: "PostFinance", brandDomains: ["postfinance.ch"] });
    const advice = senderCheck({ fromAddress: SENDER, fromName: "Sunrise", subject: "Hallo", snippet: "" });
    expect(advice.impersonation, "an advice-only row never makes the fact").toBeUndefined();
    expect(advice.brandMention?.brand).toBe("Sunrise");
  });
});
