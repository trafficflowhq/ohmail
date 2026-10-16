import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  PROFILE_VERSION,
  PROFILE_VERSION_MIN_READ,
  canonicalizeProfilePayload,
  compareProfileFingerprints,
  formatProfileMessage,
  isMalformedProfile,
  makeProfileDoc,
  parseProfileMessage,
  profileFingerprint,
  profileFingerprintVersion,
  writeOrganizerProfile,
  type OrganizerProfilePayload,
  type RawProfileMessage,
} from "../../src/adapters/organizer-profile.js";
import { publicPath } from "../../../../test/support/public-root.mjs";

/**
 * ═══ THE CANONICAL ORDER IS TOTAL, AND IT IS VERSIONED ══════════════════════════════════════
 *
 * The fingerprint is taken over the canonical form and compared ACROSS INSTALLS, so a canonical
 * order that leaves ties in ARRIVAL order makes the identity of a document a fact about the
 * database that produced it. Measured on the shipped form: six permutations of one three-entry
 * screener produced six different fingerprints, and two permutations of a two-entry rules array
 * produced two — two installs holding identical configuration each read the other's document as a
 * stranger's, which is the takeover refusal the collation fix closed reached by the other route.
 *
 * The order could not simply be made total, because that changes the canonical form and every
 * document already sitting in somebody's mailbox re-fingerprints under the new rule. So the form
 * is VERSIONED: v1 frozen exactly as shipped, v2 total, both read for ever, a fingerprint only
 * ever compared to one taken at the same version, and a v1 document re-canonicalised on its next
 * WRITE — never on read.
 */

/* ── fixtures: ties the natural keys cannot separate ─────────────────────────────────────── */

/** Three screener entries on ONE address: v1 sorts by `address` alone and stops. */
const TIED_SCREENER = [
  { address: "a@example.test", name: "Ada" },
  { address: "a@example.test", name: "Bo" },
  { address: "a@example.test" },
];

/** Two rules identical but for an EMPTY `subjectContains` — which v1 maps to `""`, same as absent. */
const TIED_RULES = [
  {
    kind: "sender", match: "m@example.test", destination: "ohmail/Reads",
    priority: 0, enabled: true, provenance: "manual", subjectContains: "",
  },
  {
    kind: "sender", match: "m@example.test", destination: "ohmail/Reads",
    priority: 0, enabled: true, provenance: "manual",
  },
];

const TIED: OrganizerProfilePayload = {
  screener: TIED_SCREENER,
  rules: TIED_RULES,
  notifyRules: [{ kind: "sender", target: "a@example.test" }, { kind: "sender", target: "a@example.test" }],
  awayResponder: null,
  tagNames: ["kiln", "kiln", "Beta"],
  signature: null,
};

/** Every permutation of `xs` — the SET, not one shuffle, so no ordering can be lucky. */
function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [[...xs]];
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i++) {
    const rest = [...xs.slice(0, i), ...xs.slice(i + 1)];
    for (const p of permutations(rest)) out.push([xs[i]!, ...p]);
  }
  return out;
}

/** The permutation set of the whole payload: every array permuted independently. */
function permutedPayloads(p: OrganizerProfilePayload): OrganizerProfilePayload[] {
  const out: OrganizerProfilePayload[] = [];
  for (const screener of permutations(p.screener)) {
    for (const rules of permutations(p.rules)) {
      for (const notifyRules of permutations(p.notifyRules)) {
        for (const tagNames of permutations(p.tagNames)) {
          out.push({ ...p, screener, rules, notifyRules, tagNames });
        }
      }
    }
  }
  return out;
}

describe("v2 is a TOTAL order — a document's identity is its content, not its arrival order", () => {
  const set = permutedPayloads(TIED);

  it("every permutation of one document fingerprints IDENTICALLY at v2", () => {
    expect(set.length, "anti-vacuity: the permutation set is real").toBeGreaterThan(20);
    const fingerprints = new Set(set.map((p) => profileFingerprint(p, 2)));
    expect(
      fingerprints.size,
      `${fingerprints.size} distinct fingerprints over ${set.length} permutations of ONE document — `
      + "two installs holding the same configuration would each read the other's as a stranger's",
    ).toBe(1);
  });

  it("…and canonicalizes to one document, not merely to one hash", () => {
    const forms = new Set(set.map((p) => JSON.stringify(canonicalizeProfilePayload(p, 2))));
    expect(forms.size).toBe(1);
  });

  it("THE FIXTURE REALLY IS TIED — v1 is order-dependent over this same set", () => {
    // A sanity check on the instrument. If the natural keys already separated these entries, the
    // two cases above would be green over an order that is not total at all.
    const v1 = new Set(set.map((p) => profileFingerprint(p, 1)));
    expect(v1.size, "the fixture has no ties for a total order to break").toBeGreaterThan(1);
  });

  it("ordering entries that only their optional fields separate is decided, not left to arrival", () => {
    // Deterministic, and stated: the natural key first, then the entry's own canonical JSON. (A
    // present optional key sorts BEFORE an absent one, because the `,` that precedes it is below
    // the `}` that ends the shorter object — a consequence of the stated rule, not a rule of its
    // own, and pinned here so the rule cannot quietly become a different one.)
    const c = canonicalizeProfilePayload(TIED, 2);
    expect(c.screener).toEqual([
      { address: "a@example.test", name: "Ada" },
      { address: "a@example.test", name: "Bo" },
      { address: "a@example.test" },
    ]);
    expect(c.rules.map((r) => r.subjectContains)).toEqual(["", undefined]);
    // …and the SAME answer from the reversed input, which is what "decided" means here.
    const reversed = canonicalizeProfilePayload(
      { ...TIED, screener: [...TIED.screener].reverse(), rules: [...TIED.rules].reverse() }, 2,
    );
    expect(reversed.screener).toEqual(c.screener);
    expect(reversed.rules).toEqual(c.rules);
  });

  it("v2 does not depend on the order the object literals in the source declare their keys", () => {
    // The canonical serialization sorts keys, so the fingerprint is a fact about the content.
    // Built here the other way round on purpose: same document, different insertion order.
    const reversedKeys = {
      signature: TIED.signature, tagNames: TIED.tagNames, awayResponder: TIED.awayResponder,
      notifyRules: TIED.notifyRules, rules: TIED.rules, screener: TIED.screener,
    } as OrganizerProfilePayload;
    expect(profileFingerprint(reversedKeys, 2)).toBe(profileFingerprint(TIED, 2));
  });
});

/* ── v1 is frozen ────────────────────────────────────────────────────────────────────────── */

/**
 * THE SHIPPED HASHES, read off the build that wrote them (0.17, before this change).
 *
 * Not a regression pin for tidiness: every profile message an earlier ohmail appended to somebody's
 * mailbox has its identity in these bytes, and every stored import resolution and detection marker
 * holds one. A change to v1's canonical form re-fingerprints those documents, so an install reads
 * a document it wrote itself last week as foreign and re-asks a question its owner already
 * answered. These two literals make that unrepresentable.
 */
const V1_FROZEN: OrganizerProfilePayload = {
  screener: [{ address: "b@example.test" }, { address: "a@example.test", name: "Ada" }],
  rules: [{
    kind: "sender", match: "m@example.test", destination: "ohmail/Reads",
    priority: 3, enabled: true, provenance: "manual", subjectContains: "inv",
  }],
  notifyRules: [{ kind: "sender", target: "a@example.test" }],
  awayResponder: {
    enabled: true, body: "away", startsAt: null, endsAt: null,
    audience: "screened_in", throttle: "per_day", piles: ["ohmail/Reads", "INBOX"],
  },
  tagNames: ["kiln", "Beta"],
  signature: "-- \nJuno",
};
const V1_FROZEN_FINGERPRINT = "e253828f77a3731b2d4a962ff7566119a9209c0bde39e26829d9001d6444ca09";
const V1_EMPTY: OrganizerProfilePayload = {
  screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null,
};
const V1_EMPTY_FINGERPRINT = "4915403fe7408ca2697a6db55223c48613a6569e103d167757277c3fbcdbb792";
/**
 * The shipped v1 fingerprint of the TIED payload above — the pin that actually watches v1's
 * ORDERING rule.
 *
 * Two pins over untied fixtures were not enough and the mutation said so: giving v1 the total
 * order left both of them green, because no fixture with distinct natural keys can tell the two
 * rules apart. This one is the tied document in the order it is declared in, which is what v1's
 * stable sort preserves — so any change to v1's comparators moves it.
 */
const V1_TIED_FINGERPRINT = "37f38744d0aa122c4719d0daa98250c3a442185b2882c33735a52fc6e923cb84";

describe("format v1 is frozen, and is read for ever", () => {
  it("fingerprints exactly what the shipped build fingerprinted", () => {
    expect(profileFingerprint(V1_FROZEN, 1)).toBe(V1_FROZEN_FINGERPRINT);
    expect(profileFingerprint(V1_EMPTY, 1)).toBe(V1_EMPTY_FINGERPRINT);
  });

  it("…including its ORDER, which is the half a fixture with distinct keys cannot see", () => {
    expect(profileFingerprint(TIED, 1)).toBe(V1_TIED_FINGERPRINT);
    // v1 keeps a tie in the order it arrived in. Stated as a property, not only as a hash, so a
    // reader of this file learns what the frozen rule IS.
    expect(canonicalizeProfilePayload(TIED, 1).screener.map((e) => e.name)).toEqual(["Ada", "Bo", undefined]);
    expect(canonicalizeProfilePayload({ ...TIED, screener: [...TIED.screener].reverse() }, 1)
      .screener.map((e) => e.name)).toEqual([undefined, "Bo", "Ada"]);
  });

  it("a v1 fingerprint stays a BARE hex — which is what every stored row already holds", () => {
    expect(profileFingerprint(V1_FROZEN, 1)).toMatch(/^[0-9a-f]{64}$/);
    expect(profileFingerprintVersion(profileFingerprint(V1_FROZEN, 1))).toBe(1);
    expect(PROFILE_VERSION_MIN_READ).toBe(1);
  });

  it("a v2 fingerprint is tagged, so it can never compare equal to a v1 one by accident", () => {
    const v2 = profileFingerprint(V1_FROZEN, 2);
    expect(v2).toMatch(/^2:[0-9a-f]{64}$/);
    expect(profileFingerprintVersion(v2)).toBe(2);
    expect(v2).not.toBe(profileFingerprint(V1_FROZEN, 1));
  });

  it("an unsupported version THROWS rather than minting a confident fingerprint", () => {
    expect(() => canonicalizeProfilePayload(V1_FROZEN, 3)).toThrow(/no canonical form/);
    expect(() => profileFingerprint(V1_FROZEN, 0)).toThrow(/no canonical form/);
  });
});

/* ── the reader accepts both, and a comparison across versions is not a conflict ──────────── */

describe("a v1 document read by this build", () => {
  const meta = {
    updatedAt: new Date("2026-08-27T09:30:00.000Z"),
    producer: { kind: "local", version: "0.17.0" },
  };
  const v1Doc = makeProfileDoc(V1_FROZEN, meta, 1);
  const v2Doc = makeProfileDoc(V1_FROZEN, meta);

  it("parses, and keeps its own version", () => {
    const record = parseProfileMessage(formatProfileMessage(v1Doc, { installId: "older-install" }));
    expect(record).not.toBeNull();
    expect(isMalformedProfile(record!)).toBe(false);
    if (record === null || isMalformedProfile(record)) return;
    expect(record.status).toBe("ok");
    expect(record.v).toBe(1);
    expect(record.doc!.v).toBe(1);
  });

  it("compares SAME to itself — the identity an older ohmail stored still matches", () => {
    const record = parseProfileMessage(formatProfileMessage(v1Doc, { installId: "older-install" }));
    if (record === null || isMalformedProfile(record)) throw new Error("unparsed");
    expect(compareProfileFingerprints(
      profileFingerprint(record.doc!), profileFingerprint(V1_FROZEN, 1),
    )).toBe("same");
  });

  it("compares DIFFERENT-VERSION to its own v2 form — a re-canonicalise signal, never a conflict", () => {
    // The same configuration, both ways. `different` would be a lie about the content and would
    // reach a person as "another install wrote settings you have not seen".
    expect(compareProfileFingerprints(profileFingerprint(v1Doc), profileFingerprint(v2Doc)))
      .toBe("different-version");
  });

  it("…and comparing the two at ONE version answers the content question truthfully", () => {
    expect(profileFingerprint(v1Doc, v2Doc.v)).toBe(profileFingerprint(v2Doc));
  });

  it("a genuinely different configuration is DIFFERENT, not different-version", () => {
    const other = makeProfileDoc({ ...V1_FROZEN, tagNames: ["wheel"] }, meta);
    expect(compareProfileFingerprints(profileFingerprint(v2Doc), profileFingerprint(other)))
      .toBe("different");
  });
});

/* ── a v1 document is re-canonicalised on its NEXT WRITE ─────────────────────────────────── */

/** A folder holding exactly `raw`, recording what a write appends and removes. */
function folderHolding(raw: string[]): {
  io: Parameters<typeof writeOrganizerProfile>[0]["io"];
  appended: string[];
  removed: number;
} {
  const appended: string[] = [];
  const state = { removed: 0 };
  const messages: RawProfileMessage[] = raw.map((r, i) => ({ ref: i + 1, raw: r, generation: 1_000 }));
  return {
    appended,
    get removed(): number { return state.removed; },
    io: {
      ensureMetaFolder: async (): Promise<void> => {},
      listProfileMessages: async (): Promise<RawProfileMessage[]> => messages,
      // An append lands in the folder, as on a server: the write reads its own copy back.
      appendProfile: async (m: string): Promise<void> => {
        appended.push(m);
        messages.push({ ref: messages.length + 100, raw: m, generation: 1_000 });
      },
      removeProfiles: async (refs: readonly unknown[]): Promise<void> => { state.removed += refs.length; },
    },
  };
}

describe("a write over a v1 document", () => {
  const meta = {
    updatedAt: new Date("2026-09-12T10:00:00.000Z"),
    producer: { kind: "local", version: "0.18.0" },
  };

  it("writes v2 — the re-canonicalisation happens at the WRITE, never at the read", () => {
    const doc = makeProfileDoc(V1_FROZEN, meta);
    expect(doc.v).toBe(2);
    expect(doc.v).toBe(PROFILE_VERSION);
    // The stamped `v` and the form the payload was canonicalised in are ONE value: a document
    // stamped v2 whose arrays were ordered by v1's rules parses, fingerprints, and fingerprints
    // WRONG on every other install.
    expect(doc.screener).toEqual(canonicalizeProfilePayload(V1_FROZEN, 2).screener);
    expect(makeProfileDoc(V1_FROZEN, meta, 1).screener)
      .toEqual(canonicalizeProfilePayload(V1_FROZEN, 1).screener);
  });

  it("replaces a FOREIGN v1 document saying the same thing, instead of refusing it as unseen", async () => {
    // The version difference must not read as a disagreement: the caller has never stored this
    // document's fingerprint (`replaceable` is empty), so only the CONTENT question can admit it.
    const older = formatProfileMessage(makeProfileDoc(V1_FROZEN, meta, 1), { installId: "older-install" });
    const folder = folderHolding([older]);
    const result = await writeOrganizerProfile({
      io: folder.io, doc: makeProfileDoc(V1_FROZEN, meta), installId: "this-install",
    });
    expect(result, "a v1 copy of our own configuration refused the write as foreign").toEqual({
      written: true, removed: 1,
    });
    expect(folder.appended).toHaveLength(1);
    expect(JSON.parse(folder.appended[0]!.slice(folder.appended[0]!.indexOf("{"), folder.appended[0]!.lastIndexOf("}") + 1)).v)
      .toBe(2);
  });

  it("still refuses a foreign v1 document that says something ELSE", async () => {
    const stranger = formatProfileMessage(
      makeProfileDoc({ ...V1_FROZEN, tagNames: ["someone-elses"] }, meta, 1),
      { installId: "another-install" },
    );
    const folder = folderHolding([stranger]);
    const result = await writeOrganizerProfile({
      io: folder.io, doc: makeProfileDoc(V1_FROZEN, meta), installId: "this-install",
    });
    expect(result.written).toBe(false);
    expect(result.written === false ? result.reason : null).toBe("foreign");
    expect(folder.appended).toHaveLength(0);
  });

  it("and a document from a version this build cannot read still refuses the write", async () => {
    const future = makeProfileDoc(V1_FROZEN, meta) as unknown as Record<string, unknown>;
    future.v = PROFILE_VERSION + 1;
    const folder = folderHolding([formatProfileMessage(future as never, { installId: "a-newer-build" })]);
    const result = await writeOrganizerProfile({
      io: folder.io, doc: makeProfileDoc(V1_FROZEN, meta), installId: "this-install",
    });
    expect(result.written).toBe(false);
    expect(result.written === false ? result.reason : null).toBe("newer");
  });
});

/* ── the three homes agree about `v` ─────────────────────────────────────────────────────── */

describe("the version field is admitted at all three homes", () => {
  it("the serializer stamps it, the parser reads it, and they name the same number", () => {
    const doc = makeProfileDoc(V1_EMPTY, {
      updatedAt: new Date("2026-09-12T10:00:00.000Z"),
      producer: { kind: "local", version: "0.18.0" },
    });
    const record = parseProfileMessage(formatProfileMessage(doc, { installId: "x" }));
    if (record === null || isMalformedProfile(record)) throw new Error("unparsed");
    expect(record.v).toBe(PROFILE_VERSION);
    expect(record.doc!.v).toBe(PROFILE_VERSION);
  });

  it("the parser reads every version from the floor to this build's, and refuses only above", () => {
    const meta = {
      updatedAt: new Date("2026-09-12T10:00:00.000Z"),
      producer: { kind: "local", version: "0.18.0" },
    };
    for (let v = PROFILE_VERSION_MIN_READ; v <= PROFILE_VERSION; v++) {
      const record = parseProfileMessage(formatProfileMessage(makeProfileDoc(V1_EMPTY, meta, v), { installId: "x" }));
      if (record === null || isMalformedProfile(record)) throw new Error(`v${v} unparsed`);
      expect(record.status, `v${v} is not readable`).toBe("ok");
    }
    const future = makeProfileDoc(V1_EMPTY, meta) as unknown as Record<string, unknown>;
    future.v = PROFILE_VERSION + 1;
    const refused = parseProfileMessage(formatProfileMessage(future as never, { installId: "x" }));
    if (refused === null || isMalformedProfile(refused)) throw new Error("unparsed");
    expect(refused.status).toBe("newer");
  });

  it("the published spec documents the version this build writes and the ones it reads", () => {
    // The third home. A spec that still says "this page documents version 1" while the writer
    // stamps 2 is a published lie a reader would implement.
    const spec = publicPath("docs/organizer-profile.md");
    const text = readFileSync(spec, "utf8");
    expect(text).toContain(`"v": ${PROFILE_VERSION}`);
    expect(text).toMatch(/## The JSON document, version 2/);
    // Both readable versions are named, and the older one is PROMISED, not merely mentioned: a
    // spec that says "this page documents version 2" and nothing else tells a third-party reader
    // that v1 documents are obsolete, which would be a published lie about what ohmail does.
    expect(text).toContain("Version 1 is read for ever");
    expect(text).toMatch(/`v` also names the canonical order/);
  });
});
