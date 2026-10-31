import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PROFILE_VERSION,
  canonicalizeProfilePayload,
  formatProfileMessage,
  isMalformedProfile,
  makeProfileDoc,
  parseProfileMessage,
  profileFingerprint,
  readOrganizerProfile,
  signatureReceipt,
  type OrganizerProfilePayload,
} from "../../src/adapters/organizer-profile.js";
import { publicPath } from "../../../../test/support/public-root.mjs";

/**
 * THE PUBLIC FORMAT DOC'S WORKED EXAMPLE IS THE WRITER'S OWN OUTPUT — never a hand-typed
 * imitation of it.
 *
 * `public/ohmail/docs/organizer-profile.md` (published to the mirror as
 * `docs/organizer-profile.md`, the path the landing's two "read the format" links pin)
 * quotes one complete profile message. A reader is expected to parse that example with
 * their own code, so an example that drifts from what ohmail actually writes — a renamed
 * field, a reordered envelope, a reworded preamble — would be a published lie that no
 * compiler sees. This suite rebuilds the example from the same payload with the REAL
 * writer and diffs the bytes, so the doc can only ever show what the code does.
 *
 * If this fails after an intentional format change: regenerate the fence by running the
 * expression below and paste the output — never edit the fence by hand.
 */

const DOC = publicPath("docs/organizer-profile.md");

/** The payload behind the doc's example. Invented people, `.example` domains throughout. */
const EXAMPLE_PAYLOAD: OrganizerProfilePayload = {
  screener: [
    { address: "orders@ninefold-press.example" },
    { address: "ines.aebersold@example.org", name: "Ines Aebersold" },
  ],
  rules: [
    { kind: "sender", match: "newsletter@ninefold-press.example", destination: "ohmail/Reads", priority: 0, enabled: true, provenance: "promoted" },
    { kind: "domain", match: "billing.example", destination: "ohmail/Receipts", priority: 0, enabled: true, provenance: "manual", subjectContains: "invoice" },
    { kind: "sender", match: "deals@loudmail.example", destination: "ohmail/Quarantine", priority: 0, enabled: true, provenance: "promoted" },
    { kind: "sender", match: "noreply@roundabout.example", destination: "ohmail/Screened", priority: 0, enabled: false, provenance: "manual" },
  ],
  notifyRules: [{ kind: "sender", target: "ines.aebersold@example.org" }],
  awayResponder: {
    enabled: false,
    // No `subject` since mail 0087: the responder is reply-only and answers in the
    // correspondent's own thread under `Re: ` plus their subject. `throttle` travels instead.
    body: "Thanks for writing — I read mail again on 2 September.",
    startsAt: "2026-08-24T00:00:00.000Z",
    endsAt: "2026-09-02T00:00:00.000Z",
    audience: "screened_in",
    throttle: "per_day",
    // The scope travels too (mail 0096). Explicit, because this payload IS the published example
    // and a document this release writes states it.
    piles: ["INBOX", "ohmail/Reads"],
  },
  tagNames: ["pottery-fair", "kiln"],
  // Mail 0094 — the one PER-MAILBOX field. A real value rather than null, so the published
  // example shows what the field looks like when it is set; a null would document the shape and
  // none of the content.
  signature: "-- \nJuno Marchetti\nkiln + wheel, Basel",
};
const EXAMPLE_META = {
  updatedAt: new Date("2026-08-27T09:30:00.000Z"),
  producer: { kind: "local", version: "0.11.1" },
};
const EXAMPLE_INSTALL_ID = "0f4c7d1e-2b6a-4a51-9c3e-7d8f1a2b3c4d";

const doc = () => readFileSync(DOC, "utf8");

/** The example fence: the first code fence after the "## A complete example" heading. */
function exampleFence(): string {
  const m = /## A complete example[\s\S]*?```text\n([\s\S]*?)```/.exec(doc());
  expect(m, "the doc lost its '## A complete example' fence").not.toBeNull();
  return m![1]!;
}

describe("the format doc's example is the writer's output", () => {
  it("byte-for-byte (modulo the CRLF the doc cannot carry)", () => {
    const message = formatProfileMessage(makeProfileDoc(EXAMPLE_PAYLOAD, EXAMPLE_META), {
      installId: EXAMPLE_INSTALL_ID,
    });
    expect(exampleFence().trimEnd()).toBe(message.replace(/\r\n/g, "\n").trimEnd());
  });

  it("parses back with the real parser, to the canonical payload", () => {
    const record = parseProfileMessage(exampleFence());
    expect(record).not.toBeNull();
    expect(isMalformedProfile(record!)).toBe(false);
    if (record === null || isMalformedProfile(record)) return;
    expect(record.status).toBe("ok");
    // The version the writer stamps, read off the writer — the example is regenerated from it,
    // so a literal here would be a second place to remember a format change in.
    expect(record.v).toBe(PROFILE_VERSION);
    expect(record.installId).toBe(EXAMPLE_INSTALL_ID);
    const canonical = canonicalizeProfilePayload(EXAMPLE_PAYLOAD);
    expect(record.doc!.screener).toEqual(canonical.screener);
    expect(record.doc!.rules).toEqual(canonical.rules);
    expect(record.doc!.notifyRules).toEqual(canonical.notifyRules);
    expect(record.doc!.awayResponder).toEqual(canonical.awayResponder);
    expect(record.doc!.tagNames).toEqual(canonical.tagNames);
  });

  it("the example exercises every section, including a screen-out and a spam rule", () => {
    // The doc's prose says a screen-out is a rule to ohmail/Screened and spam is a rule to
    // ohmail/Quarantine; the example has to SHOW both or the prose teaches an empty shape.
    const dests = EXAMPLE_PAYLOAD.rules.map((r) => r.destination);
    expect(dests).toContain("ohmail/Screened");
    expect(dests).toContain("ohmail/Quarantine");
    expect(EXAMPLE_PAYLOAD.screener.length).toBeGreaterThan(0);
    expect(EXAMPLE_PAYLOAD.notifyRules.length).toBeGreaterThan(0);
    expect(EXAMPLE_PAYLOAD.awayResponder).not.toBeNull();
    expect(EXAMPLE_PAYLOAD.tagNames.length).toBeGreaterThan(0);
  });
});

describe("the field-by-field table covers the format", () => {
  /** Field names parsed off an interface declaration in the module's own source. */
  function fieldsOf(name: string): string[] {
    const src = readFileSync(
      fileURLToPath(new URL("../../src/adapters/organizer-profile.ts", import.meta.url)),
      "utf8",
    );
    const block = new RegExp(`export interface ${name}[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(src);
    expect(block, `${name} moved — update this guard`).not.toBeNull();
    return [...block![1]!.matchAll(/^\s{2}(\w+)[?:]/gm)].map((m) => m[1]!);
  }

  it("names every field the payload and its entries carry", () => {
    const text = doc();
    const table = /## Field by field([\s\S]*?)\n## /.exec(text);
    expect(table, "the doc lost its '## Field by field' section").not.toBeNull();
    const fields = [
      ...fieldsOf("OrganizerProfilePayload"),
      ...fieldsOf("ProfileScreenerEntry"),
      ...fieldsOf("ProfileRuleEntry"),
      ...fieldsOf("ProfileNotifyRuleEntry"),
      ...fieldsOf("ProfileAwayResponder"),
      "v", "updatedAt", "producer",
    ];
    expect(fields.length).toBeGreaterThan(15); // anti-vacuity: the parse found real fields
    for (const f of new Set(fields)) {
      expect(table![1], `the field table does not document \`${f}\``).toContain(`\`${f}\``);
    }
  });

  it("documents every provenance value the real writer can emit, and the field's openness", () => {
    // The writer copies `Rule.provenance` verbatim, so the union in packages/core/src/rules.ts
    // is exactly what today's profiles can carry. A value added there without a doc row would
    // make the published spec reject genuine profiles — this pin turns that into a red test.
    const rules = readFileSync(
      fileURLToPath(new URL("../../src/rules.ts", import.meta.url)),
      "utf8",
    );
    const union = /provenance:\s*((?:"[a-z-]+"\s*\|\s*)+"[a-z-]+")/.exec(rules);
    expect(union, "Rule.provenance moved — update this guard").not.toBeNull();
    const values = [...union![1]!.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!);
    expect(values.length).toBeGreaterThanOrEqual(4); // anti-vacuity
    const text = doc();
    for (const v of values) {
      expect(text, `the spec does not document provenance "${v}"`).toContain(`"${v}"`);
    }
    // …and the doc must say the field is open: the format type is `string`, so a reader
    // rejecting an unknown provenance would reject profiles a newer writer legitimately wrote.
    expect(text).toMatch(/provenance[\s\S]{0,600}The field is open/);
  });
});

/**
 * ═══ THE FINGERPRINT IS A FUNCTION OF THE CONFIGURATION, ON EVERY RUNTIME ═══════════════════
 *
 * `canonicalizeProfilePayload` exists so that equality is CONTENT equality, and
 * `profileFingerprint` hashes its output. That fingerprint is then compared ACROSS INSTALLS —
 * `writeOrganizerProfile` refuses a write when it finds a foreign document whose fingerprint the
 * caller has never seen. So a canonical order that differs between two machines is not a
 * cosmetic difference: two installs holding byte-identical configuration would each read the
 * other's document as a stranger's, on every takeover, for ever, with nothing in any log saying
 * why.
 *
 * Every comparator here used `localeCompare`, which is locale-dependent by definition. It was
 * dormant only because every host today is a full-icu Node — one small-icu build, one
 * `--without-intl`, or one differing ICU version away from live. `rules.ts` already states the
 * rule for exactly this reason on its own tie-break.
 *
 * ── HOW A SECOND RUNTIME'S COLLATION IS MODELLED ──────────────────────────────────────────
 *
 * By replacing `String.prototype.localeCompare` for the duration of one call. That is not a
 * trick: it is the ONLY property of another runtime that matters here, and it is what a
 * different ICU build would change. A canonicalizer that consults it produces a different order
 * and therefore a different hash; one that compares code units cannot notice at all. The patch
 * is restored in a `finally`, and the second case proves the patch really does bite so this one
 * cannot be vacuously green.
 */
describe("a signature's receipt names text and markup as one value", () => {
  it("blank text is no signature, blank markup is no markup, and any other difference is a different receipt", () => {
    for (const none of [null, undefined, "", "  \n "]) expect(signatureReceipt(none, "<p>x</p>"), JSON.stringify(none)).toBeNull();
    const plain = signatureReceipt("-- \nMila");
    expect(plain).toMatch(/^[0-9a-f]{32}$/);
    expect(signatureReceipt("-- \nMila", null)).toBe(plain);
    expect(signatureReceipt("-- \nMila", "  ")).toBe(plain);
    expect(signatureReceipt("-- \nMila", "<p>-- <br>Mila</p>")).not.toBe(plain);
    expect(signatureReceipt("-- \nMila ")).not.toBe(plain);
  });
});

describe("the profile fingerprint does not depend on the runtime's collation", () => {
  /** Names chosen so ICU and code-unit order genuinely disagree: case, and a diacritic. */
  const PAYLOAD: OrganizerProfilePayload = {
    screener: [
      { address: "b@example.test" },
      { address: "A@example.test" },
      { address: "á@example.test" },
      { address: "a@example.test", name: "Someone" },
    ],
    rules: [
      { kind: "sender", match: "B@example.test", destination: "ohmail/Reads", priority: 1, enabled: true, provenance: "manual" },
      { kind: "sender", match: "a@example.test", destination: "ohmail/Reads", priority: 1, enabled: true, provenance: "manual" },
    ],
    notifyRules: [{ kind: "sender", target: "Z@example.test" }, { kind: "sender", target: "a@example.test" }],
    awayResponder: null,
    tagNames: ["Beta", "alpha", "Ångström"],
  } as OrganizerProfilePayload;

  /** Run `fn` on a runtime whose collation is the REVERSE of this one's. */
  function underForeignCollation<T>(fn: () => T): T {
    const real = String.prototype.localeCompare;
    // eslint-disable-next-line no-extend-native
    String.prototype.localeCompare = function reversed(this: string, that: string): number {
      return -real.call(this, that);
    } as typeof String.prototype.localeCompare;
    try {
      return fn();
    } finally {
      String.prototype.localeCompare = real;
    }
  }

  it("is IDENTICAL on a runtime that collates differently", () => {
    const here = profileFingerprint(PAYLOAD);
    const there = underForeignCollation(() => profileFingerprint(PAYLOAD));
    expect(
      there,
      "the same configuration fingerprints differently on two runtimes — each install would read "
      + "the other's document as a stranger's, on every takeover",
    ).toBe(here);

    // The ORDER itself, not only the hash: two canonicalizations must be the same document.
    expect(underForeignCollation(() => canonicalizeProfilePayload(PAYLOAD)))
      .toEqual(canonicalizeProfilePayload(PAYLOAD));
  });

  it("sorts by CODE UNIT, which is the property that makes the line above true", () => {
    const c = canonicalizeProfilePayload(PAYLOAD);
    // Uppercase before lowercase, and the diacritic last — code-unit order, not any locale's.
    expect(c.screener.map((s) => s.address)).toEqual([
      "A@example.test", "a@example.test", "b@example.test", "á@example.test",
    ]);
    expect(c.tagNames).toEqual(["Beta", "alpha", "Ångström"]);
    expect(c.rules.map((r) => r.match)).toEqual(["B@example.test", "a@example.test"]);
    expect(c.notifyRules.map((n) => n.target)).toEqual(["Z@example.test", "a@example.test"]);
  });

  it("THE PATCH REALLY BITES — otherwise the case above proves nothing", () => {
    // A sanity check on the instrument, not on the code under test. If replacing
    // `localeCompare` did not change what a locale-sensitive sort does, the first case would be
    // green over an implementation that still used it.
    const words = ["b", "A", "a"];
    const here = [...words].sort((x, y) => x.localeCompare(y));
    const there = underForeignCollation(() => [...words].sort((x, y) => x.localeCompare(y)));
    expect(there).not.toEqual(here);
    expect(there).toEqual([...here].reverse());
  });
});

/**
 * ═══ WHICH OF TWO INDISTINGUISHABLE DOCUMENTS WINS ═══════════════════════════════════════════
 *
 * `readOrganizerProfile` picks the newest record: by timestamp, then by the document's own bytes.
 * Two records carrying the SAME timestamp and IDENTICAL bytes compared equal, so the winner was
 * whichever the folder listed first — and the winner's `installId` is what decides whether a
 * reader treats the configuration as its own or as a stranger's. Two installs reading one folder
 * could disagree about whose document it was.
 *
 * That state is ordinary residue rather than corruption: two installs writing the same settings
 * produces it.
 *
 * The tie is broken by `ref` DESCENDING — the message UID. Profile writes are append-then-expunge,
 * so a higher UID is a later write: when the timestamps agree, the folder's own arrival order is
 * the only remaining fact about which document is newer, and it is a fact rather than a coin toss.
 *
 * BOTH INPUT ORDERS, because one order passes under a stable sort with no tie-break at all — the
 * shape this guard exists to catch.
 */
describe("the newest-document tie-break", () => {
  const doc = makeProfileDoc(
    {
      screener: [{ address: "someone@example.test" }],
      rules: [], notifyRules: [], awayResponder: null, tagNames: [],
      signature: null,
    } as OrganizerProfilePayload,
    { updatedAt: new Date("2026-09-05T10:00:00.000Z"), producer: { kind: "local", version: "0.0.0" } },
  );

  /** Two records, one document, two installs, two UIDs. */
  const records = (order: "ascending" | "descending") => {
    const low = { ref: 7, raw: formatProfileMessage(doc, { installId: "install-seven" }), generation: 1_000 };
    const high = { ref: 9, raw: formatProfileMessage(doc, { installId: "install-nine" }), generation: 1_000 };
    return order === "ascending" ? [low, high] : [high, low];
  };

  const readWith = async (order: "ascending" | "descending") => readOrganizerProfile({
    ensureMetaFolder: async () => {},
    listProfileMessages: async () => records(order),
    appendProfile: async () => {},
    removeProfiles: async () => {},
  });

  it("takes the HIGHER uid whichever order the folder lists them in", async () => {
    for (const order of ["ascending", "descending"] as const) {
      const result = await readWith(order);
      expect(result.state, `the ${order} listing did not resolve to a document`).toBe("found");
      expect(
        result.state === "found" ? result.installId : null,
        `listed ${order}, the reader picked the EARLIER write — so two installs reading one `
        + "folder can disagree about whose document it is",
      ).toBe("install-nine");
      expect(result.state === "found" ? result.ref : null).toBe(9);
    }
  });

  it("gives the SAME answer both ways, which is the property under test", async () => {
    const a = await readWith("ascending");
    const b = await readWith("descending");
    expect(a.state === "found" ? a.installId : null)
      .toBe(b.state === "found" ? b.installId : null);
  });
});

describe("a rule's priority is read inside the one bound", () => {
  it("a value past either end is read as that end, and a whole number stays as written", () => {
    const rules = [
      { kind: "sender", match: "a@example.test", destination: "INBOX", priority: 5000, enabled: true, provenance: "manual" },
      { kind: "sender", match: "b@example.test", destination: "INBOX", priority: -3, enabled: true, provenance: "manual" },
      { kind: "sender", match: "c@example.test", destination: "INBOX", priority: 7, enabled: true, provenance: "manual" },
    ];
    const raw = formatProfileMessage(makeProfileDoc({ ...EXAMPLE_PAYLOAD, rules }, EXAMPLE_META), { installId: EXAMPLE_INSTALL_ID });
    const record = parseProfileMessage(raw);
    if (record === null || isMalformedProfile(record)) throw new Error("the profile did not parse");
    const read = record.doc!.rules.map((r) => [r.match, r.priority]);
    expect(read).toEqual([["a@example.test", 1000], ["b@example.test", 0], ["c@example.test", 7]]);
  });
});
