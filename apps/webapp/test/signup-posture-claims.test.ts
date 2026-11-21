import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { signupPosture } from "@ohmail/app/doors";
import en from "../messages/en.json";
import de from "../messages/de.json";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const SURFACES = [
  ["login", ["inviteOnly", "inviteOnlyBeta", "inviteOnlySelfhost"]],
  ["join", ["step_invite_lead", "step_invite_lead_open", "step_invite_lead_selfhost"]],
] as const;
const CATALOGUES = [
  {
    locale: "en", messages: en,
    claims: [/invite-only/i, /invite code is not required/i, /by invitation/i, /you do not need one to sign up/i],
    open: "An invite code is not required.", gated: "Accounts are by invitation.",
  },
  {
    locale: "de", messages: de,
    claims: [/nur mit Einladung/i, /per Einladung/i, /Einladungscode ist nicht nötig/i, /brauchst du keinen/i],
    open: "Ein Einladungscode ist nicht nötig.", gated: "Accounts gibt es nur mit Einladung.",
  },
] as const;
const makesClaim = (line: string, claims: readonly RegExp[]) => claims.some((rule) => rule.test(line));

describe("the signup posture", () => {
  it("resolves the three postures, and the self-host flavour outranks the flag", () => {
    expect(signupPosture(false, true)).toBe("managed-open");
    expect(signupPosture(false, false)).toBe("managed-invite");
    expect(signupPosture(true, false)).toBe("selfhost");
    expect(signupPosture(true, true)).toBe("selfhost");
  });

  it.each(SURFACES)("%s draws the service or invite control from the catalogue", (surface) => {
    for (const { messages } of CATALOGUES) {
      expect(messages[surface].whereCloud).toBe("ohmail Cloud");
      expect(messages[surface].whereServer).toBeTruthy();
    }
  });
});

describe("the former posture copy", () => {
  for (const { locale, messages, claims } of CATALOGUES) {
    it.each(SURFACES)(`${locale} · %s has no retired posture key`, (surface, retired) => {
      for (const key of retired) expect(messages[surface]).not.toHaveProperty(key);
    });

    it.each(SURFACES)(`${locale} · %s introduces no new posture claim`, (surface) => {
      const found = Object.entries(messages[surface]).filter(([, value]) => makesClaim(value, claims));
      expect(found).toEqual([]);
    });
  }

  it("detects both an open and a gated claim in English", () => {
    const { open, gated, claims } = CATALOGUES[0];
    expect(makesClaim(open, claims)).toBe(true);
    expect(makesClaim(gated, claims)).toBe(true);
    expect(makesClaim(en.join.inviteLabel, claims)).toBe(false);
  });

  it("detects both an open and a gated claim in German", () => {
    const { open, gated, claims } = CATALOGUES[1];
    expect(makesClaim(open, claims)).toBe(true);
    expect(makesClaim(gated, claims)).toBe(true);
    expect(makesClaim(de.join.inviteLabel, claims)).toBe(false);
  });
});

describe("the web holds the signup posture", () => {
  it("the login page reads the flag on the SERVER and hands it down", () => {
    const page = read("../app/(product)/login/page.tsx");
    expect(page).toMatch(/publicSignupEnabled\(\)/);
    expect(page).toMatch(/publicSignup=\{/);
  });

  it.each([
    ["login", "SignInRoute.tsx", "../../../packages/app/src/doors/sign-in/SignInPage.tsx", "LOGIN_INVITE_KEY"],
    ["join", "JoinRoute.tsx", "../../../packages/app/src/doors/join/AccountSteps.tsx", "JOIN_INVITE_KEY"],
  ])("%s keeps its real posture and drops the former claim lookup", (route, file, source, removed) => {
    expect(read(`../app/(product)/${route}/${file}`)).toContain("signupPosture(");
    expect(read(source)).not.toContain(removed);
  });
});
