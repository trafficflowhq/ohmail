/** @vitest-environment jsdom */
/**
 * THE BODY'S HALF OF THE TRACKING NOTICE: the cases of `tracking-notice.test.tsx` that read only the letter's body
 * (`@ohmail/letter-body`: its notice table, its captions, the viewer mounted bare) and the two catalogues, moved here
 * as they stood (share reader-1) so that they no longer load today's stream card, which that file still draws. The
 * body is the one the new reader mounts (`packages/app/src/reader/body/LetterBody.tsx`); its notice reaches the
 * letter's head through `onNotice`, and a mount that hands no `onNotice` still says the sentence in the body's bar.
 *
 *  1. THE CENSUS. Every sentence in the `mailBody` namespace that says something was blocked has a caption twin
 *     (`NOTICE_CAPTION` in `BlockNotice.tsx`), and every caption it names exists in both catalogues, is short, and is
 *     not a sentence.
 *  2. THE SEAM. The viewer mounted BARE (no host to carry the fact) still says the sentence in its bar.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { COPY, MessageBody } from "../../../packages/letter-body/src/MessageBody";
import { CAPTION_KEY, NOTICE_CAPTION, type NoticeKind } from "../../../packages/letter-body/src/BlockNotice";
import { DEFAULT_LOCALE, setActiveCatalog } from "../app/shell/locale";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const SENDER = "images.newsletter.example";
const BEACON = `https://${SENDER}/wf/open?upn=abc`;
const canvas = (inner: string) => `<table width="600"><tr><td><p>hello</p>${inner}</td></tr></table>`;
const PIXEL_ONLY = canvas(`<img src="${BEACON}" width="1" height="1">`);

type Catalogue = Record<string, Record<string, string>>;
const EN = en as unknown as Catalogue;
const DE = de as unknown as Catalogue;

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const hosts: HTMLElement[] = [];

async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
}

afterEach(async () => {
  for (const r of roots.splice(0)) await act(async () => { r.unmount(); });
  for (const el of hosts.splice(0)) el.remove();
  setActiveCatalog(DEFAULT_LOCALE, null);
});

/* ── 1. the census ────────────────────────────────────────────────────────────────────────── */

describe("the census: every notice sentence in mailBody has a caption twin", () => {
  const isSentence = (s: string) => /\.$/.test(s.trim());

  it("every mailBody sentence that says something was blocked is in NOTICE_CAPTION", () => {
    // LEXICAL, so a sibling added to the bar tomorrow without a row in the table is red: the rule is
    // "a full sentence in this namespace that names a block is a notice". Captions carry the word
    // too and are not sentences, which is what the period distinguishes.
    const notices = Object.entries(EN.mailBody!)
      .filter(([, v]) => /blocked/i.test(v) && isSentence(v))
      .map(([k]) => k)
      .sort();
    expect(notices.length, "the namespace no longer holds a blocking sentence at all").toBeGreaterThan(0);
    const missing = notices.filter((k) => !(k in NOTICE_CAPTION));
    expect(missing, `mailBody notice sentence(s) with no caption twin: ${missing.join(", ")}`).toEqual([]);
  });

  it("every key the table names exists in both catalogues, and so does every caption", () => {
    for (const locale of ["en", "de"] as const) {
      const ns = (locale === "en" ? EN : DE).mailBody!;
      for (const key of Object.keys(NOTICE_CAPTION)) {
        expect(ns[key], `${locale}.json mailBody.${key} — the table names a sentence the catalogue lacks`).toBeTypeOf("string");
      }
      for (const kind of Object.keys(CAPTION_KEY) as NoticeKind[]) {
        const cap = ns[CAPTION_KEY[kind]];
        expect(cap, `${locale}.json mailBody.${CAPTION_KEY[kind]} is missing`).toBeTypeOf("string");
        expect(cap!.trim().length, `${locale} ${kind} caption is empty`).toBeGreaterThan(0);
        expect(isSentence(cap!), `${locale} ${kind} caption "${cap}" is a sentence, not a caption`).toBe(false);
        expect(cap!.split(/\s+/).length, `${locale} ${kind} caption "${cap}" is longer than two words`).toBeLessThanOrEqual(2);
      }
    }
  });

  it("each caption is shorter than every sentence it headlines, in both languages", () => {
    for (const locale of ["en", "de"] as const) {
      const ns = (locale === "en" ? EN : DE).mailBody!;
      for (const [key, kind] of Object.entries(NOTICE_CAPTION)) {
        const cap = ns[CAPTION_KEY[kind]]!;
        expect(cap.length, `${locale}: caption "${cap}" is not shorter than ${key}`).toBeLessThan(ns[key]!.length);
      }
    }
  });

  it("the component's own table reads the same captions (the parity oracle's new members)", () => {
    for (const kind of Object.keys(CAPTION_KEY) as NoticeKind[]) {
      expect(COPY[CAPTION_KEY[kind]]).toBe(EN.mailBody![CAPTION_KEY[kind]]);
    }
  });
});

/* ── 2. the seam ──────────────────────────────────────────────────────────────────────────── */

describe("the seams", () => {
  it("the same viewer mounted bare — no host meta line — still says the sentence in its bar", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    hosts.push(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(h(MessageBody, { owner: null, messageId: "bare", text: "hello", html: PIXEL_ONLY }));
    });
    await settle();
    const bar = host.querySelector(".mb-bar");
    expect(bar, "the reading pane lost its bar").not.toBeNull();
    expect(bar!.getAttribute("role")).toBe("status");
    expect(bar!.classList.contains("mb-bar-quiet")).toBe(false);
    expect(host.querySelector(".mb-bar-text")?.textContent).toBe(COPY.pixelOnly);
    expect(host.querySelector(".mb-bar-icon")).not.toBeNull();
    expect(host.querySelector(".gloss-t"), "a glyph appeared where no host asked for one").toBeNull();
  });
});
