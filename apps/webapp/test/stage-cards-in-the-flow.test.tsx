import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Button, SettingsSection } from "@ohmail/ui";
import en from "../messages/en.json";
import { ProfileImportCard } from "../app/shell/ProfileImportCard";

/**
 * THE STAGE'S CARD COVERS NO CONTROL (SETTINGS-CARD-COVERS-THE-READER-HEAD, DEFAULT-MAIL-CARD-COVERS-SETTINGS-SAVE).
 *
 * The found-settings card floated over the top of the stage and hid the open message's sender line and To
 * header, and the first signature field; the desktop's default-mail card stood fixed at the window's foot over
 * the last Signatures Save, even fully scrolled. Both now stand in the stage's slot, in the flow. Laid out in
 * Chromium over the shipped sheets, the stage's markup as `AppShell` renders it: a pointer at each control's
 * centre lands on that control, never on a card, at a desktop window and at a phone's width.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
const css = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");
const SHEETS = [
  "packages/tokens/src/tokens.css",
  "packages/tokens/src/faces.css",
  "packages/ui/src/base.css",
  "packages/ui/src/primitives/button.css",
  "packages/ui/src/composites/rail.css",
  "packages/ui/src/composites/list-pane.css",
  "packages/ui/src/composites/settings.css",
  "packages/ui/src/composites/message.css",
  "packages/ui/src/composites/reader.css",
  "packages/ui/src/composites/stream.css",
  "apps/webapp/app/app.css",
].map(css).join("\n");

const OFFER = {
  mailboxId: "mb1", address: "mila@example.test",
  candidate: {
    state: "found" as const, fingerprint: "a".repeat(64), updatedAt: "2026-08-10T09:00:00.000Z",
    producer: { kind: "local", version: "0.30.20" },
    counts: { screener: 14, rules: 3, notifyRules: 0, tags: 2, awayResponder: false },
  },
};

/** The found-settings card, as the shell renders it. */
const settingsCard = (): string => renderToStaticMarkup(h(NextIntlClientProvider, {
  locale: "en", messages: en, timeZone: "UTC", now: new Date("2026-08-17T12:00:00.000Z"),
  children: h(ProfileImportCard, { offer: OFFER, phase: { kind: "offer" }, onImport: () => {}, onNotNow: () => {}, onAcknowledge: () => {} }),
}));

/** The desktop's default-mail ask in its slot: `DesktopDefaultMail.tsx`'s markup, which reads the shell. */
const defaultMailCard = (): string => renderToStaticMarkup(
  h("div", { role: "dialog", "aria-label": "Default mail app", "data-key-beside": "", className: "stage-card" },
    h("p", { style: { margin: 0, fontWeight: 600 } }, "Open email links with ohmail?"),
    h("p", { style: { margin: "6px 0 12px" } },
      "Clicking an email address anywhere on this computer would start a new message here. You can change this later in Settings."),
    h("span", { className: "set-tag-acts" }, h(Button, { variant: "primary" }, "Make default"), h(Button, { variant: "ghost" }, "Not now"))),
);

const message = `<article class="msg">
    <div class="msg-from"><button type="button" class="msg-sender" id="sender"><b>Mila Example</b><small><span>mila@example.test</span></small></button></div>
    <div class="msg-rcpts"><button type="button" id="to">To: Ana, Ben, Cleo</button></div>
    <h2>The fair</h2><div class="msg-body"><p>See you there.</p></div>
  </article>`;
/** The open message: the thread column beside the list, or on a phone the reader sheet over it. */
const reader = (phone: boolean): string => `<section class="view split view-ohbox">
  <div class="list-col"><div class="scroller"><div class="row">Mila — The fair</div></div></div>
  <div class="read-col">${phone ? "" : `<div class="conv">${message}</div>`}</div>
</section>${phone ? `<div class="reader">${message}</div>` : ""}`;

/** Settings → Signatures, one row per mailbox as `SignaturesRow` renders it: the editor, then its Save. */
const signatures = (): string => {
  const rows = Array.from({ length: 6 }, (_, i) => renderToStaticMarkup(h("div", { className: "sig-settings" },
    h("div", { className: "lab" }, h("b", null, `box${i + 1}@example.test`), h("span", null, "No signature")),
    h("div", { className: "sig-settings-editor", contentEditable: true, role: "textbox", "aria-label": `Signature: box${i + 1}@example.test` }, "-- "),
    h("div", { className: "sig-settings-actions" }, h(Button, { variant: "primary" }, "Save")))));
  return `<section class="view col view-settings"><div class="vhead"><h1>Settings</h1></div>
    <div class="scroller"><div class="set-layout"><nav class="set-nav"><button type="button" class="on">Signatures</button></nav>
    <div class="set-pane-col">${renderToStaticMarkup(h(SettingsSection, null, h("div", { dangerouslySetInnerHTML: { __html: rows.join("") } })))}</div></div></div>
  </section>`;
};

const reads = (): string => `<section class="view view-reads"><div class="stream">${Array.from({ length: 6 }, (_, i) =>
  `<article class="scast"><h2>Letter ${i + 1}</h2><p>A paragraph of a newsletter.</p></article>`).join("")}</div></section>`;

/** The stage as `AppShell` renders it: the slot first, then the view. */
const shell = (card: string, view: string): string => `<!doctype html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1"><style>${SHEETS}</style>
  <style>html,body{margin:0;height:100%}</style></head>
  <body class="mo-canvas"><div class="app-root"><div class="shell"><div class="deck">
    <nav class="rail"></nav>
    <main class="stage"><div class="stage-notice">${card}</div>${view}</main>
  </div></div></div></body></html>`;

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

interface Probe { sel: string; hits: boolean; onCard: boolean; seen: boolean }

/** A pointer at the centre of each control: does it land there, and on no card it is not part of? */
async function probe(html: string, viewport: { width: number; height: number }, sels: string[], toEnd = false): Promise<Probe[]> {
  const page = await browser!.newPage({ viewport });
  try {
    await page.setContent(html);
    return await page.evaluate(({ sels, toEnd }) => {
      if (toEnd) for (const s of document.querySelectorAll<HTMLElement>(".scroller")) s.scrollTop = s.scrollHeight;
      return sels.map((sel) => {
        const all = document.querySelectorAll<HTMLElement>(sel);
        const el = all[all.length - 1] ?? null;
        if (el === null) return { sel, hits: false, onCard: false, seen: false };
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const seen = r.width > 0 && r.height > 0 && y >= 0 && y < innerHeight && x >= 0 && x < innerWidth;
        const hit = document.elementFromPoint(x, y);
        return { sel, hits: hit !== null && el.contains(hit), onCard: hit?.closest(".stage-card") !== null && el.closest(".stage-card") === null, seen };
      });
    }, { sels, toEnd });
  } finally {
    await page.close();
  }
}

const reachable = (sel: string): Probe => ({ sel, hits: true, onCard: false, seen: true });

describe.each([
  ["a desktop window", { width: 1280, height: 800 }],
  ["a phone's width", { width: 390, height: 844 }],
] as const)("the stage's card in %s", (_, viewport) => {
  it("leaves the open message's sender line and To header to the pointer", async () => {
    const at = await probe(shell(settingsCard(), reader(viewport.width < 700)), viewport, ["#sender", "#to"]);
    expect(at).toEqual(["#sender", "#to"].map(reachable));
  });

  it("leaves the first signature field to the pointer", async () => {
    const at = await probe(shell(settingsCard(), signatures()), viewport, [".sig-settings:first-of-type .sig-settings-editor"]);
    expect(at).toEqual([reachable(".sig-settings:first-of-type .sig-settings-editor")]);
  });

  it("leaves the last Save to the pointer once the pane is scrolled to its end, under the default-mail card too", async () => {
    for (const card of [defaultMailCard(), settingsCard()]) {
      expect(await probe(shell(card, signatures()), viewport, [".sig-settings-actions button"], true)).toEqual([reachable(".sig-settings-actions button")]);
    }
  });

  it("RED CONTROL: the default-mail card fixed at the window's foot, as it stood, covers that Save", async () => {
    const fixed = defaultMailCard().replace('class="stage-card"', 'class="stage-card" style="position:fixed;inset-inline:0;bottom:24px;margin:0 auto;width:min(440px,calc(100vw - 32px));z-index:80"');
    const [save] = await probe(shell(fixed, signatures()), viewport, [".sig-settings-actions button"], true);
    expect({ hits: save!.hits, onCard: save!.onCard }).toEqual({ hits: false, onCard: true });
  });

  it("keeps the card's own buttons pressable above a reading stream", async () => {
    const at = await probe(shell(settingsCard(), reads()), viewport, [".pfi-actions button:first-child", ".pfi-actions button:last-child"]);
    expect(at.map((p) => ({ ...p, onCard: false }))).toEqual([".pfi-actions button:first-child", ".pfi-actions button:last-child"].map(reachable));
  });
});
