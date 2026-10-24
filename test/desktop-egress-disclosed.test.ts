import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, publicRel } from "./support/public-root.mjs";

/**
 * WHAT THE DESKTOP CONTACTS, AS EACH PUBLISHED ACCOUNT OF IT SAYS. The local-mode list in
 * docs/how-it-works.md spells it out; the Flathub listing, the Linux package description, the Flathub
 * reviewers' notes and SECURITY.md say it again to readers who never open it. Each names what leaves beside the
 * mail server: the pictures in a message the person opens, the one-click unsubscribe a screen-out
 * sends, the DNS lookup of the key a sender's domain signs with (set off by whoever wrote, at
 * ingest), and the model provider when one is on. A new kind of egress is added to all of them.
 */

const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const flat = (s: string): string => s.replace(/\s+/g, " ");

/** The blank-line paragraph holding `marker`. */
function paragraph(text: string, marker: string): string {
  const found = text.split(/\n[ \t]*\n/).find((p) => p.includes(marker));
  if (found === undefined) throw new Error(`no paragraph holds ${JSON.stringify(marker)}`);
  return flat(found);
}

/** The list item holding `marker`, up to the next item. */
function bullet(text: string, marker: string): string {
  const at = text.indexOf(marker);
  if (at < 0) throw new Error(`no item holds ${JSON.stringify(marker)}`);
  const end = text.indexOf("\n- ", at);
  return flat(text.slice(at, end < 0 ? undefined : end));
}

const ACCOUNTS: [string, () => string][] = [
  ["docs/how-it-works.md, local mode", () => paragraph(read(publicRel("docs/how-it-works.md")), "**Local mode**")],
  ["SECURITY.md, local mode", () => bullet(read(publicRel("SECURITY.md")), "In **local mode**")],
  ["the Flathub listing", () => {
    const xml = read("apps/desktop/flatpak/app.ohmail.Desktop.metainfo.xml");
    return flat(xml.slice(xml.indexOf("<description>"), xml.indexOf("</description>")));
  }],
  ["the Linux package description", () =>
    (JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json")) as { bundle: { longDescription: string } }).bundle.longDescription],
  ["the Flathub reviewers' notes on the network", () =>
    paragraph(read("apps/desktop/flatpak/REVIEW-NOTES.md"), "**Why `--share=network`.**")],
];

const NAMED: [string, RegExp][] = [
  ["the pictures in a message the person opens", /picture/i],
  ["the one-click unsubscribe a screen-out sends", /unsubscribe/i],
  ["the DNS lookup of the key a sender's domain signs with", /\bDNS\b[^.]*\bkey\b/i],
  ["the model provider, when one is on", /model provider|Anthropic|Ollama/i],
];

describe("every published account of what the desktop contacts names each kind of egress", () => {
  for (const [where, text] of ACCOUNTS) {
    it(where, () => {
      const said = text();
      for (const [what, pattern] of NAMED) expect(said, `${where} leaves out ${what}`).toMatch(pattern);
    });
  }

  it("the pricing page's line on what leaves on its own names the key lookup, in both languages", () => {
    for (const lang of ["en", "de"]) {
      const messages = JSON.parse(read(`apps/webapp/messages/${lang}.json`)) as { pricing: { desktopStatusNote: string } };
      expect(messages.pricing.desktopStatusNote, lang).toMatch(/\bDNS\b/);
    }
  });
});
