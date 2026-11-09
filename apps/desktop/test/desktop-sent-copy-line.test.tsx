import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";

import en from "../../webapp/messages/en.json";
import de from "../../webapp/messages/de.json";
import { SendingLine } from "../../webapp/app/shell/SendingLine";
import { fillFrom } from "../../webapp/app/shell/locale";
import type { SendLineItem, SentCopyNote } from "../../webapp/app/shell/mail-send";
import { shellMessagesOnly } from "../vite.config.js";

/**
 * THE SIDEBAR'S SENT-COPY LINE, IN THE CATALOGUE THE DESKTOP BUNDLE SHIPS. The build keeps only the
 * namespaces `shellMessagesOnly()` names; a sent letter whose Sent copy the server refused rendered
 * `sentCopy.missingFull` in the desktop's sidebar while the web, on the whole catalogue, said why.
 * Every note kind, in English and German, must read as the web reads it.
 */

const h = React.createElement;

const MESSAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../webapp/messages");
type Catalog = Record<string, unknown>;

/** A catalogue as the desktop build loads it: through the build's own filter. */
function bundled(file: string): Catalog {
  const plugin = shellMessagesOnly();
  const load = plugin.load as unknown as (this: unknown, id: string) => string | null;
  const out = load.call({ error: (m: string) => { throw new Error(m); } }, path.join(MESSAGES, file));
  if (out === null) throw new Error(`the filter did not take ${file}`);
  return JSON.parse(out) as Catalog;
}

const DESKTOP: Record<"en" | "de", Catalog> = (() => {
  const base = bundled("en.json");
  return { en: base, de: fillFrom(base, bundled("de.json")) };
})();
const WEB: Record<"en" | "de", Catalog> = { en: en as Catalog, de: fillFrom(en as Catalog, de as Catalog) };

const UNTIL = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
const REASONS = ["too_big", "full", "refused", "unreachable"] as const;
const NOTES: SentCopyNote[] = [
  { state: "missing" },
  ...REASONS.map((reason) => ({ state: "missing" as const, reason })),
  ...REASONS.map((reason) => ({ state: "pending" as const, reason })),
  { state: "pending", until: UNTIL },
  ...REASONS.map((reason) => ({ state: "pending" as const, reason, until: UNTIL })),
];

/** The sidebar line's sentence for one sent letter with this note, under this catalogue. */
function lineSays(locale: "en" | "de", messages: Catalog, copy: SentCopyNote): string {
  const item: SendLineItem = { id: "d1", key: "reply:t1", state: "sent", to: "Dora Example", subject: "Clay", copy };
  const api = {
    line: () => [item], subscribeLine: () => () => {}, lineVersion: () => 1, mountLine: () => () => {}, dismissLine: () => {},
  };
  const html = renderToStaticMarkup(h(NextIntlClientProvider, { locale, messages, timeZone: "UTC", onError: () => {} } as never,
    h(SendingLine, { api, variant: "rail", onOpen: () => false, onOpenMany: () => {} })));
  return /<span class="sl-say">([^<]*)<\/span>/.exec(html)?.[1] ?? "";
}

describe("the desktop sidebar's Sent-copy line", () => {
  for (const locale of ["en", "de"] as const) {
    it(`says every note's sentence in ${locale}, as the web does`, () => {
      for (const note of NOTES) {
        const label = `${note.state}/${note.reason ?? "-"}${note.until ? "/until" : ""}`;
        const desktop = lineSays(locale, DESKTOP[locale], note);
        expect(desktop, label).not.toBe("");
        expect(desktop, label).not.toMatch(/sentCopy\./);
        expect(desktop, label).toBe(lineSays(locale, WEB[locale], note));
        if (locale === "de") expect(desktop, label).not.toBe(lineSays("en", DESKTOP.en, note));
      }
    });
  }
});
