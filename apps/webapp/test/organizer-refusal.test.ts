import { describe, expect, it } from "vitest";
import { organizerRefusalOf, organizerRefusalSentence } from "@ohmail/app-logic/press/organizer-refusal";
import { postureRefusal, rulesPostureOf } from "@ohmail/app-logic/press/rules-posture";
import en from "../messages/en.json";
import de from "../messages/de.json";

/**
 * The shared reading of a reader's refusal, and the Rules pane's posture over the roster. The
 * sentences are read through the real catalogues, so a missing key is a red here, not a raw key
 * on somebody's screen.
 */

const refusal = (details: unknown, code = "organized_elsewhere") => ({ code, details });

function tOf(cat: typeof en): (key: string, values?: Record<string, string>) => string {
  return (key, values) => {
    const leaf = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], cat.ohbox);
    if (typeof leaf !== "string") throw new Error(`ohbox.${key} is not in the catalogue`);
    return leaf.replace(/\{(\w+)\}/g, (_, k: string) => values?.[k] ?? `{${k}}`);
  };
}

describe("organizerRefusalOf", () => {
  it("reads the three reasons, and the name where one is given", () => {
    expect(organizerRefusalOf(refusal({ by: { kind: null, name: null }, reason: "no_organizer" }))).toEqual({ kind: "nobody" });
    expect(organizerRefusalOf(refusal({ reason: "no_organizer" }), { starting: true })).toEqual({ kind: "starting" });
    expect(organizerRefusalOf(refusal({ by: { name: " Studio laptop " }, reason: "organizer_outdated" })))
      .toEqual({ kind: "outdated", name: "Studio laptop" });
    expect(organizerRefusalOf(refusal({ by: { name: "ohmail Cloud" } }))).toEqual({ kind: "elsewhere", name: "ohmail Cloud" });
    expect(organizerRefusalOf(refusal(undefined))).toEqual({ kind: "elsewhere", name: null });
  });

  it("is not about any other refusal, and not about none", () => {
    expect(organizerRefusalOf(refusal({ reason: "no_organizer" }, "not_found"))).toBeNull();
    expect(organizerRefusalOf(undefined)).toBeNull();
    expect(organizerRefusalOf(null)).toBeNull();
  });

  it("every state has a sentence in both catalogues", () => {
    for (const cat of [en, de as typeof en]) {
      const t = tOf(cat);
      for (const r of [
        { kind: "nobody" }, { kind: "starting" }, { kind: "outdated", name: "Studio laptop" },
        { kind: "outdated", name: null }, { kind: "elsewhere", name: "Studio laptop" }, { kind: "elsewhere", name: null },
      ] as const) {
        const s = organizerRefusalSentence(r, t);
        expect(s, JSON.stringify(r)).toBeTruthy();
        if ("name" in r && r.name) expect(s).toContain(r.name);
      }
      expect(organizerRefusalSentence(null, t)).toBeNull();
    }
  });
});

describe("rulesPostureOf — the roster before the press", () => {
  const base = { status: "connected" as const };
  it("an organizer, or no roster at all, can press", () => {
    expect(rulesPostureOf([{ ...base, organizerRole: "organizer" }])).toEqual({ mode: "organizer" });
    expect(rulesPostureOf(null)).toEqual({ mode: "organizer" });
    expect(postureRefusal({ mode: "organizer" })).toBeNull();
  });

  it("a holder that takes requests: the edit travels, nothing is locked", () => {
    const p = rulesPostureOf([{
      ...base, organizerRole: "reader", organizedBy: { kind: "local", name: "Studio laptop", since: null },
      organizerState: "held", organizerAcceptsRequests: true, organizeConsentedAt: "2026-09-01T00:00:00Z",
    }]);
    expect(p).toEqual({ mode: "pending", name: "Studio laptop" });
    expect(postureRefusal(p)).toBeNull();
  });

  it("handed back: blocked, nobody", () => {
    const p = rulesPostureOf([{
      ...base, organizerRole: "reader", organizedBy: null, organizerState: null,
      organizeConsentedAt: "2026-09-01T00:00:00Z", organizerReleasedAt: "2026-09-02T00:00:00Z",
    }]);
    expect(p).toEqual({ mode: "blocked", reason: "no_organizer", name: null });
    expect(postureRefusal(p)).toEqual({ kind: "nobody" });
  });

  it("Organize here pressed, claim not landed: starting", () => {
    const p = rulesPostureOf([{
      ...base, organizerRole: "reader", organizedBy: null, organizerState: null,
      organizeConsentedAt: "2026-09-01T00:00:00Z", takeoverAuthorizedAt: "2026-09-02T00:00:00Z",
    }]);
    expect(p).toEqual({ mode: "starting" });
    expect(postureRefusal(p)).toEqual({ kind: "starting" });
  });

  it("setup not finished — a reader nothing holds and nobody agreed to: blocked, nobody", () => {
    const unconsented = { ...base, organizerRole: "reader" as const, organizedBy: null, organizeConsentedAt: null };
    expect(rulesPostureOf([unconsented])).toEqual({ mode: "blocked", reason: "no_organizer", name: null });
    // …but one mailbox organized here is enough for a press to land.
    expect(rulesPostureOf([unconsented, { ...base, organizerRole: "organizer" }])).toEqual({ mode: "organizer" });
  });

  it("a named holder that takes no requests: blocked, outdated, named", () => {
    const p = rulesPostureOf([{
      ...base, organizerRole: "reader", organizedBy: { kind: "local", name: "Old laptop", since: null },
      organizerState: "held", organizerAcceptsRequests: false, organizeConsentedAt: "2026-09-01T00:00:00Z",
    }]);
    expect(p).toEqual({ mode: "blocked", reason: "organizer_outdated", name: "Old laptop" });
    expect(postureRefusal(p)).toEqual({ kind: "outdated", name: "Old laptop" });
  });

  it("a named holder whose lease lapsed (stopped): blocked, nobody — never 'update ohmail on it'", () => {
    const p = rulesPostureOf([{
      ...base, organizerRole: "reader", organizedBy: { kind: "local", name: "Old laptop", since: null },
      organizerState: "stopped", organizerAcceptsRequests: false, organizeConsentedAt: "2026-09-01T00:00:00Z",
    }]);
    expect(p).toMatchObject({ mode: "blocked", reason: "no_organizer" });
    expect(postureRefusal(p)).toEqual({ kind: "nobody" });
    // …and with this install's Organize-here press standing, it is starting like any unheld one.
    expect(rulesPostureOf([{
      ...base, organizerRole: "reader", organizedBy: { kind: "local", name: "Old laptop", since: null },
      organizerState: "stopped", organizeConsentedAt: "2026-09-01T00:00:00Z",
      takeoverAuthorizedAt: "2026-09-02T00:00:00Z",
    }])).toEqual({ mode: "starting" });
  });
});
