import { describe, it, expect } from "vitest";
import { SCREENING_PREFIX, classifyUserPayload } from "../src/ai/classify.js";
import { askScreeningQuestion } from "../src/classify-prompt.js";
import type { ClassifierInput } from "../src/classifier-port.js";

describe("authentication mail uses the ordinary model input", () => {
  const mail = { subject: "Your verification code", snippet: "Your one-time passcode is 482913." };

  it("builds the routing request for a sign-in message", () => {
    expect(classifyUserPayload({ from: { name: null, address: "sender@example.test" }, ...mail, headersDigest: "" }))
      .toMatchObject({ subject: mail.subject, snippet: "Your one-time passcode is [code]." });
  });

  it("suggests using the original preview after checking consent", async () => {
    const seen: ClassifierInput[] = [];
    const steps: string[] = [];
    const result = { destination: "ohmail/News" as const, confidence: 0.9, rationale: "service notice", spam: false };
    const classify = async (input: ClassifierInput) => {
      steps.push("model");
      seen.push(input);
      return result;
    };
    await expect(askScreeningQuestion({ classify, screen: classify }, { ...mail, fromAddress: "sender@example.test" }, {
      beforeDispatch: async () => { steps.push("consent"); },
    })).resolves.toEqual(result);
    expect(steps).toEqual(["consent", "model"]);
    expect(seen).toEqual([expect.objectContaining(mail)]);
  });
});

describe("credential and ordinary content in the same model input", () => {
  it.each([
    ["Your sign-in code", "JQ" + "8PS. Order 784561. Total $43.50. Valid on 2026-11-25.", "[code]. Order [code]. Total $43.50. Valid on [code]."],
    ["Dein Anmeldecode", "814729. Bestellung 475831 vom 25.11.2026 für 23,90 €.", "[code]. Bestellung [code] vom 25.11.[code] für 23,90 €."],
    ["Bestellung 475831 bestätigt", "Bestellnummer 475831, Rabattcode WINTER25, Zahlung 23,90 €.", "Bestellnummer 475831, Rabattcode WINTER25, Zahlung 23,90 €."],
    ["Your sign-in code", "Order 784561. Your code is 654321. Help: https://news.example.test/offers?code=WINTER" + "25", "Order [code]. Your code is [code]. Help: https://news.example.test/[link]"],
    ["Dein Bestätigungscode", "Benutze den folgenden Code: ３８４９３２.", "Benutze den folgenden Code: [code]."],
    ["Login verification", "Token: eyJhbGciOiJIUzI1NiJ9.dGVzdC1leGFtcGxl.Q29tcGFjdFNpZw.", "Token: [code]."],
    ["Your one-time code", "Please enter the code below.\n934871\nKeep it private.", "Please enter the code below.\n[code]\nKeep it private."],
    ["Your order confirmation", "Order confirmation number 475831. Offer code WINTER25.", "Order confirmation number 475831. Offer code WINTER25."],
    ["Passwort zurücksetzen", "Reset-Token: yarrow-indigo-velvet.", "Reset-Token: [code]."],
    ["Your verification code", "Use 384 932 to verify your account.", "Use [code] to verify your account."],
    ["Sign in to your account", "Continue: https://account.example.test/login#access_token=plum-stone", "Continue: https://account.example.test/[link]"],
    ["Sign in to your account", "One-click sign-in: https://account.example.test/login/kite" + "83", "One-click sign-in: https://account.example.test/[link]"],
    ["Set a new password", "Continue: https://relay.example.test/click?url=" + encodeURIComponent("https://account.example.test/password-reset?token=violet-cedar"), "Continue: https://relay.example.test/[link]"],
    ["Read the account guide", "See https://help.example.test/articles/reset-your-password and https://account.example.test/login.", "See https://help.example.test/articles/reset-your-password and https://account.example.test/login."],
  ])("redacts according to the mail cues in %s", (subject, snippet, expected) => {
    const input = { from: { name: null, address: "sender@example.test" }, subject, snippet, headersDigest: "" };
    expect(classifyUserPayload(input)).toMatchObject({ subject, snippet: expected });
    expect(input.snippet).toBe(snippet);
  });
});

it("removes credentials from readable embedded mail while keeping an unrelated encoded passage", () => {
  const encodedMail = Buffer.from("Your sign-in code is 674219. Orders stay in Receipts.").toString("base64");
  const ordinary = Buffer.from("A paragraph about a museum and its history.").toString("base64");
  const preview = `Forwarded message: ${encodedMail} / ${ordinary}`;
  const input = { from: { name: null, address: "sender@example.test" }, subject: "Forwarded note", snippet: preview, headersDigest: "" };
  const payload = classifyUserPayload(input);
  expect(payload.snippet).toBe(`Forwarded message: Your sign-in code is [code]. Orders stay in Receipts. / ${ordinary}`);
  expect(input.snippet).toBe(preview);
});

describe("the screening question — the Ohbox bar raised in a report", () => {
  /**
   * These are CRITERIA assertions, not copy assertions, and the distinction is why each one names
   * a mechanism rather than a sentence. The prompt is prose and will be reworded; what may not
   * change without a decision is that it still tells the model these four things.
   *
   * Each was written against a measured failure on a live account, listed with it.
   */
  it("states that automated service mail is never the Ohbox, consequence or not", () => {
    // MEASURED: of the senders the model filed to INBOX, several were automated notifications, and the
    // rationales cited the old clause by name — "a service notification with a consequence if
    // ignored". An expired card and a nearly-full storage warning both landed at high confidence.
    expect(SCREENING_PREFIX).toMatch(/AUTOMATED SERVICE MAIL IS NEVER THE OHBOX/);
    // …and the specific reasoning that has to be blocked, not just the headline.
    expect(SCREENING_PREFIX).toMatch(/consequence/i);
    expect(SCREENING_PREFIX).toMatch(/who WROTE it/);
    // The old clause itself must be gone. This is the half a reword could silently restore.
    expect(SCREENING_PREFIX).not.toMatch(/service mail they personally have to\s*\n?\s*act on/);
  });

  it("names Reads as where automated notifications go, including the urgent-sounding ones", () => {
    // Without a stated home, "not INBOX" has five candidates and the model picks by tone.
    expect(SCREENING_PREFIX).toMatch(/ohmail\/News:[\s\S]*automated notification/);
    expect(SCREENING_PREFIX).toMatch(/urgent-sounding/);
  });

  it("allows Quarantine for bulk commercial mail nobody asked for, on a RELATIONSHIP test", () => {
    // The old text forbade it outright ("Being automated, promotional or unwanted is NOT
    // enough"), which is why a product newsletter arriving at an address that never subscribed
    // could never be called what it is. The prohibition is replaced by a test rather than
    // removed, because removing it is how every newsletter became spam the first time.
    expect(SCREENING_PREFIX).not.toMatch(/is NOT enough/);
    expect(SCREENING_PREFIX).toMatch(/the RELATIONSHIP/);
    expect(SCREENING_PREFIX).toMatch(/bulk, commercial, and unrequested/);
  });

  it("files a venue's own promotions to Screened rather than Reads", () => {
    // A hotel or restaurant mailing a past guest reads as service mail because the sender is a
    // place the person has been. It is a business selling to someone who is not its customer.
    expect(SCREENING_PREFIX).toMatch(/venue, hotel, restaurant or shop mailing its own promotions/);
    expect(SCREENING_PREFIX).toMatch(/being somewhere once is not a subscription/i);
  });
});

describe("the Screened/Quarantine boundary — the relationship ruling of 2026-08-08", () => {
  /**
   * CRITERIA assertions again, for the boundary the ruling moved. Each names the mechanism the
   * prompt must still carry, and each was written against a measured live answer — the rationale
   * the model actually returned is quoted with it.
   */
  it("gates Screened on a REAL PRIOR RELATIONSHIP rather than on the mail being legitimate", () => {
    // MEASURED: cold BD outreach came back `ohmail/Screened` 0.95 — "it's legitimate business
    // mail, just unwanted" — and a travel site's promo blast came back `ohmail/Screened` 0.95 as
    // "bulk commercial marketing you didn't request". Both were ruled spam.
    expect(SCREENING_PREFIX).toMatch(/ohmail\/Screened: unwanted mail from a business/);
    expect(SCREENING_PREFIX).toMatch(/REAL PRIOR RELATIONSHIP/);
    expect(SCREENING_PREFIX).toMatch(/customer, guest, client or member of/);
    // The contradicting clause must be GONE from the Screened bullet. It named the exact mail the
    // ruling moves, imperatively, while Quarantine claimed it only conditionally — and a model
    // resolving that contradiction takes the imperative branch.
    expect(SCREENING_PREFIX).not.toMatch(/cold sales approaches, unrequested promotions/);
  });

  it("sends UNSOLICITED COMMERCIAL mail to Quarantine, and says legitimacy does not rescue it", () => {
    // This is the sentence that overturns the rationale above. Without it the model has no reason
    // to stop treating "a real company wrote it" as a reason to spare the mail.
    expect(SCREENING_PREFIX).toMatch(/UNSOLICITED COMMERCIAL MAIL/);
    expect(SCREENING_PREFIX).toMatch(/cold sales or\s*\n?\s*business-development outreach from a stranger/);
    expect(SCREENING_PREFIX).toMatch(/real, registered,\s*\n?\s*reputable business does not rescue it/);
    expect(SCREENING_PREFIX).toMatch(/legitimacy is not permission/);
    // Quarantine states the outcome, it does not merely permit it. "Quarantine is available" is
    // what let the imperative Screened clause win.
    expect(SCREENING_PREFIX).not.toMatch(/Quarantine is available/);
  });

  it("makes the relationship provable FROM THE MESSAGE, which is all the model is given", () => {
    // The screening turn carries from/subject/snippet and an empty headersDigest, with no
    // few-shot: "has this person ever booked with them" is unanswerable. So the criterion is
    // evidence in the mail — the discriminator between a hotel writing to a named guest
    // (Screened) and a travel site's generic blast (Quarantine), both plausibly places the
    // person has spent money.
    expect(SCREENING_PREFIX).toMatch(/VISIBLE IN THIS MESSAGE/);
    expect(SCREENING_PREFIX).toMatch(/addresses them by name as a known customer or guest/);
    // …and the same operationalisation on Quarantine's side, which is otherwise equally
    // unanswerable and would rescue the blast.
    expect(SCREENING_PREFIX).toMatch(/shown by this message naming their own account/);
  });

  it("does not spend Receipts' own vocabulary on the two junk bullets", () => {
    // "Order", "booking" and "payment" are the words the RECEIPTS bullet is built from — "order
    // confirmations, invoices, payment and shipping notices, statements, booking
    // confirmations". The first draft of the relationship evidence spent three of them on the
    // two junk bullets ("names a stay, an order, a booking or an account of theirs";
    // "naming their account, their order or their subscription"), which is hygiene worth
    // keeping: bullets in a single block compete for the same words.
    //
    // **It is NOT a fix for the receipt regression, and saying so would be a false claim.**
    // A Google Cloud payment confirmation moved from ohmail/Receipts 0.99 to ohmail/News 0.98
    // when this calibration landed, and removing the vocabulary collision did not move it back —
    // measured over four live runs. The model's own rationale points somewhere else entirely
    // ("it's not from a person, so it belongs in Reads per your own Ohbox rule"), i.e. at the
    // automated-mail rule, not at these bullets. The deviation is reported rather than tuned
    // around; see the docblock in `classify-prompt.ts`.
    const junkBullets = SCREENING_PREFIX.slice(
      SCREENING_PREFIX.indexOf("- ohmail/Screened:"),
      SCREENING_PREFIX.indexOf("Set \"spam\" true"),
    );
    expect(junkBullets).not.toMatch(/\bbooking\b/i);
    // The NOUN, not the "in order to sell" adverbial the same bullet needs — a bare /\border\b/
    // fires on that and would make this guard unmaintainable rather than strict.
    expect(junkBullets).not.toMatch(/\b(?:an|their|the)\s+orders?\b/i);
    expect(junkBullets).not.toMatch(/\bpayment\b/i);
  });

  it("qualifies the personal-stranger clause by PURPOSE instead of deleting it", () => {
    // Deleting it re-opens a measured failure: a tightening of this bullet once pulled a real
    // person out of the Ohbox at 0.72 for lacking a relationship, taking the set 17/18 → 15/18.
    expect(SCREENING_PREFIX).toMatch(/personally about anything other\s*\n?\s*than selling is not junk/);
    expect(SCREENING_PREFIX).toMatch(/IN ORDER TO\s*\n?\s*SELL is/);
  });

  it("keeps RELATIONSHIP language out of the INBOX criteria", () => {
    // The failure mode this prevents: let the word escape into the person-to-person bullet and
    // the model starts demanding a relationship of PEOPLE, gutting "whether or not they have
    // met". Asserted structurally — the INBOX bullet is the text before the Reads bullet.
    const inboxBullet = SCREENING_PREFIX.slice(
      SCREENING_PREFIX.indexOf("- INBOX:"),
      SCREENING_PREFIX.indexOf("- ohmail/News:"),
    );
    expect(inboxBullet).toMatch(/whether or not they have met/);
    expect(inboxBullet).not.toMatch(/relationship/i);
  });

  it("memorises no sender — the criteria generalise, and the cache is shared besides", () => {
    // The two senders the ruling came from are on ONE account, and this constant is sent with
    // `cache_control:{type:"ephemeral"}` across all of them. Naming them here would be both
    // example-memorisation and one account's data on another account's request.
    expect(SCREENING_PREFIX).not.toMatch(/easemytrip|orbitprism|amrai|giants-software/i);
  });

  it("still carries NO account's words — the prefix is cached across accounts", () => {
    // The invariant the calibration must not break: this constant is sent with
    // `cache_control:{type:"ephemeral"}` and that cache is shared, so one account's bar embedded
    // here would be served on another's request. The instruction may name the field; never its
    // value.
    expect(SCREENING_PREFIX).toMatch(/If the user turn carries an "ohboxBar" field/);
    expect(SCREENING_PREFIX).not.toMatch(/Keep my Ohbox/);
    expect(SCREENING_PREFIX).not.toMatch(/\bmila\b|trafficflow/i);
  });
});
