import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeMime } from "../src/mime.js";
import { prepareHtmlForStorage } from "../src/html-storage.js";

/**
 * THE QUOTED-HISTORY CORPUS CANNOT DRIFT FROM ITS MAIL. The readers' tests read each fixture's
 * committed parts (`body.txt`, `body.html`); this recomputes both from the `.eml` exactly as ingest
 * does (`normalizeMime`, then `prepareHtmlForStorage`) and requires the same bytes.
 */
const DIR = join(dirname(fileURLToPath(import.meta.url)), "../../client-engine/test/fixtures/quoted-history");
const EML = readdirSync(DIR).filter((f) => f.endsWith(".eml")).sort();

describe("packages/client-engine/test/fixtures/quoted-history: the committed parts are the parsed .eml", () => {
  it("has the corpus", () => {
    expect(EML.length).toBeGreaterThanOrEqual(75);
  });
  for (const f of EML) {
    it(f, async () => {
      const base = join(DIR, f.replace(/\.eml$/, ""));
      const m = await normalizeMime(readFileSync(join(DIR, f)));
      expect(m.textBody).toBe(readFileSync(`${base}.body.txt`, "utf8"));
      const html = prepareHtmlForStorage(m.htmlBody ?? null);
      expect(html === null ? null : html).toBe(existsSync(`${base}.body.html`) ? readFileSync(`${base}.body.html`, "utf8") : null);
    });
  }
});
