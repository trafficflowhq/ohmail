import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import type { Subject } from "../subject.js";
import type { Registry } from "../registry.d.mts";
import { openCalRestPage } from "../../../packages/app/test/states/calrest-page-open.js";

const registry = JSON.parse(readFileSync(resolve(process.cwd(), "test/compare/registry.json"), "utf8")) as Registry;

/**
 * The states this build draws: the two panes in their states and their variants. Left out by class: a mailbox's
 * calendars and ohcal alone ("one account, ohcal alone (K12)"), Mail and calendar ("a setting the wire does not
 * carry"); `declared.json` says them once compared.
 */
const BUILT = (key: string): boolean => {
  const q = new URLSearchParams(key);
  if (q.has("alone") || q.has("mailbox") || q.has("acct")) return false;
  return q.get("sec") !== "frommail" && q.get("sec") !== "notifications";
};

/** What a person did on the pane before the picture: one account opened, a calendar's menu, its rename. */
async function after(p: Page, state: string | null): Promise<void> {
  if (state !== "open" && state !== "menu" && state !== "rename") return;
  await p.locator("button[aria-expanded]").first().click();
  if (state === "open") return;
  await p.locator('button[aria-haspopup="menu"]').nth(1).click();
  if (state === "rename") await p.getByRole("menuitem").first().click();
}

/** Every registered state of the calendar's two panes this build draws, on the calendar's rest states page. */
export const subjects: Subject[] = registry.states
  .filter((s) => s.screen === "calsettings" && s.kind !== "also" && BUILT(s.key))
  .map((s) => ({
    key: s.key,
    open: async (p) => {
      await openCalRestPage(p, s.key);
      await after(p, new URLSearchParams(s.key).get("state"));
    },
  }));
