import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  JOIN_INVITE_KEY, LOGIN_INVITE_KEY, signupPosture, type SignupPosture,
} from "@ohmail/app/doors";

/**
 * **WHAT THIS DEPLOYMENT ASKS FOR IS ONE FACT, AND THE APP SAYS IT ONCE PER SURFACE.**
 *
 * The measured defect: `login.inviteOnly` ("an invite code is not required") rendered on every
 * managed build whatever `TF_PUBLIC_SIGNUP` said, while `/join` picked its lead by that flag — so
 * an invite-only managed deployment answered a visitor two ways in one visit. The old copy guard
 * next door is a string BAN; a ban cannot see a true sentence rendered in the posture that makes
 * it false.
 *
 * So this reads BOTH ways, because a gate that cannot say what it did not cover covered nothing:
 *   · every posture-asserting sentence in the catalogue is registered against a posture, and
 *   · every posture is named by exactly one sentence per surface, rendered under a gate that
 *     makes it true.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const read = (p: string): string => readFileSync(`${HERE}${p}`, "utf8");
const catalogue = (locale: string): Record<string, Record<string, string>> =>
  JSON.parse(read(`../messages/${locale}.json`)) as Record<string, Record<string, string>>;

const POSTURES: SignupPosture[] = ["selfhost", "managed-open", "managed-invite"];
const SURFACES = [
  ["login", LOGIN_INVITE_KEY],
  ["join", JOIN_INVITE_KEY],
] as const;

/**
 * THE SWEEP, PER LOCALE. A value is a posture CLAIM when it asserts what this deployment requires
 * — not when it merely says the word "invite": `haveInvite` ("Have an invite code?") is a link,
 * `inviteLabel` a field name, and `inviteRequiredAfterAll` reports what one server answered rather
 * than what the deployment is. Each pattern is one of the assertion shapes the shipped copy
 * actually uses, and the patterns are per language because prose is: an English list read over
 * `de.json` matches nothing and the sweep would pass for having looked at nothing. An unregistered
 * match is a refusal, which is what makes this the second direction and not decoration.
 */
const POSTURE_CLAIM: Record<string, RegExp[]> = {
  en: [/invite-only/i, /invite code is not required/i, /by invitation/i,
       /you do not need one to sign up/i],
  de: [/nur mit Einladung/i, /per Einladung/i, /Einladungscode ist nicht nötig/i,
       /brauchst du keinen/i],
};

const claimsIn = (locale: string, ns: Record<string, string>): string[] =>
  Object.entries(ns)
    .filter(([, v]) => typeof v === "string" && POSTURE_CLAIM[locale]!.some((re) => re.test(v)))
    .map(([k]) => k);

describe("the posture table names every deployment exactly once", () => {
  it("resolves the three postures, and the self-host flavour outranks the flag", () => {
    expect(signupPosture(false, true)).toBe("managed-open");
    expect(signupPosture(false, false)).toBe("managed-invite");
    // Invitation is the self-host design, not a beta condition: the env flag cannot open it.
    expect(signupPosture(true, false)).toBe("selfhost");
    expect(signupPosture(true, true)).toBe("selfhost");
  });

  it.each(SURFACES)("%s: one key per posture, and no key serves two", (surface, table) => {
    const keys = POSTURES.map((p) => table[p]);
    expect(keys, `${surface}: a posture has no sentence`).toEqual(keys.filter(Boolean));
    expect(new Set(keys).size, `${surface}: one sentence is claimed by two postures`)
      .toBe(POSTURES.length);
  });
});

describe("every registered claim exists and says what its posture makes true", () => {
  for (const locale of ["en", "de"]) {
    it.each(SURFACES)(`${locale} · %s: every posture's sentence is in the catalogue`,
      (surface, table) => {
        const ns = catalogue(locale)[surface] ?? {};
        for (const posture of POSTURES) {
          const key = table[posture];
          expect(ns[key], `${locale}: ${surface}.${key} is missing — ${posture} has no sentence`)
            .toBeTruthy();
        }
      });
  }

  /**
   * The CONTENT half, English only: the German twin is held to existence and to the sweep above,
   * because a needle list per language is a second catalogue of claims and would drift from this
   * one. `de.json` moves with `en.json` in the same commit by the twin rule.
   */
  it("an open deployment promises no code; a gated one says a code is the way in", () => {
    const en = catalogue("en");
    const open = en.login![LOGIN_INVITE_KEY["managed-open"]]!;
    expect(open).toMatch(/not required|do not need/i);
    expect(open, "the open sentence also claims the deployment is gated").not.toMatch(/invite-only/i);

    for (const posture of ["managed-invite", "selfhost"] as const) {
      for (const [surface, table] of SURFACES) {
        const sentence = en[surface]![table[posture]]!;
        expect(sentence, `${surface}.${table[posture]} does not say a code is needed`)
          .toMatch(/invite-only|by invitation/i);
        expect(sentence, `${surface}.${table[posture]} promises signup without a code`)
          .not.toMatch(/not required|do not need one to sign up/i);
      }
    }
  });

  /**
   * THE POSITIVE CONTROL for the content rule: a catalogue whose three sentences are each true of
   * their posture is admitted. Without it the rule above could be green by matching nothing.
   */
  it("admits a catalogue that states all three postures truthfully", () => {
    const honest: Record<SignupPosture, string> = {
      selfhost: "Accounts on this server are created by invitation.",
      "managed-open": "You can sign up — an invite code is not required.",
      "managed-invite": "ohmail is invite-only during the beta.",
    };
    expect(honest["managed-open"]).toMatch(/not required|do not need/i);
    expect(honest["managed-open"]).not.toMatch(/invite-only/i);
    for (const p of ["managed-invite", "selfhost"] as const) {
      expect(honest[p]).toMatch(/invite-only|by invitation/i);
      expect(honest[p]).not.toMatch(/not required|do not need one to sign up/i);
    }
  });
});

describe("and nothing else in these namespaces asserts a posture", () => {
  for (const locale of ["en", "de"]) {
    it.each(SURFACES)(`${locale} · %s: every posture claim found is a registered one`,
      (surface, table) => {
        const registered = new Set(POSTURES.map((p) => table[p]));
        const found = claimsIn(locale, catalogue(locale)[surface] ?? {});
        // Direction two: a sentence that asserts the deployment's posture and is NOT rendered by
        // the table is a claim nothing gates — the shape `login.inviteOnly` was in.
        expect(found.filter((k) => !registered.has(k)),
          `${locale}: ${surface} carries a posture claim outside the table`).toEqual([]);
        // …and the sweep is not blind: it must find the registered ones.
        expect([...registered].filter((k) => !found.includes(k)),
          `${locale}: ${surface} has a registered key the sweep does not read as a claim`)
          .toEqual([]);
      });
  }
});

describe("both screens render the claim their posture makes true", () => {
  const login = read("../app/(product)/login/SignInRoute.tsx") + read("../../../packages/app/src/doors/sign-in/SignInPage.tsx");
  const loginPage = read("../app/(product)/login/page.tsx");
  const join = read("../app/(product)/join/JoinRoute.tsx") + read("../../../packages/app/src/doors/join/AccountSteps.tsx");

  it("the login page reads the flag on the SERVER and hands it down", () => {
    // Same seam as `/join/page.tsx`: the screen is a client component and may not read the
    // variable, and inlining it as `NEXT_PUBLIC_*` would publish the posture to every reader.
    expect(loginPage).toMatch(/publicSignupEnabled\(\)/);
    expect(loginPage).toMatch(/publicSignup=\{/);
  });

  it.each([["LoginScreen", () => login, "LOGIN_INVITE_KEY"],
           ["JoinScreen", () => join, "JOIN_INVITE_KEY"]] as const)(
    "%s selects its sentence through the table", (_name, src, table) => {
      const text = src();
      expect(text, `the screen does not read ${table}`).toContain(table);
      expect(text, "the screen does not resolve a posture").toContain("signupPosture(");
      // The hand-written ternaries the table replaced: a literal key here is a claim that can go
      // false again with one merge.
      for (const posture of POSTURES) {
        for (const [, t] of SURFACES) {
          expect(text, `${t[posture]} is still selected by a literal`)
            .not.toContain(`"${t[posture]}"`);
        }
      }
    });
});
