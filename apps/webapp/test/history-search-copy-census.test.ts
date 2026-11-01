import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * HISTORY AND SEARCH NEVER NAME A DEVICE, AN ARCHIVE OR A WINDOW (ARCHIVE-024) — in both web
 * catalogues and both phone decks. Every message the account owns is reachable from the store, so
 * the only sentence that may mention the device is the failure one, and the census names the keys
 * it admits. Scope: the two surfaces' own copy (whole files also name the OS "Windows" and the
 * pairing "this device", which are not claims about History or Search).
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const BANNED = /archiv|archive|this device|dieses Gerät|this computer|diesem Computer|window|Fenster/i;

/** The failure sentences — the only places a device may be named. The mirror's three and the address
    view's offline line are a paired desktop's while ohmail Cloud is unreachable. */
const ADMITTED_WEB = new Set([
  "history.storeUnavailable", "search.scopeUnanswered", "search.scopeFailed",
  "search.scopeMirror", "search.scopeMirrorAtLeast", "search.scopeMirrorAbout", "search.addressOffline",
  "search.scopeMirrorNear", "search.scopeMirrorNearAtLeast",
]);
const ADMITTED_PHONE = new Set(["historyStoreUnavailable", "searchUnanswered", "searchFailed"]);

function webScope(file: string): Map<string, string> {
  const j = JSON.parse(read(file)) as Record<string, Record<string, unknown>>;
  const out = new Map<string, string>();
  for (const ns of ["history", "search"]) {
    for (const [k, v] of Object.entries(j[ns]!)) if (typeof v === "string") out.set(`${ns}.${k}`, v);
  }
  for (const k of ["history", "historySubtitle"]) out.set(`rail.${k}`, String(j.rail![k]));
  out.set("ohbox.tail", String(j.ohbox!.tail));
  return out;
}

/** The phone deck's `history*` / `search*` entries, each read to the start of the next key. */
function phoneScope(file: string): Map<string, string> {
  const src = read(file);
  const out = new Map<string, string>();
  const key = /^ {2}((?:history|search)[A-Za-z]*):/gm;
  const any = /^ {2}[A-Za-z]+:|^ {2}\/\*|^ {2}\/\//gm;
  let m: RegExpExecArray | null;
  while ((m = key.exec(src)) !== null) {
    any.lastIndex = m.index + m[0].length;
    const next = any.exec(src);
    out.set(m[1]!, src.slice(m.index + m[0].length, next ? next.index : undefined));
  }
  return out;
}

describe("History and Search say 'your whole mailbox', never a device, an archive or a window", () => {
  for (const file of ["../messages/en.json", "../messages/de.json"]) {
    it(`${file.slice(12)}: only the failure sentence names the device`, () => {
      const scope = webScope(file);
      expect(scope.size, "the census reads the surfaces' copy").toBeGreaterThan(40);
      expect(scope.get("search.scopeWholeAbout"), "the estimate's count line is read").toMatch(/\{total, number\}/);
      const hits = [...scope].filter(([k, v]) => BANNED.test(v) && !ADMITTED_WEB.has(k)).map(([k]) => k);
      expect(hits).toEqual([]);
      // The admitted keys exist, say the device, and say it in the one failure sentence.
      for (const k of ADMITTED_WEB) expect(BANNED.test(scope.get(k) ?? ""), `${k} is the failure sentence`).toBe(true);
      expect(scope.get("history.storeUnavailable")).toBe(scope.get("search.scopeUnanswered"));
    });
  }

  for (const file of ["../../mobile/src/copy.en.ts", "../../mobile/src/copy.de.ts"]) {
    it(`${file.slice(17)}: only the failure sentence names the device`, () => {
      const scope = phoneScope(file);
      expect(scope.size, "the census reads the surfaces' copy").toBeGreaterThan(20);
      expect(scope.get("searchWholeAbout"), "the estimate's count line is read").toMatch(/\$\{n\}/);
      const hits = [...scope].filter(([k, v]) => BANNED.test(v) && !ADMITTED_PHONE.has(k)).map(([k]) => k);
      expect(hits).toEqual([]);
      for (const k of ADMITTED_PHONE) expect(BANNED.test(scope.get(k) ?? ""), `${k} is the failure sentence`).toBe(true);
    });
  }

  it("the deleted apology keys stay deleted", () => {
    for (const file of ["../messages/en.json", "../messages/de.json"]) {
      const j = JSON.parse(read(file)) as Record<string, Record<string, unknown>>;
      for (const [ns, k] of [["history", "windowNote"], ["ohbox", "olderPrompt"], ["rail", "historyTitle"],
        ["search", "scopeDevice"], ["search", "emptyTitleAll"], ["search", "hitArchiveOnly"]] as const) {
        expect(j[ns]![k], `${file} ${ns}.${k}`).toBeUndefined();
      }
    }
    for (const file of ["../../mobile/src/copy.en.ts", "../../mobile/src/copy.de.ts"]) {
      expect(read(file)).not.toMatch(/^ {2}searchScopeDevice:/m);
    }
  });
});
