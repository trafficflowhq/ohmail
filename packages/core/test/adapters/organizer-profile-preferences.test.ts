import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  PROFILE_VERSION,
  makeProfileDoc,
  profileFingerprint,
  type OrganizerProfilePayload,
  type ProfilePreferences,
} from "../../src/adapters/organizer-profile.js";

/**
 * WHAT A PERSON STATED FOR EVERY INSTALL TRAVELS IN THE ENVELOPE: one optional `preferences` key,
 * never in the payload, so it moves no fingerprint and asks no import question. Every site that
 * makes a document must say what is stated: the key of the writer's input is required, and the
 * last case compiles this file to see the compiler refuse a call without it.
 */

const HERE = fileURLToPath(import.meta.url);

const PAYLOAD: OrganizerProfilePayload = {
  screener: [{ address: "anna@example.org", name: "Anna" }],
  rules: [{ kind: "sender", match: "news@example.org", destination: "ohmail/News", priority: 0, enabled: true, provenance: "manual" }],
  notifyRules: [],
  awayResponder: null,
  tagNames: ["kiln"],
  signature: null,
};
const META = { updatedAt: new Date("2026-10-12T08:00:00Z"), producer: { kind: "local", version: "test" } };
const EACH: ProfilePreferences = { subject: { value: "each", at: "2026-10-11T07:30:00.000Z" } };

const written = (preferences: ProfilePreferences): Record<string, unknown> =>
  makeProfileDoc(PAYLOAD, { ...META, preferences }) as unknown as Record<string, unknown>;

describe("the stated preferences in the profile envelope", () => {
  it("nothing stated writes no key, and the document is what it was before the key existed", () => {
    const doc = written({});
    expect("preferences" in doc).toBe(false);
    expect(Object.keys(doc)).toEqual([
      "v", "updatedAt", "producer", "screener", "rules", "notifyRules", "awayResponder", "tagNames", "signature",
    ]);
  });

  it("a stated subject is written with its instant, after the other envelope keys and before the payload", () => {
    const doc = written(EACH);
    expect(doc.preferences).toEqual(EACH);
    const keys = Object.keys(doc);
    expect(keys.indexOf("preferences")).toBe(keys.indexOf("screener") - 1);
    expect(doc.v).toBe(PROFILE_VERSION);
  });

  it("moves no fingerprint: a document that differs only here is the same configuration", () => {
    const bare = makeProfileDoc(PAYLOAD, { ...META, preferences: {} });
    const stated = makeProfileDoc(PAYLOAD, { ...META, preferences: EACH });
    expect(profileFingerprint(stated)).toBe(profileFingerprint(bare));
  });

  it("writes only a word of the closed pair with an instant in the written form", () => {
    const off = (subject: unknown): boolean => "preferences" in written({ subject } as ProfilePreferences);
    expect(off({ value: "every", at: EACH.subject!.at })).toBe(false);
    expect(off({ value: "each", at: "2026-10-11" })).toBe(false);
    expect(off({ value: "each", at: "2026-10-11T07:30:00Z" })).toBe(false);
    expect(off({ value: "each", at: 1_760_168_000_000 })).toBe(false);
    expect(off({ value: "each" })).toBe(false);
    const carried = written({ subject: { ...EACH.subject!, note: "a letter's words" } as never });
    expect(carried.preferences).toEqual(EACH);
  });

  it("a call that leaves the key out does not compile", () => {
    // @ts-expect-error every site that makes a document says what is stated
    const doc = makeProfileDoc(PAYLOAD, META);
    expect("preferences" in doc).toBe(false);

    const said = (d: ts.Diagnostic): string => ts.flattenDiagnosticMessageText(d.messageText, " ");
    const parsed = ts.getParsedCommandLineOfConfigFile(join(dirname(HERE), "..", "..", "tsconfig.test-dirs.json"), {}, {
      ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(said(d)); },
    })!;
    const program = ts.createProgram({ rootNames: [HERE], options: parsed.options });
    const self = program.getSourceFile(HERE)!;
    const read = program.getSourceFiles().map((f) => f.fileName.replace(/\\/g, "/"));
    expect(read.some((f) => f.endsWith("/packages/core/src/adapters/organizer-profile.ts"))).toBe(true);
    const refused = [...parsed.errors, ...program.getSyntacticDiagnostics(self), ...program.getSemanticDiagnostics(self)].map((d) =>
      `${d.file && d.start !== undefined ? `line ${d.file.getLineAndCharacterOfPosition(d.start).line + 1}` : "options"}: TS${d.code} ${said(d)}`);
    expect(refused).toEqual([]);
  }, 120_000);
});
