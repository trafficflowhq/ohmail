/** @vitest-environment jsdom */
import { chromium } from "@playwright/test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { RulesPane, rulesStates } from "../../../src/settings/rules/index.js";
import { drawn, said } from "./words.js";

afterEach(cleanup);

it("wraps the whole address in the revoke confirmation at phone width", async () => {
  const address = ["sender".repeat(9), "example.invalid"].join("@");
  const words = (key: string) => said("en", "rules", key);
  const { model } = rulesStates({
    rules: [
      {
        id: "rule",
        who: address,
        person: null,
        what: `Mail from ${address}`,
        folder: "INBOX",
        place: "Ohbox",
        origin: "",
        byOhmail: false,
        notes: [],
        outranked: false,
        queued: false,
        places: [],
        refile: { label: "", note: "", on: "" },
        finds: address,
      },
    ],
    intro: words("intro"),
    introHeld: "",
    locked: "",
    facets: [],
    waiting: [],
    refusal: { lead: "", why: "" },
  }).rest;
  drawn(<RulesPane model={model} />);
  fireEvent.click(screen.getByRole("button", { name: words("revoke") }));
  const dialog = screen.getByRole("dialog", { name: words("revokeConfirm") });
  expect(dialog.textContent).toContain(address);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(dialog.parentElement!.outerHTML);
    for (const path of [
      "packages/tokens/src/tokens.css",
      "packages/ui/src/base.css",
      "packages/ui/src/base/Overlays/overlay.css",
      "packages/ui/src/base/Overlays/dialog.css",
      "packages/ui/src/mail/Settings/setting-note.css",
    ]) {
      await page.addStyleTag({ content: readFileSync(path, "utf8").replace(/^@import[^;]+;/gm, "") });
    }
    const inside = await page.getByText(address, { exact: false }).evaluate((note, value) => {
      const text = note.firstChild!;
      const start = text.textContent!.indexOf(value);
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, start + value.length);
      const bounds = note.closest("[role=dialog]")!.getBoundingClientRect();
      const lines = [...range.getClientRects()];
      return (
        lines.length > 1 && lines.every((line) => line.left >= bounds.left && line.right <= bounds.right)
      );
    }, address);
    expect(inside).toBe(true);
  } finally {
    await browser.close();
  }
}, 30_000);
