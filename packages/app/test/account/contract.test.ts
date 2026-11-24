/**
 * THE ACCOUNT GROUP'S LISTS: every refusal word a door answers has a sentence in both catalogues, and every member of
 * every door has its row of what a closed account still reaches. (That each row is what the server answers is held
 * where the server's own route table is in reach: the root test folder's `account-closed-reach.test.ts`.)
 */
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_DOORS,
  ACCOUNT_REFUSALS,
  CLOSED_ACCOUNT_REACH,
  type CatalogueKey,
} from "../../src/account/contract.js";
import accountDe from "../../messages/account.de.json" with { type: "json" };
import accountEn from "../../messages/account.en.json" with { type: "json" };
import subscriptionDe from "../../messages/account-subscription.de.json" with { type: "json" };
import subscriptionEn from "../../messages/account-subscription.en.json" with { type: "json" };
import doorsDe from "../../messages/doors.de.json" with { type: "json" };
import doorsEn from "../../messages/doors.en.json" with { type: "json" };
import settingsDe from "../../messages/settings.de.json" with { type: "json" };
import settingsEn from "../../messages/settings.en.json" with { type: "json" };

const WORDS: Readonly<Record<"en" | "de", Readonly<Record<string, unknown>>>> = {
  en: { ...accountEn, ...subscriptionEn, ...doorsEn, ...settingsEn },
  de: { ...accountDe, ...subscriptionDe, ...doorsDe, ...settingsDe },
};
const sentence = (lang: "en" | "de", { namespace, key }: CatalogueKey): unknown =>
  (WORDS[lang][namespace] as Record<string, unknown> | undefined)?.[key];

/**
 * A sentence whose key the contract fixes before its pane's place file brings its words. Empty: the one that was
 * new, the plans' read that could not be made, arrived with the Subscription pane.
 */
const ARRIVES_WITH_ITS_PANE: readonly string[] = [];

describe("the refusal words of the eight doors", () => {
  const rows = ACCOUNT_DOORS.flatMap((door) =>
    Object.entries(ACCOUNT_REFUSALS[door] as Record<string, CatalogueKey>).map(([word, at]) => ({
      door,
      word,
      at,
    })),
  );

  it("each has a sentence in English and in German, at the key the pane says today", () => {
    const missing: string[] = [];
    for (const { door, word, at } of rows) {
      const name = `${at.namespace}.${at.key}`;
      const stands = (["en", "de"] as const).every((lang) => typeof sentence(lang, at) === "string");
      if (stands === ARRIVES_WITH_ITS_PANE.includes(name)) missing.push(`${door}.${word} -> ${name}`);
    }
    expect(missing).toEqual([]);
  });

  it("every gated door says the sign-in remedy, and no door answers `factor` or `said` as a word of its own", () => {
    for (const door of ["devices", "invites", "security", "password", "storage"] as const)
      expect(ACCOUNT_REFUSALS[door]).toHaveProperty("sign_in");
    for (const { word } of rows) expect(["factor", "said"]).not.toContain(word);
  });

  it("a locked password names its minutes", () => {
    expect(sentence("en", ACCOUNT_REFUSALS.password.locked)).toContain("{minutes");
    expect(sentence("de", ACCOUNT_REFUSALS.password.locked)).toContain("{minutes");
  });
});

describe("what a closed account still reaches", () => {
  it("has a row for every door, and a row that asks nothing is always reached", () => {
    expect(Object.keys(CLOSED_ACCOUNT_REACH).sort()).toEqual([...ACCOUNT_DOORS].sort());
    for (const door of ACCOUNT_DOORS)
      for (const [member, row] of Object.entries(CLOSED_ACCOUNT_REACH[door]))
        if (row.asks.length === 0) expect(row.answered, `${door}.${member}`).toBe(true);
  });

  it("keeps the ways out and takes the panes' lists: the wall's own promise", () => {
    const { devices, invites, password, account, subscription, storage } = CLOSED_ACCOUNT_REACH;
    // Behind the wall: the password, the way to the delete page, the way back to paying, sign-out.
    expect(
      [password.change, account.signOut, account.toErase, subscription.manage].map((r) => r.answered),
    ).toEqual([true, true, true, true]);
    // And no pane of Settings: its lists are not read, its plan is not changed, its mails are not switched.
    expect([devices.read, invites.read, storage.setMail, storage.change].map((r) => r.answered)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});
