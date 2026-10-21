import { describe, expect, it } from "vitest";
import {
  formatProfileMessage,
  isMalformedProfile,
  localSaysWhatAFingerprintSays,
  makeProfileDoc,
  parseProfileMessage,
  profileFingerprint,
  readOrganizerProfile,
  readProfileGap,
  type OrganizerProfilePayload,
  type ParsedProfileMessage,
  type ProfileGap,
  type ProfileIo,
  type RawProfileMessage,
} from "../../src/adapters/organizer-profile.js";

/**
 * WHERE THE LAST HAND-BACK LEFT THE GAP travels in the envelope (RULING-026 lane A): one optional
 * `gap` key after `screening`, outside the payload and the fingerprint. Read well-formed only, and
 * only when it names the message's own writer; a present-but-unreadable key is named and dropped.
 */

const PAYLOAD: OrganizerProfilePayload = {
  screener: [{ address: "anna@example.org", name: "Anna" }],
  rules: [{ kind: "sender", match: "news@example.org", destination: "ohmail/News", priority: 0, enabled: true, provenance: "manual" }],
  notifyRules: [],
  awayResponder: null,
  tagNames: ["kiln"],
  signature: null,
};
const WRITER = "install-desktop-1";
const GAP: ProfileGap = { since: "2026-10-20T09:00:00.000Z", by: WRITER, at: "2026-10-20T09:00:29.000Z" };
const META = { updatedAt: new Date("2026-10-20T09:00:29Z"), producer: { kind: "local", version: "test" } };

function parsed(raw: string): ParsedProfileMessage {
  const r = parseProfileMessage(raw);
  if (r === null || isMalformedProfile(r)) throw new Error("expected a readable document");
  return r;
}

/** A written document with its `gap` key replaced by `value` (removed for `undefined`). */
function withGap(value: unknown, v = 2, installId = WRITER): string {
  const doc = makeProfileDoc(PAYLOAD, { ...META, gap: GAP }, v) as unknown as Record<string, unknown>;
  if (value === undefined) delete doc.gap; else doc.gap = value;
  return formatProfileMessage(doc as never, { installId });
}

describe("the gap in the profile envelope", () => {
  it.each([1, 2])("round-trips at v%i, reads as written, after `screening`", (v) => {
    const doc = makeProfileDoc(PAYLOAD, {
      ...META, gap: GAP, screening: { baselineAt: null, dormancyDays: 30, scope: "window" },
    }, v);
    expect(Object.keys(doc).slice(0, 5)).toEqual(["v", "updatedAt", "producer", "screening", "gap"]);
    const r = parsed(formatProfileMessage(doc, { installId: WRITER }));
    expect(r.v).toBe(v);
    expect(r.doc!.gap).toEqual(GAP);
    expect(r.gapRefused).toBeUndefined();
    expect(r.encoded, "a key outside the admitted list is escaped and reads as not-as-written").toBe(true);
  });

  it("writes the two instants and the install id plain", () => {
    const raw = formatProfileMessage(makeProfileDoc(PAYLOAD, { ...META, gap: GAP }), { installId: WRITER });
    expect(raw).toContain(`"since": "${GAP.since}"`);
    expect(raw).toContain(`"by": "${GAP.by}"`);
    expect(raw).toContain(`"at": "${GAP.at}"`);
  });

  it("is outside the fingerprint, at v1 and v2, and the local store still says what the document says", () => {
    for (const v of [1, 2]) {
      const bare = makeProfileDoc(PAYLOAD, META, v);
      const carrying = makeProfileDoc(PAYLOAD, { ...META, gap: GAP }, v);
      expect(profileFingerprint(carrying)).toBe(profileFingerprint(bare));
      const read = parsed(formatProfileMessage(carrying, { installId: WRITER })).doc!;
      expect(profileFingerprint(read)).toBe(profileFingerprint(bare));
      expect(localSaysWhatAFingerprintSays(PAYLOAD, profileFingerprint(read))).toBe(true);
    }
    const { gap: _g, ...rest } = makeProfileDoc(PAYLOAD, { ...META, gap: GAP });
    expect(rest).toEqual(makeProfileDoc(PAYLOAD, META));
  });

  it("absent is UNSTATED: no key on the document and nothing refused", () => {
    const r = parsed(withGap(undefined));
    expect("gap" in r.doc!).toBe(false);
    expect(r.gapRefused).toBeUndefined();
  });

  it.each([
    ["not an object", "2026-10-20T09:00:00.000Z", "gap is not an object"],
    ["null", null, "gap is not an object"],
    ["since not in the written form", { ...GAP, since: "2026-10-20" }, "gap.since is not the ISO form ohmail writes"],
    ["at not in the written form", { ...GAP, at: 17 }, "gap.at is not the ISO form ohmail writes"],
    ["since after at", { ...GAP, since: "2026-10-20T09:01:00.000Z" }, "gap.since is after gap.at"],
    ["an empty install id", { ...GAP, by: "" }, "gap.by is not an install id"],
    ["an install id with a control byte", { ...GAP, by: `${WRITER}\u0007` }, "gap.by is not an install id"],
    ["an install id over the bound", { ...GAP, by: "x".repeat(257) }, "gap.by is not an install id"],
    ["another install's id", { ...GAP, by: "install-somebody-else" }, "gap.by is not the install that wrote the message"],
  ])("malformed (%s): the document stands, the gap is dropped and named", (_label, value, reason) => {
    const r = parsed(withGap(value));
    expect("gap" in r.doc!).toBe(false);
    expect(r.gapRefused).toBe(reason);
    expect(profileFingerprint(r.doc!)).toBe(profileFingerprint({ ...PAYLOAD, v: 2 }));
  });

  it("the read of the folder carries the refusal beside the document", async () => {
    const io: ProfileIo = {
      async listProfileMessages(): Promise<RawProfileMessage[]> {
        return [{ ref: 1, raw: withGap({ ...GAP, by: "install-somebody-else" }), generation: 7 }];
      },
      async appendProfile(): Promise<void> { throw new Error("a read appends nothing"); },
      async removeProfiles(): Promise<void> { throw new Error("a read removes nothing"); },
      async ensureMetaFolder(): Promise<void> {},
    } as unknown as ProfileIo;
    const read = await readOrganizerProfile(io);
    expect(read.state).toBe("found");
    if (read.state !== "found") return;
    expect(read.gapRefused).toBe("gap.by is not the install that wrote the message");
    expect(read.doc.gap).toBeUndefined();
  });

  it("readProfileGap answers undefined, a gap, or a refusal", () => {
    expect(readProfileGap(undefined, WRITER)).toBeUndefined();
    expect(readProfileGap(GAP, WRITER)).toEqual(GAP);
    expect(readProfileGap(GAP, null)).toHaveProperty("refused");
    expect(readProfileGap({ ...GAP, since: GAP.at }, WRITER)).toEqual({ ...GAP, since: GAP.at });
  });
});
