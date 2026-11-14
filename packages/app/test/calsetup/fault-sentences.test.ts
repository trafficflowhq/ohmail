/**
 * EACH FAULT'S SENTENCE IS IN BOTH CATALOGUES, and a refused sign-in names the app-specific password.
 */
import { describe, expect, it } from "vitest";
import { CONNECT_FAULT_KEYS } from "@ohmail/app-logic/calendar/setup";
import calsetupDe from "../../messages/calsetup.de.json" with { type: "json" };
import calsetupEn from "../../messages/calsetup.en.json" with { type: "json" };

type Tree = { readonly [key: string]: string | Tree };
function said(tree: Tree, key: string): string | undefined {
  let at: string | Tree | undefined = tree;
  for (const part of key.split(".")) at = typeof at === "object" ? at[part] : undefined;
  return typeof at === "string" ? at : undefined;
}

describe("the setup's fault sentences in the catalogues", () => {
  it("finds each key in English and in German", () => {
    for (const key of new Set(Object.values(CONNECT_FAULT_KEYS))) {
      expect(said(calsetupEn.calsetup as Tree, key), `en ${key}`).toBeTruthy();
      expect(said(calsetupDe.calsetup as Tree, key), `de ${key}`).toBeTruthy();
    }
  });

  it("names the app-specific password when a sign-in was refused", () => {
    expect(said(calsetupEn.calsetup as Tree, CONNECT_FAULT_KEYS.sign_in_refused)).toMatch(
      /app-specific password/,
    );
    expect(said(calsetupDe.calsetup as Tree, CONNECT_FAULT_KEYS.sign_in_refused)).toMatch(
      /App-spezifisches Passwort/,
    );
  });
});
