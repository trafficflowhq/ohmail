/**
 * The quoted-history corpus (`fixtures/quoted-history/`, synthetic): each `.eml`, its sidecar and the
 * parsed parts storage keeps (`body.txt`, `body.html`; `packages/core/test/quoted-history-parts.test.ts`
 * holds them to the `.eml`). Read by the engine, web and phone tests alike.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const QH_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "quoted-history");

export interface QhExpect {
  fold: "trailing" | "leading" | "none" | "trailing-tail-only" | "trailing-before-signature";
  mustNotFold: boolean;
  onlyHistory: boolean;
  text: {
    visibleFirstLine: string | null;
    visibleLastLine: string | null;
    historyStartLine: string | null;
    historyStartLineNormalized: string | null;
    signatureAfterHistory?: string[];
  } | null;
  html: {
    historyStartSelector: string | null;
    attributionBefore: string | null;
    historyStartText: string | null;
    visibleFirstText: string | null;
    visibleLastText: string | null;
    signatureAfterHistory?: string[];
  } | null;
  inlineAnswers: string[];
  trailingTail: { startLine: string; foldable: boolean } | null;
}

export interface QhFixture {
  id: string;
  name: string;
  expect: QhExpect;
  text: string;
  html: string | null;
}

export function qhFixtures(): QhFixture[] {
  return readdirSync(QH_DIR).filter((f) => f.endsWith(".eml")).sort().map((f) => {
    const base = join(QH_DIR, f.replace(/\.eml$/, ""));
    const side = JSON.parse(readFileSync(`${base}.expected.json`, "utf8")) as { id: string; shape: string; expect: QhExpect };
    return {
      id: side.id,
      name: f.replace(/\.eml$/, ""),
      expect: side.expect,
      text: readFileSync(`${base}.body.txt`, "utf8"),
      html: existsSync(`${base}.body.html`) ? readFileSync(`${base}.body.html`, "utf8") : null,
    };
  });
}

/** Text as the sidecars compare it: no-break spaces as spaces, whitespace collapsed. */
export const qhNorm = (s: string): string => s.replace(/ /g, " ").replace(/\s+/g, " ").trim();

/** Does the expectation fold at all? */
export const qhFolds = (e: QhExpect): boolean => e.fold !== "none" && !e.onlyHistory;
