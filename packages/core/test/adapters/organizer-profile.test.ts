import { describe, expect, it } from "vitest";
import {
  PROFILE_VERSION,
  canonicalizeProfilePayload,
  formatProfileMessage,
  isEmptyProfilePayload,
  makeProfileDoc,
  makeProfileIo,
  parseProfileMessage,
  localSaysWhatAFingerprintSays,
  profileFingerprint,
  profileGateView,
  readOrganizerProfile,
  writeOrganizerProfile,
  isMalformedProfile,
  type OrganizerProfilePayload,
  type ProfileIo,
  type RawProfileMessage,
} from "../../src/adapters/organizer-profile.js";
import { formatClaim, parseClaim } from "../../src/adapters/organizer-lease.js";
import { resetMetaMemos } from "../../src/adapters/meta-memo.js";
import { memoryImapServer } from "./_metaworld.js";

/**
 * THE PORTABLE ORGANIZER PROFILE — the format half, pure.
 *
 * The document is a PUBLIC format (the published source is its spec), so these tests are the
 * spec's teeth: round-trip by natural keys, unknown-field tolerance (a v1 reader must survive a
 * v2 producer's decorations), the `newer` refusal in BOTH the read and the write, the
 * append-then-expunge dance leaving exactly one current document, and the co-tenancy rule — the
 * profile and the organizer lease share `ohmail/_meta` and each must be invisible to the other's
 * parser and untouchable by the other's writer.
 */

/** A rich payload exercising every section and every optional field. */
function richPayload(): OrganizerProfilePayload {
  return {
    screener: [
      { address: "anna@example.com", name: "Anna" },
      { address: "bob@example.com" },
    ],
    rules: [
      {
        kind: "sender", match: "news@letters.example", destination: "ohmail/Reads",
        priority: 0, enabled: true, provenance: "promoted",
      },
      {
        kind: "domain", match: "shop.example", destination: "ohmail/Receipts",
        priority: 1, enabled: true, provenance: "manual", subjectContains: "order",
      },
      {
        kind: "sender", match: "alerts@host.example", destination: "ohmail/Screened",
        priority: 0, enabled: false, provenance: "manual", bodyContains: "[NinjaFirewall]",
      },
    ],
    notifyRules: [{ kind: "sender", target: "boss@example.com" }],
    awayResponder: {
      // No `subject` since mail 0087 — the responder is reply-only and derives `Re: <theirs>`.
      // `throttle` travels in its place: how often ONE PERSON may be answered.
      enabled: true, body: "Back on Monday.",
      startsAt: "2026-08-01T00:00:00.000Z", endsAt: "2026-08-20T00:00:00.000Z",
      audience: "screened_in", throttle: "per_day",
    },
    tagNames: ["Invoices", "travel"],
    signature: null,
  };
}

const PRODUCER = { kind: "local", version: "0.0.0" };
const AT = new Date("2026-08-17T10:00:00.000Z");

/** One in-memory `ohmail/_meta` implementing ProfileIo — the worker fake's shape, format-local. */
class MemMeta implements ProfileIo {
  private nextUid = 1;
  readonly messages: RawProfileMessage[] = [];
  appends = 0;
  /**
   * THE FOLDER'S GENERATION, HELD AS STATE so a test can move it — a fixture with no UIDVALIDITY
   * at all is why this class of defect was unreachable by any test before. It is stamped at LIST
   * time, once for the whole call, which is exactly what the real io does inside its mailbox lock.
   */
  generation: number = 1_000;
  /** Simulate the server renumbering the folder: a new epoch, and the old uids mean nothing. */
  renumber(to: number): void { this.generation = to; }
  async ensureMetaFolder(): Promise<void> { /* idempotent */ }
  async listProfileMessages(): Promise<RawProfileMessage[]> {
    // Stamped HERE, not at append: one SELECT, one generation, every message in the call.
    return this.messages.map((m) => ({ ...m, generation: this.generation }));
  }
  async appendProfile(raw: string): Promise<void> {
    this.appends++;
    this.messages.push({ ref: this.nextUid++, raw, generation: this.generation });
  }
  async removeProfiles(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (gone.has(this.messages[i]!.ref)) this.messages.splice(i, 1);
    }
  }
}

describe("the profile document format", () => {
  it("round-trips: serialize → parse → equal by natural keys, same fingerprint", () => {
    const doc = makeProfileDoc(richPayload(), { updatedAt: AT, producer: PRODUCER });
    const raw = formatProfileMessage(doc, { installId: "install-a" });

    const parsed = parseProfileMessage(raw, 7);
    expect(parsed).not.toBeNull();
    expect(isMalformedProfile(parsed!)).toBe(false);
    if (parsed === null || isMalformedProfile(parsed)) throw new Error("unreachable");
    expect(parsed.status).toBe("ok");
    expect(parsed.installId).toBe("install-a");
    expect(parsed.ref).toBe(7);

    const back = parsed.doc!;
    expect(back.v).toBe(PROFILE_VERSION);
    expect(back.updatedAt).toBe(AT.toISOString());
    // Every copy this build writes states its stamps (mail 0146's `producer.stamped`).
    expect(back.producer).toEqual({ ...PRODUCER, stamped: true });
    // Content equality is fingerprint equality — the same identity the write-behind's dirty
    // check runs on, so this line is the round-trip claim in the form production consumes it.
    expect(profileFingerprint(back)).toBe(profileFingerprint(richPayload()));
    // …and the canonical forms are deep-equal, which localizes a failure to a field.
    expect(canonicalizeProfilePayload(back)).toEqual(canonicalizeProfilePayload(richPayload()));
  });

  it("the fingerprint is order-free and ignores the envelope", () => {
    const a = richPayload();
    const b = richPayload();
    b.screener.reverse();
    b.rules.reverse();
    b.tagNames.reverse();
    expect(profileFingerprint(a)).toBe(profileFingerprint(b));
    // Two writes of the same configuration at different times are the SAME content.
    const d1 = makeProfileDoc(a, { updatedAt: AT, producer: PRODUCER });
    const d2 = makeProfileDoc(a, { updatedAt: new Date("2027-01-01T00:00:00Z"), producer: { kind: "cloud", version: "9" } });
    expect(profileFingerprint(d1)).toBe(profileFingerprint(d2));
  });

  it("an ABSENT away scope and an OMITTED one are one state, and stating one changes the content", () => {
    /**
     * THE COMPATIBILITY RULE OF AN OPTIONAL KEY, AS A FINGERPRINT PROPERTY — the whole of what
     * admitting `piles` into v1 rests on.
     *
     * The fingerprint is compared ACROSS INSTALLS and decides "is the document in the folder
     * already what I have". So a field arriving in the format may not move the fingerprint of a
     * document that does not carry it: an install running this build, reading a profile an older
     * ohmail wrote, must read it as UNCHANGED rather than as a stranger's to be re-published.
     * `richPayload()` has no scope, which is that older document.
     */
    const omitted = richPayload();
    const absent = richPayload();
    // The key PRESENT and undefined — an in-memory payload assembled by a build that knows the
    // field, about a responder that has stated no scope. The same state, and `JSON.stringify`
    // would drop it either way; `canonicalizeProfilePayload` is what has to agree.
    (absent.awayResponder as { piles?: string[] }).piles = undefined;
    expect(Object.hasOwn(absent.awayResponder!, "piles"), "the absent arm is not the present-undefined one")
      .toBe(true);
    expect(profileFingerprint(absent)).toBe(profileFingerprint(omitted));
    expect(canonicalizeProfilePayload(absent).awayResponder)
      .toEqual(canonicalizeProfilePayload(omitted).awayResponder);

    // …and a document that STATES a scope is different content, or the field could not travel:
    // two responders answering different piles are two configurations.
    const stated = richPayload();
    stated.awayResponder!.piles = ["INBOX"];
    expect(profileFingerprint(stated)).not.toBe(profileFingerprint(omitted));
    const narrower = richPayload();
    narrower.awayResponder!.piles = ["ohmail/Reads"];
    expect(profileFingerprint(narrower)).not.toBe(profileFingerprint(stated));
    // An explicit EMPTY list is a real answer — "answer nobody" — and not the unstated state.
    const nobody = richPayload();
    nobody.awayResponder!.piles = [];
    expect(profileFingerprint(nobody)).not.toBe(profileFingerprint(omitted));
    // The scope is a SET: the same members in another order, repeated, are the same content.
    const resorted = richPayload();
    resorted.awayResponder!.piles = ["ohmail/Reads", "INBOX", "INBOX"];
    const sorted = richPayload();
    sorted.awayResponder!.piles = ["INBOX", "ohmail/Reads"];
    expect(profileFingerprint(resorted)).toBe(profileFingerprint(sorted));
  });

  it("a screener entry's source: inferred and absent are one state, a person's travels and parses back", () => {
    /* The fingerprint twin of `source` (mail 0148). `richPayload()`'s entries state none, which is
       the document an older ohmail wrote: stating `inferred` must not move its fingerprint, or every
       such document reads as a stranger's to re-publish. A person's contact is different content. */
    const omitted = richPayload();
    const inferred = richPayload();
    inferred.screener = inferred.screener.map((e) => ({ ...e, source: "inferred" as const }));
    expect(profileFingerprint(inferred)).toBe(profileFingerprint(omitted));
    expect(canonicalizeProfilePayload(inferred).screener).toEqual(canonicalizeProfilePayload(omitted).screener);
    expect(profileFingerprint(inferred, 1)).toBe(profileFingerprint(omitted, 1));

    const person = richPayload();
    person.screener[0] = { ...person.screener[0]!, source: "person" };
    expect(profileFingerprint(person)).not.toBe(profileFingerprint(omitted));
    // …and the key survives the message both ways, spelled as a format word, not escaped.
    const raw = formatProfileMessage(makeProfileDoc(person, { updatedAt: AT, producer: PRODUCER }), { installId: "i" });
    expect(raw).toContain(`"source": "person"`);
    const parsed = parseProfileMessage(raw, 1);
    if (parsed === null || isMalformedProfile(parsed)) throw new Error("the document did not parse");
    expect(parsed.doc!.screener.find((e) => e.address === "anna@example.com")?.source).toBe("person");
    expect(parsed.doc!.screener.find((e) => e.address === "bob@example.com")).toEqual({ address: "bob@example.com" });
    expect(profileFingerprint(parsed.doc!)).toBe(profileFingerprint(person));
  });

  it("the source's arrival is never a question: a document stating none says what a local person's contact says", () => {
    const base = { rules: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null };
    const older = makeProfileDoc({ ...base, screener: [{ address: "anna@example.com" }] }, { updatedAt: AT, producer: PRODUCER });
    const local = { ...base, screener: [{ address: "anna@example.com", source: "person" as const }] };
    expect(localSaysWhatAFingerprintSays(local, profileFingerprint(older))).toBe(true);
    // …a document stating a person's contact the local store holds as inferred is a question,
    const stated = makeProfileDoc({ ...base, screener: [{ address: "anna@example.com", source: "person" }] }, { updatedAt: AT, producer: PRODUCER });
    expect(localSaysWhatAFingerprintSays({ ...base, screener: [{ address: "anna@example.com" }] }, profileFingerprint(stated))).toBe(false);
    // …and so is a different contact.
    expect(localSaysWhatAFingerprintSays({ ...base, screener: [{ address: "bob@example.com", source: "person" }] },
      profileFingerprint(older))).toBe(false);
  });

  it("the import hold reads the entry's source: an unstated entry is an inferred contact, a person's is not", () => {
    const view = profileGateView({
      screener: [{ address: "x@karten-service.test" }, { address: "ines@example.test", source: "person" }],
      rules: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null,
    });
    expect([...view.knownSenders.addresses].sort()).toEqual(["ines@example.test", "x@karten-service.test"]);
    expect([...view.knownSenders.inferred]).toEqual(["x@karten-service.test"]);
  });

  it("the signature's MARKUP is an optional key with the signature's compatibility rule", () => {
    /**
     * `signatureHtml` is `piles`' shape one field over, and it is admitted on `piles`' argument:
     * the plain signature has travelled since mail 0094 and the formatting did not, so a reader
     * showed the organizer's sign-off unformatted and sent it that way — while the READER-to-
     * organizer request payload has carried `signatureHtml` since 2026-09-10, which made the
     * asymmetry a one-way street.
     *
     * The compatibility rule is the same and the arithmetic is what proves it: a document that
     * does not carry the key must fingerprint exactly as it did before the key existed, or every
     * profile an older ohmail wrote reads as a stranger's on the day this build ships.
     */
    /* THE BASELINE CARRIES A SIGNATURE, because the property under test is about a signature's
       FORMATTING and `richPayload()` signs with nothing — a control chosen from a subject that
       lacks the property passes for the wrong reason, and this one did on its first run: every
       markup arm was dropped by the canonical form's no-text rule and two fingerprints that
       should have differed agreed. */
    const signed = (): OrganizerProfilePayload => ({ ...richPayload(), signature: "-- \nJuno" });
    const omitted = signed();
    const absent = signed();
    // The key PRESENT and undefined — this build assembling a payload about a plain signature.
    (absent as { signatureHtml?: string | null }).signatureHtml = undefined;
    expect(Object.hasOwn(absent, "signatureHtml"), "the absent arm is not the present-undefined one")
      .toBe(true);
    expect(profileFingerprint(absent)).toBe(profileFingerprint(omitted));
    // …and an explicit `null` is the same state again: absent, undefined and null are one answer,
    // "this signature is plain text", which is NOT the same as having no signature.
    const explicitNull = signed();
    explicitNull.signatureHtml = null;
    expect(profileFingerprint(explicitNull)).toBe(profileFingerprint(omitted));
    // Blank markup is markup and no sign-off: an empty `<p></p>` must not move the content.
    const blank = signed();
    blank.signatureHtml = "  ";
    expect(profileFingerprint(blank)).toBe(profileFingerprint(omitted));

    // STATING markup IS different content, or the field could not travel at all.
    const stated = signed();
    stated.signatureHtml = "<p>-- <br>Juno</p>";
    expect(profileFingerprint(stated)).not.toBe(profileFingerprint(omitted));
    const other = signed();
    other.signatureHtml = "<p>-- <br><b>Juno</b></p>";
    expect(profileFingerprint(other)).not.toBe(profileFingerprint(stated));

    /* MARKUP WITH NO TEXT BESIDE IT IS NOT A STATE THIS FORMAT EXPRESSES. `withSignature` puts the
       TEXT on the plain body in both branches, so a document offering only the formatted form
       describes a message nobody can send — the canonical form drops it, and the payload is then
       the same content as one with no signature at all. */
    const markupOnly = signed();
    markupOnly.signature = null;
    markupOnly.signatureHtml = "<p>-- <br>Juno</p>";
    const noneAtAll = signed();
    noneAtAll.signature = null;
    expect(profileFingerprint(markupOnly)).toBe(profileFingerprint(noneAtAll));
    expect(Object.hasOwn(canonicalizeProfilePayload(markupOnly), "signatureHtml"),
      "markup rode out with no text under it").toBe(false);
  });

  it("the markup round-trips through a written document, and an absent key round-trips absent", () => {
    const withMarkup: OrganizerProfilePayload = {
      ...richPayload(), signature: "-- \nJuno Marchetti",
      signatureHtml: "<p>-- <br>Juno Marchetti</p>",
    };
    const doc = makeProfileDoc(withMarkup, { updatedAt: AT, producer: PRODUCER });
    expect((doc as unknown as Record<string, unknown>).signatureHtml)
      .toBe("<p>-- <br>Juno Marchetti</p>");
    const back = parseProfileMessage(formatProfileMessage(doc, { installId: "i-1" }));
    if (back === null || isMalformedProfile(back)) throw new Error("the document with markup did not parse");
    expect(back.doc!.signatureHtml).toBe("<p>-- <br>Juno Marchetti</p>");
    expect(profileFingerprint(back.doc!)).toBe(profileFingerprint(withMarkup));

    /* THE OTHER HALF, and it is the one that keeps every already-written document readable: a
       plain signature writes NO key, parses back with no key, and fingerprints as it always did. */
    const plain: OrganizerProfilePayload = { ...richPayload(), signature: "-- \nJuno Marchetti" };
    const plainDoc = makeProfileDoc(plain, { updatedAt: AT, producer: PRODUCER });
    expect(Object.hasOwn(plainDoc, "signatureHtml"), "a plain signature wrote a markup key")
      .toBe(false);
    const plainBack = parseProfileMessage(formatProfileMessage(plainDoc, { installId: "i-1" }));
    if (plainBack === null || isMalformedProfile(plainBack)) throw new Error("the plain document did not parse");
    expect(Object.hasOwn(plainBack.doc!, "signatureHtml"), "an absent key came back present")
      .toBe(false);
    expect(profileFingerprint(plainBack.doc!)).toBe(profileFingerprint(plain));

    // A stranger's document carrying a non-string here is "no markup", never a value in a message.
    const odd = makeProfileDoc(plain, { updatedAt: AT, producer: PRODUCER }) as unknown as Record<string, unknown>;
    odd.signatureHtml = { nope: true };
    const oddBack = parseProfileMessage(formatProfileMessage(odd as never, { installId: "i-1" }));
    if (oddBack === null || isMalformedProfile(oddBack)) throw new Error("a non-string markup key made the document unreadable");
    expect(Object.hasOwn(oddBack.doc!, "signatureHtml")).toBe(false);
  });

  it("a v1 reader tolerates a v1 document decorated with unknown fields at every level", () => {
    const doc = makeProfileDoc(richPayload(), { updatedAt: AT, producer: PRODUCER }) as Record<string, unknown>;
    doc.futureSection = { anything: true };
    (doc.producer as Record<string, unknown>).build = "2026-08-17";
    (doc.screener as Record<string, unknown>[])[0]!.trust = 0.9;
    (doc.rules as Record<string, unknown>[])[0]!.futureTerm = "x";
    (doc.awayResponder as Record<string, unknown>).timezone = "Europe/Zurich";

    const raw = formatProfileMessage(doc as never, { installId: "i" });
    const parsed = parseProfileMessage(raw);
    if (parsed === null || isMalformedProfile(parsed)) throw new Error(`expected ok, got ${JSON.stringify(parsed)}`);
    expect(parsed.status).toBe("ok");
    // The knowns survive; the unknowns are dropped rather than refused.
    expect(profileFingerprint(parsed.doc!)).toBe(profileFingerprint(richPayload()));
  });

  it("refuses the away SECTION when the scope is present with the wrong type", () => {
    /**
     * A KNOWN KEY WITH THE WRONG TYPE IS NOT AN ABSENT ONE. `piles` absent means the document says
     * nothing about scope and a reader keeps what it has; read that way, a document saying
     * `enabled: true` with a wider `audience` and a malformed scope would turn the responder on and
     * change who it answers while the one field that BOUNDS its reach came from nowhere. The
     * section is unreadable instead — the refusal an unparseable date already gets.
     *
     * The malformation is injected into the DOCUMENT, after `makeProfileDoc`: this is a hostile or
     * buggy writer's bytes, which is the only way the parser ever meets one. A fixture that goes
     * through `canonicalizeProfilePayload` is exercising the writer, not this branch.
     */
    const doc = makeProfileDoc(richPayload(), { updatedAt: AT, producer: PRODUCER }) as unknown as Record<string, unknown>;
    (doc.awayResponder as Record<string, unknown>).piles = "ohmail/Reads";

    const parsed = parseProfileMessage(formatProfileMessage(doc as never, { installId: "i" }));
    if (parsed === null || isMalformedProfile(parsed)) throw new Error("expected ok");
    expect(parsed.status).toBe("ok");
    // The document still parses — one bad section is not a bad document — and the section is gone.
    expect(parsed.doc!.awayResponder).toBeNull();
  });

  it("collapses a repeated scope member, because the value is a set", () => {
    /* The endpoint's `validPiles` collapses duplicates and the notice renders one line per member,
       so a document repeating one name is stored and rendered in full without this. Injected into
       the document for the reason above: the writer already dedupes. */
    const doc = makeProfileDoc(richPayload(), { updatedAt: AT, producer: PRODUCER }) as unknown as Record<string, unknown>;
    (doc.awayResponder as Record<string, unknown>).piles =
      [...Array(5_000)].map(() => "INBOX").concat(["ohmail/Reads", "INBOX"]);

    const parsed = parseProfileMessage(formatProfileMessage(doc as never, { installId: "i" }));
    if (parsed === null || isMalformedProfile(parsed)) throw new Error("expected ok");
    expect(parsed.doc!.awayResponder!.piles).toEqual(["INBOX", "ohmail/Reads"]);
  });

  it("a document whose `v` is beyond this build parses as `newer`, never as content", () => {
    const doc = makeProfileDoc(richPayload(), { updatedAt: AT, producer: PRODUCER }) as Record<string, unknown>;
    doc.v = PROFILE_VERSION + 1;
    const parsed = parseProfileMessage(formatProfileMessage(doc as never, { installId: "i" }));
    if (parsed === null || isMalformedProfile(parsed)) throw new Error("expected a parsed record");
    expect(parsed.status).toBe("newer");
    expect(parsed.v).toBe(PROFILE_VERSION + 1);
    expect(parsed.doc).toBeUndefined();
  });

  it("the preamble carries no `{`, so the JSON extractor cannot mistake prose for the document", () => {
    const raw = formatProfileMessage(makeProfileDoc(richPayload(), { updatedAt: AT, producer: PRODUCER }), { installId: "i" });
    const body = raw.slice(raw.search(/\r\n\r\n/) + 4);
    const beforeJson = body.slice(0, body.indexOf("{"));
    // The prose half explains itself to the stranger who finds it…
    expect(beforeJson).toMatch(/Deleting this message is safe/);
    expect(beforeJson).toMatch(/only resets ohmail's settings/);
    // …and contains no brace, which is the property the extractor stands on.
    expect(beforeJson.includes("{")).toBe(false);
  });

  it("header injection through an install id is stripped, exactly as the lease strips it", () => {
    const raw = formatProfileMessage(
      makeProfileDoc(richPayload(), { updatedAt: AT, producer: PRODUCER }),
      { installId: "evil\r\nX-Injected: 1" },
    );
    expect(raw).not.toMatch(/^X-Injected:/m);
  });

  it("a duplicate discriminator header is malformed, never invisible and never a document", () => {
    const doc = makeProfileDoc(richPayload(), { updatedAt: AT, producer: PRODUCER });
    const raw = formatProfileMessage(doc, { installId: "i" })
      .replace("X-Ohmail-Profile: 1", "X-Ohmail-Profile: 1\r\nX-Ohmail-Profile: 0");
    const parsed = parseProfileMessage(raw);
    expect(parsed).not.toBeNull();
    expect(isMalformedProfile(parsed!)).toBe(true);
  });

  it("garbage where the JSON should be is malformed with a reason", () => {
    const good = formatProfileMessage(makeProfileDoc(richPayload(), { updatedAt: AT, producer: PRODUCER }), { installId: "i" });
    const braceless = good.slice(0, good.indexOf("{")); // headers + preamble, no document
    const p1 = parseProfileMessage(braceless);
    expect(p1 !== null && isMalformedProfile(p1)).toBe(true);
    const notJson = `${braceless}{this is not json}`;
    const p2 = parseProfileMessage(notJson);
    expect(p2 !== null && isMalformedProfile(p2)).toBe(true);
  });

  it("an empty payload is recognisably empty — the absence ⇒ defaults contract's other half", () => {
    expect(isEmptyProfilePayload({ screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null })).toBe(true);
    expect(isEmptyProfilePayload(richPayload())).toBe(false);
  });
});

describe("mail 0094 — a found document reports the generation its uid was read under", () => {
  /**
   * WHAT THIS IS FOR. A mirror writer stores where it read the document — a uid — and a remembered
   * uid is a fact only under the UIDVALIDITY it was read under: a renumbered folder re-issues the
   * same small integers to different messages, so a uid kept without its generation becomes a
   * confident pointer at the wrong one.
   *
   * Before this the `found` arm carried `ref` and no generation, and the only way to get one was
   * to ask the connection separately at the call site. That is the MANUFACTURED PAIR: the reader's
   * adapter selects other folders between calls, so a generation read afterwards may describe a
   * different folder and one read before may be stale by the time the uid is issued. The value
   * has to come from the same read.
   */
  it("reports the read's OWN generation, and keeps reporting it after the folder moves", async () => {
    const io = new MemMeta();
    io.renumber(4_242);
    const doc = makeProfileDoc(richPayload(), { updatedAt: AT, producer: PRODUCER });
    await writeOrganizerProfile({ io, doc, installId: "i" });

    const read = await readOrganizerProfile(io);
    expect(read.state).toBe("found");
    if (read.state !== "found") throw new Error("unreachable");
    expect(read.generation, "the found arm did not carry the generation it read under").toBe(4_242);
    const capturedRef = read.ref;

    /* THE HALF THAT MATTERS: the server renumbers. A result that reported a LIVE view of the
       connection would now say 9_999, and a mirror writer storing that beside the old uid would
       have manufactured exactly the pair this field exists to prevent. The result is a fact about
       the read that produced it. */
    io.renumber(9_999);
    expect(read.generation, "the result tracks the CURRENT generation rather than the read's").toBe(4_242);
    expect(read.ref).toBe(capturedRef);

    // …and a FRESH read reports the new epoch, so the value is not merely frozen.
    const after = await readOrganizerProfile(io);
    if (after.state !== "found") throw new Error("expected a readable document");
    expect(after.generation, "a fresh read did not pick up the new generation").toBe(9_999);
  });

  it("a set of messages disagreeing about the generation is UNREADABLE, not resolved by picking one", async () => {
    /* Every message in one call comes from one SELECT of one folder, so more than one generation
       is not a folder state — it is evidence that whatever produced them is manufacturing the
       pair. Picking one would hand back a locator that looks usable and is not. */
    const io = new MemMeta();
    const a = makeProfileDoc(richPayload(), { updatedAt: AT, producer: PRODUCER });
    await writeOrganizerProfile({ io, doc: a, installId: "i" });
    const second = richPayload();
    second.tagNames = ["other"];
    const b = makeProfileDoc(second, { updatedAt: new Date(AT.getTime() + 60_000), producer: PRODUCER });
    io.messages.push({ ref: 99, raw: formatProfileMessage(b, { installId: "j" }), generation: 7 });

    const mixed: ProfileIo = {
      ensureMetaFolder: io.ensureMetaFolder.bind(io),
      // Hands back the messages with their OWN differing generations — the dishonest io.
      listProfileMessages: async () => io.messages.map((m) => ({ ...m })),
      appendProfile: io.appendProfile.bind(io),
      removeProfiles: io.removeProfiles.bind(io),
    };
    const read = await readOrganizerProfile(mixed);
    expect(read.state, "a set disagreeing about the generation produced a usable result").toBe("unreadable");
  });

  it("an io that supplies NO generation degrades to unusable, never to a wrong one", async () => {
    /* `null` is the vocabulary for "the server did not say", and it reads as an unusable locator.
       An io omitting the field must land there rather than on some number — the fail-safe
       direction, and the reason the field is required in the type. */
    const io = new MemMeta();
    const doc = makeProfileDoc(richPayload(), { updatedAt: AT, producer: PRODUCER });
    await writeOrganizerProfile({ io, doc, installId: "i" });
    const silent: ProfileIo = {
      ensureMetaFolder: io.ensureMetaFolder.bind(io),
      listProfileMessages: async () => io.messages.map((m) => ({ ref: m.ref, raw: m.raw } as RawProfileMessage)),
      appendProfile: io.appendProfile.bind(io),
      removeProfiles: io.removeProfiles.bind(io),
    };
    const read = await readOrganizerProfile(silent);
    if (read.state !== "found") throw new Error("expected a readable document");
    expect(read.generation, "a missing generation became something other than null").toBeNull();
  });
});

describe("the profile and the lease share ohmail/_meta without seeing each other", () => {
  const claimRaw = (): string => formatClaim({
    authorizedAt: null, capabilities: [],
    installId: "cloud-1", kind: "cloud", displayName: "ohmail Cloud",
    heartbeat: AT, claimedAt: AT, nonce: "n1",
  });

  it("a lease claim is invisible to the profile parser, and a profile to the lease parser", () => {
    expect(parseProfileMessage(claimRaw())).toBeNull();
    const profileRaw = formatProfileMessage(makeProfileDoc(richPayload(), { updatedAt: AT, producer: PRODUCER }), { installId: "i" });
    expect(parseClaim(profileRaw)).toBeNull();
  });

  it("writing the profile never touches a claim in the same folder", async () => {
    const io = new MemMeta();
    await io.appendProfile(claimRaw()); // a claim, seeded through the same in-memory folder
    io.appends = 0;

    const doc = makeProfileDoc(richPayload(), { updatedAt: AT, producer: PRODUCER });
    const r1 = await writeOrganizerProfile({ io, doc, installId: "i" });
    expect(r1).toEqual({ written: true, removed: 0 }); // the claim was never in the removal set

    const claims = io.messages.filter((m) => parseClaim(m.raw) !== null);
    expect(claims, "the organizer claim must survive every profile write").toHaveLength(1);
    const profiles = io.messages.filter((m) => parseProfileMessage(m.raw) !== null);
    expect(profiles).toHaveLength(1);
  });
});

describe("append new + expunge old — exactly one current document", () => {
  it("a second write replaces the first: one message, the newer content", async () => {
    const io = new MemMeta();
    const first = makeProfileDoc(richPayload(), { updatedAt: AT, producer: PRODUCER });
    expect(await writeOrganizerProfile({ io, doc: first, installId: "i" })).toEqual({ written: true, removed: 0 });

    const changed = richPayload();
    changed.tagNames.push("newly-minted");
    const second = makeProfileDoc(changed, { updatedAt: new Date(AT.getTime() + 60_000), producer: PRODUCER });
    expect(await writeOrganizerProfile({ io, doc: second, installId: "i" })).toEqual({ written: true, removed: 1 });

    const profiles = io.messages.filter((m) => parseProfileMessage(m.raw) !== null);
    expect(profiles).toHaveLength(1);
    const read = await readOrganizerProfile(io);
    if (read.state !== "found") throw new Error(`expected found, got ${read.state}`);
    expect(read.doc.tagNames).toContain("newly-minted");
  });

  it("an UNSEEN foreign document refuses the write and touches nothing — surfaced before superseded", async () => {
    const io = new MemMeta();
    const foreignPayload = richPayload();
    foreignPayload.tagNames = ["someone-elses"];
    const foreignDoc = makeProfileDoc(foreignPayload, { updatedAt: AT, producer: { kind: "local", version: "0.9.3" } });
    await io.appendProfile(formatProfileMessage(foreignDoc, { installId: "other-install" }));

    const mine = makeProfileDoc(richPayload(), { updatedAt: new Date(AT.getTime() + 60_000), producer: PRODUCER });
    // No `replaceable` list: this writer has never seen the foreign document, so the write must
    // refuse and hand it back rather than expunge configuration it never recorded.
    const refused = await writeOrganizerProfile({ io, doc: mine, installId: "i" });
    if (refused.written) throw new Error("expected a refusal");
    expect(refused.reason).toBe("foreign");
    if (refused.reason !== "foreign") throw new Error("unreachable");
    expect(refused.installId).toBe("other-install");
    expect(profileFingerprint(refused.doc)).toBe(profileFingerprint(foreignPayload));
    expect(io.messages, "a refused write appends nothing and expunges nothing").toHaveLength(1);

    // Once SEEN — its fingerprint on the replaceable list — the same write supersedes it.
    const superseded = await writeOrganizerProfile({
      io, doc: mine, installId: "i", replaceable: [profileFingerprint(foreignPayload)],
    });
    expect(superseded).toEqual({ written: true, removed: 1 });
    const docs = io.messages.map((m) => parseProfileMessage(m.raw)).filter((r) => r !== null);
    expect(docs).toHaveLength(1);
    expect((docs[0] as { installId: string }).installId).toBe("i");
  });

  it("a foreign document that says exactly what we are writing is replaceable without ceremony", async () => {
    const io = new MemMeta();
    const doc = makeProfileDoc(richPayload(), { updatedAt: AT, producer: { kind: "local", version: "0.9.3" } });
    await io.appendProfile(formatProfileMessage(doc, { installId: "other-install" }));
    const mine = makeProfileDoc(richPayload(), { updatedAt: new Date(AT.getTime() + 60_000), producer: PRODUCER });
    expect(await writeOrganizerProfile({ io, doc: mine, installId: "i" })).toEqual({ written: true, removed: 1 });
  });

  it("crash residue — two documents — reads as the newest, and the next write leaves one", async () => {
    const io = new MemMeta();
    const older = makeProfileDoc(richPayload(), { updatedAt: AT, producer: PRODUCER });
    const newerPayload = richPayload();
    newerPayload.tagNames = ["after-the-crash"];
    const newer = makeProfileDoc(newerPayload, { updatedAt: new Date(AT.getTime() + 60_000), producer: PRODUCER });
    // Both appended, nothing expunged — the state a crash between the two steps leaves behind.
    await io.appendProfile(formatProfileMessage(older, { installId: "i" }));
    await io.appendProfile(formatProfileMessage(newer, { installId: "i" }));

    const read = await readOrganizerProfile(io);
    if (read.state !== "found") throw new Error(`expected found, got ${read.state}`);
    expect(read.doc.tagNames).toEqual(["after-the-crash"]);
    // The leftover is REPORTED, not merely coalesced over — the composition's verify pass reads
    // this number to decide a healing rewrite is owed.
    expect(read.residue).toBe(1);

    /* The residue holds the next write (the gate): one tidy pass removes the older copy instead
       of appending a third, and the write after it replaces the survivor. Never more than two. */
    const third = makeProfileDoc(newerPayload, { updatedAt: new Date(AT.getTime() + 120_000), producer: PRODUCER });
    expect(await writeOrganizerProfile({ io, doc: third, installId: "i" }))
      .toEqual({ written: false, reason: "cleanup_owed", removed: 1 });
    expect(io.messages.filter((m) => parseProfileMessage(m.raw) !== null)).toHaveLength(1);
    expect(await writeOrganizerProfile({ io, doc: third, installId: "i" })).toEqual({ written: true, removed: 1 });
    expect(io.messages.filter((m) => parseProfileMessage(m.raw) !== null)).toHaveLength(1);
  });

  it("an empty folder reads as `none` — absence is defaults, never an error", async () => {
    expect(await readOrganizerProfile(new MemMeta())).toEqual({ state: "none" });
  });

  it("a NEWER document dominates the read and REFUSES the write, in both orders", async () => {
    const io = new MemMeta();
    const v2 = makeProfileDoc(richPayload(), { updatedAt: AT, producer: PRODUCER }) as Record<string, unknown>;
    v2.v = PROFILE_VERSION + 1;
    await io.appendProfile(formatProfileMessage(v2 as never, { installId: "other" }));
    // Beside it, an older readable copy — the downgrade trap: the read must NOT answer with the
    // readable one while a newer producer's document sits in the folder.
    await io.appendProfile(formatProfileMessage(
      makeProfileDoc(richPayload(), { updatedAt: new Date(AT.getTime() + 60_000), producer: PRODUCER }),
      { installId: "i" },
    ));

    expect(await readOrganizerProfile(io)).toEqual({ state: "newer", v: PROFILE_VERSION + 1 });

    const attempt = await writeOrganizerProfile({
      io, doc: makeProfileDoc(richPayload(), { updatedAt: AT, producer: PRODUCER }), installId: "i",
    });
    expect(attempt).toEqual({ written: false, reason: "newer", v: PROFILE_VERSION + 1 });
    // Nothing was appended and nothing expunged: the newer producer's document is untouched.
    expect(io.messages).toHaveLength(2);
  });

  it("a folder holding only a corrupt profile reads as `unreadable`; a write lands beside it, and only an ohmail-shaped copy is tidied", async () => {
    /* With no readable current document nothing is removed (the tidy's third condition), so the
       write appends and removes nothing. A copy in ohmail's own shape goes on the next write's
       gate; a record that is not (no install id, another subject) is never touched. */
    const io = new MemMeta();
    await io.appendProfile("X-Ohmail-Profile: 1\r\nSubject: broken\r\n\r\nno document here");
    await io.appendProfile(`X-Ohmail-Profile: 1\r\nX-Ohmail-Install-Id: i\r\nSubject: ohmail settings for this mailbox\r\nDate: ${new Date(AT.getTime() - 60_000).toUTCString()}\r\n\r\n{ torn`);
    const read = await readOrganizerProfile(io);
    expect(read.state).toBe("unreadable");
    const write = await writeOrganizerProfile({
      io, doc: makeProfileDoc(richPayload(), { updatedAt: AT, producer: PRODUCER }), installId: "i",
    });
    expect(write).toEqual({ written: true, removed: 0 });
    const next = await writeOrganizerProfile({
      io, doc: makeProfileDoc(richPayload(), { updatedAt: new Date(AT.getTime() + 60_000), producer: PRODUCER }), installId: "i",
    });
    expect(next).toEqual({ written: false, reason: "cleanup_owed", removed: 1 });
    expect(io.messages.map((m) => /Subject: (.*)/.exec(m.raw)?.[1]).sort())
      .toEqual(["broken", "ohmail settings for this mailbox"]);
  });

  it("a cleanup failure after a successful append reports written, and the next write recovers", async () => {
    const io = new MemMeta();
    await writeOrganizerProfile({ io, doc: makeProfileDoc(richPayload(), { updatedAt: AT, producer: PRODUCER }), installId: "i" });
    const failing: ProfileIo = {
      ensureMetaFolder: io.ensureMetaFolder.bind(io),
      listProfileMessages: io.listProfileMessages.bind(io),
      appendProfile: io.appendProfile.bind(io),
      removeProfiles: async () => { throw new Error("EXPUNGE refused"); },
    };
    const events: string[] = [];
    const changed = richPayload();
    changed.tagNames = ["second"];
    const r = await writeOrganizerProfile({
      io: failing, doc: makeProfileDoc(changed, { updatedAt: new Date(AT.getTime() + 60_000), producer: PRODUCER }),
      installId: "i", log: (event) => { events.push(event); },
    });
    // Written IS the truth — the new document is in the folder; only the cleanup failed, and it is owed.
    expect(r).toEqual({ written: true, removed: 0, owed: true });
    expect(events).toContain("profile_cleanup_failed");
    expect(io.messages).toHaveLength(2);
    // The next write is held for the cleanup: one tidy pass, no third copy.
    const later = { updatedAt: new Date(AT.getTime() + 120_000), producer: PRODUCER };
    const r2 = await writeOrganizerProfile({ io, doc: makeProfileDoc(changed, later), installId: "i" });
    expect(r2).toEqual({ written: false, reason: "cleanup_owed", removed: 1 });
    expect(io.messages).toHaveLength(1);
    const r3 = await writeOrganizerProfile({ io, doc: makeProfileDoc(changed, later), installId: "i" });
    expect(r3).toEqual({ written: true, removed: 1 });
    expect(io.messages).toHaveLength(1);
  });
});

/**
 * (FIX-026): THE DATE-SECOND GROUP PICKS THE SAME WINNER AS EVERY BODY WOULD. The listing reads
 * bodies only for the undated messages and the newest Date second holding a readable document;
 * `Date` is `updatedAt` cut to the second, so no older second can hold a newer document. Random
 * folders, duplicates and unparseable Dates; the reference is the same read over every body.
 */
describe("the current document chosen from one Date second is the one every body would choose", () => {
  const META_T9 = "INBOX.ohmail._meta";
  const toPath = (c: string): string => c.replace(/\//g, ".");
  let seed = 0x2026_0928;
  const rand = (): number => { seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31; return seed / 2 ** 31; };

  it("many random folders: same document, same ref, and bodies read only for its group", async () => {
    for (let trial = 0; trial < 200; trial++) {
      resetMetaMemos();
      const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META_T9] });
      const n = 1 + Math.floor(rand() * 12);
      for (let i = 0; i < n; i++) {
        const at = new Date(AT.getTime() + Math.floor(rand() * 5) * 1000 + Math.floor(rand() * 1000));
        const p = richPayload();
        p.tagNames = [`t${Math.floor(rand() * 3)}`];
        let raw = formatProfileMessage(makeProfileDoc(p, { updatedAt: at, producer: PRODUCER }), { installId: `i${Math.floor(rand() * 3)}` });
        if (rand() < 0.15) raw = raw.replace(/^Date: .*$/m, "Date: not a date");
        server.seed(META_T9, raw);
      }
      const whole = {
        ensureMetaFolder: async (): Promise<void> => {},
        listProfileMessages: async (): Promise<RawProfileMessage[]> => server.tree.get(META_T9)!.messages
          .map((m) => ({ ref: m.uid, raw: m.raw, generation: 1_000 })),
        appendProfile: async (): Promise<void> => {},
        removeProfiles: async (): Promise<void> => {},
      };
      const expected = await readOrganizerProfile(whole);
      server.log.length = 0;
      const got = await readOrganizerProfile(makeProfileIo(server, toPath, { installId: "t9", mailboxId: `t9-${trial}` }));

      expect(got.state).toBe(expected.state);
      if (got.state !== "found" || expected.state !== "found") continue;
      expect(got.ref, `trial ${trial}: another document won`).toBe(expected.ref);
      expect(got.doc).toEqual(expected.doc);
      const secondOf = (raw: string): number | null => {
        const m = /^Date: (.*)$/m.exec(raw);
        const t = m ? Date.parse(m[1]!) : NaN;
        return Number.isFinite(t) ? Math.floor(t / 1000) : null;
      };
      // Every document here is readable, so the newest dated second is the one that decides.
      const held = server.tree.get(META_T9)!.messages;
      const seconds = held.map((m) => secondOf(m.raw)).filter((x): x is number => x !== null);
      const newest = seconds.length > 0 ? Math.max(...seconds) : null;
      const group = held.filter((m) => secondOf(m.raw) === null || secondOf(m.raw) === newest).map((m) => m.uid);
      const read = server.log.filter((l) => l.includes("<0.")).map((l) => Number(/ (\d+)<0\./.exec(l)![1]));
      expect(read.sort((a, b) => a - b), `trial ${trial}: bodies read beyond the winner's group`)
        .toEqual(group.sort((a, b) => a - b));
    }
  });
});

/**
 * (FIX-026 commit 2): THE BODY SPELLS PEOPLE'S WORDS AS JSON ESCAPES. Every string value outside
 * a closed list of format fields is `\uXXXX`, so a mail client's search index finds no name or
 * address in the message, and every shipped reader — `JSON.parse` of the body from its first `{`
 * to its last `}` — decodes it to the same values. Case (b), the 0.25.3 release's own parser reading
 * this body, archives that release out of git history, which a shallow checkout does not hold, so it
 * left this file.
 */
describe("names and addresses are written as JSON escapes, and every shipped reader reads them", () => {
  const FIXTURE: OrganizerProfilePayload = {
    screener: [{ address: "qorvath@zemblique.test", name: "Wilhelmina Quaxtor" }],
    rules: [{
      kind: "sender", match: "vendrik@holmquast.test", destination: "ohmail/Receipts", priority: 5,
      enabled: true, provenance: "manual", subjectContains: "Invoizzard",
    }],
    notifyRules: [{ kind: "sender", target: "brisvane@ulmquisto.test" }],
    awayResponder: {
      enabled: true, body: "Sabbatical in Krzywopol, back when the kiln cools", startsAt: "2026-10-01T00:00:00.000Z",
      endsAt: null, audience: "screened_in", throttle: "per_day", piles: ["ohbox"],
    },
    tagNames: ["Zelkovaquartz", "Grüße-Überall"],
    signature: "Tobiah Fennimore\nKrakle Strasse 9",
    signatureHtml: "<p>Tobiah Fennimore</p>",
  };
  const doc = makeProfileDoc(FIXTURE, { updatedAt: AT, producer: PRODUCER });
  const raw = formatProfileMessage(doc, { installId: "t18-install" });
  const body = raw.slice(raw.search(/\r\n\r\n/) + 4);
  const json = body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1);

  it("(a) the body parses to the document itself, and its fingerprint is the document's", () => {
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(doc)));
    const parsed = parseProfileMessage(raw);
    expect(parsed !== null && !isMalformedProfile(parsed) && parsed.status).toBe("ok");
    if (parsed === null || isMalformedProfile(parsed)) return;
    expect(profileFingerprint(parsed.doc!)).toBe(profileFingerprint(FIXTURE));
    expect(parsed.v).toBe(PROFILE_VERSION);
  });

  it("(c) no word of a person's value appears in the raw message", () => {
    /* Every run of three or more letters or digits in an escaped value, lowercased, as a search
       index would take it; words the message carries for its own reasons (the preamble, the Subject,
       `ohmail`) are measured on a message with an empty payload and set aside. */
    const empty = formatProfileMessage(makeProfileDoc({
      screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null,
    }, { updatedAt: AT, producer: PRODUCER }), { installId: "t18-install" }).toLowerCase();
    const escaped = [
      ...FIXTURE.screener.flatMap((s) => [s.address, s.name ?? ""]),
      ...FIXTURE.rules.flatMap((r) => [r.match, r.destination, r.subjectContains ?? ""]),
      ...FIXTURE.notifyRules.map((n) => n.target),
      FIXTURE.awayResponder!.body ?? "", ...FIXTURE.tagNames, FIXTURE.signature ?? "", FIXTURE.signatureHtml ?? "",
    ];
    const words = [...new Set(escaped.flatMap((v) => v.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []))]
      .filter((w) => !empty.includes(w));
    expect(words.length, "the fixture has no words to look for").toBeGreaterThan(15);
    const lower = raw.toLowerCase();
    expect(words.filter((w) => lower.includes(w)), "a person's word is searchable in the message").toEqual([]);
  });

  it("(e) a value the serializer cannot spell faithfully throws before anything is appended", () => {
    const odd = { ...doc, updatedAt: new Date("2026-09-28T12:00:00Z") } as unknown as typeof doc;
    expect(() => formatProfileMessage(odd, { installId: "t18-install" })).toThrow(/did not serialize to itself/);
  });

  it("(d) the body is pure ASCII, declared 7bit, and the preamble holds no brace", () => {
    expect([...raw].filter((c) => c.charCodeAt(0) > 0x7e || (c.charCodeAt(0) < 0x20 && c !== "\r" && c !== "\n")))
      .toEqual([]);
    expect(raw).toMatch(/^Content-Transfer-Encoding: 7bit$/m);
    expect(body.slice(0, body.indexOf("{"))).not.toMatch(/[{}]/);
  });
});

describe("a rule's age travels beside it, outside the canonical form and the fingerprint", () => {
  const OLD = "2026-09-01T08:00:00.000Z";
  const LATER = "2026-09-02T08:00:00.000Z";
  const aged = (): OrganizerProfilePayload => {
    const p = richPayload();
    p.rules = p.rules.map((r, i) => ({ ...r, updatedAt: i === 0 ? OLD : LATER }));
    return p;
  };
  const read = (raw: string) => {
    const parsed = parseProfileMessage(raw);
    if (parsed === null || isMalformedProfile(parsed) || parsed.status !== "ok") throw new Error("expected a readable document");
    return parsed;
  };

  it("ages survive the round trip, written plain, and the copy reads as written", () => {
    const raw = formatProfileMessage(makeProfileDoc(aged(), { updatedAt: AT, producer: PRODUCER }), { installId: "a" });
    expect(raw, "the age was escaped or dropped").toContain(`"updatedAt": "${OLD}"`);
    const parsed = read(raw);
    expect(parsed.encoded).toBe(true);
    expect(new Map(parsed.doc!.rules.map((r) => [r.match, r.updatedAt]))).toEqual(new Map([
      ["news@letters.example", OLD], ["shop.example", LATER], ["alerts@host.example", LATER],
    ]));
  });

  it("an unreadable age reads as absent, and the document stays readable", () => {
    const raw = formatProfileMessage(makeProfileDoc(aged(), { updatedAt: AT, producer: PRODUCER }), { installId: "a" })
      .replace(`"updatedAt": "${OLD}"`, "\"updatedAt\": \"last tuesday\"");
    const rule = read(raw).doc!.rules.find((r) => r.match === "news@letters.example")!;
    expect(rule).toBeDefined();
    expect(rule.updatedAt).toBeUndefined();
  });

  it("the fingerprint is the same with and without ages at v1 and v2, so an upgrade asks nothing", () => {
    for (const v of [1, 2]) {
      const before = profileFingerprint(richPayload(), v);
      expect(profileFingerprint(aged(), v), `v${v}: an age moved the fingerprint`).toBe(before);
      expect(profileFingerprint(makeProfileDoc(aged(), { updatedAt: AT, producer: PRODUCER }, v), v)).toBe(before);
      expect(localSaysWhatAFingerprintSays(aged(), before), `v${v}: an older document became a question`).toBe(true);
    }
  });

  it("two entries that cannot be told apart carry the earliest age, and an unwritten one carries none", () => {
    const p = richPayload();
    const twin = p.rules[0]!;
    p.rules = [{ ...twin, updatedAt: LATER }, { ...twin, updatedAt: OLD }, { ...p.rules[1]!, updatedAt: "yesterday" }];
    const doc = makeProfileDoc(p, { updatedAt: AT, producer: PRODUCER });
    expect(doc.rules.filter((r) => r.match === twin.match).map((r) => r.updatedAt)).toEqual([OLD, OLD]);
    expect(doc.rules.find((r) => r.match === "shop.example")!.updatedAt).toBeUndefined();
  });
});
