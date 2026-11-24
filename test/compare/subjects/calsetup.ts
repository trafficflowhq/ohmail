import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import type { Subject } from "../subject.js";
import type { Registry } from "../registry.d.mts";
import { openCalRestPage } from "../../../packages/app/test/states/calrest-page-open.js";

const registry = JSON.parse(readFileSync(resolve(process.cwd(), "test/compare/registry.json"), "utf8")) as Registry;

/** The states this build draws: the ways, iCloud's sign-in, its refusal and the steps after it, from Settings too. */
const BUILT = (key: string): boolean => {
  const q = new URLSearchParams(key);
  if (q.has("alone") || q.has("mailbox")) return false;
  const step = q.get("step");
  if (step === "signin") return q.get("provider") === "icloud";
  return step === "calendar" || step === "calendars" || step === "default" || step === "wait";
};

/** The refusal: a sign-in typed and pressed once, which our server refuses. */
async function after(p: Page, key: string): Promise<void> {
  if (new URLSearchParams(key).get("state") !== "error") return;
  const blanks = p.getByRole("textbox");
  await blanks.first().fill("mila");
  await p.locator('input[type="password"]').fill("abcd-efgh-ijkl-mnop");
  await p.getByRole("button", { name: "Connect" }).click();
}

/**
 * Every registered state of the setup this build draws, on the calendar's rest states page. Left out by class: Google's
 * and Microsoft's steps ("behind its switch, off"), a mailbox's calendars, ohcal alone and the welcome ("one account,
 * ohcal alone (K12)"), the `mail` step ("a setting the wire does not carry").
 */
export const subjects: Subject[] = registry.states
  .filter((s) => s.screen === "calsetup" && s.kind !== "also" && BUILT(s.key))
  .map((s) => ({
    key: s.key,
    open: async (p) => {
      await openCalRestPage(p, s.key);
      await after(p, s.key);
    },
  }));
