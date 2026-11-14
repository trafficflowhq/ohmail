/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * TWELVE SMALL REAL-SHAPE TEMPLATES ARE DRAWN FRAMED, WITH NO NOTE. A positive control tuned to the
 * bound proves the bound admits that fixture and nothing more, so this is a corpus of original
 * templates in the layout shapes bulk mail is built in — fluid and responsive columns, a hybrid ghost
 * table, a hero, a gallery, a sidebar, a callout, a receipt, an announcement, a digest — a few kilobytes
 * each, with fictional copy. Each one frames with no note; its tree and text print as fractions.
 */
(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

type Mod = typeof import("../app/letter-body/MessageBody.js");
const mod = async (): Promise<Mod> => import("../app/letter-body/MessageBody.js");

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "fixtures/newsletters");
const templates = readdirSync(DIR).filter((f) => f.endsWith(".html")).sort();

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

async function render(text: string, html: string): Promise<HTMLDivElement> {
  const { MessageBody } = await mod();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(h(MessageBody, { messageId: "m1", text, html })); });
  return host;
}

describe("the newsletter corpus is drawn framed, with no note", () => {
  it("has at least twelve real-shape templates", () => {
    expect(templates.length).toBeGreaterThanOrEqual(12);
  });

  it("each template is designed, frames, shows no sentence, and sits under both bounds", async () => {
    const { sanitizeMailHtml, buildMailDocument, MAX_FRAME_ELEMENTS, MAX_FRAME_TEXT_CHARS } = await mod();
    const { treeWithin } = await import("@ohmail/client-engine/html-tree-budget");
    const rows: string[] = [];
    for (const name of templates) {
      const html = readFileSync(join(DIR, name), "utf8");
      // Every file here is written fresh, so its first line says so and attributes nobody.
      expect(html.split("\n", 1)[0], `${name} does not say it is original`).toMatch(
        /^<!-- Original test fixture written for this repository: .* No real brand, person or address; nothing here is fetched\. -->$/,
      );
      const s = sanitizeMailHtml(html);
      const doc = buildMailDocument(s.html, {});
      const reading = treeWithin(doc, { elements: MAX_FRAME_ELEMENTS, textChars: MAX_FRAME_TEXT_CHARS });
      expect(reading.fits, `${name} did not fit one frame`).toBe(true);
      const el = await render(`the readable words of ${name}`, html);
      expect(el.querySelector("iframe.mb-frame"), `${name} lost its frame`).not.toBeNull();
      expect(el.querySelector(".mb-note"), `${name} showed the oversize sentence`).toBeNull();
      if (reading.fits) {
        rows.push(`${name.padEnd(28)} elements ${String(reading.elements).padStart(4)}/${MAX_FRAME_ELEMENTS} (${(100 * reading.elements / MAX_FRAME_ELEMENTS).toFixed(1)}%)  text ${String(reading.textChars).padStart(5)}/${MAX_FRAME_TEXT_CHARS} (${(100 * reading.textChars / MAX_FRAME_TEXT_CHARS).toFixed(1)}%)`);
      }
      if (root) await act(async () => { root!.unmount(); });
      host?.remove();
      root = null; host = null;
    }
    // The distribution the changelog sentence rests on.
    console.log(`\nNEWSLETTER CORPUS (${templates.length} templates), elements and text as fractions of the frame bounds:\n${rows.join("\n")}\n`);
  }, 30_000);
});
