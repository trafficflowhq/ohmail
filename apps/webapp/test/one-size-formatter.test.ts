import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ═══ ONE FORMATTER FOR A FILE'S SIZE ═══════════════════════════════════════════════════════
 *
 * There were three private ones: `AttachmentPreview` and `AttachmentStrip` were 1000-based and
 * each carried a comment claiming to agree with the other; `ComposeAttach` was 1024-based, so the
 * composer and the reading pane named different sizes for the same file and the attachment cap
 * stated a number the strip beside it would not have agreed with. None of the three knew the
 * reader's language — a decimal point in a German pane is a thousands separator.
 *
 * Both halves are asserted: nobody builds a new one, and the shared one is actually reached.
 */

const APP = resolve(join(import.meta.dirname, "..", "app"));

/**
 * The one module that may name a unit of its own, and why. `formatStorageBytes` is the plan
 * card's convention — whole megabytes against a 2/5/10 GB plan, so a fresh account reads "12 MB
 * of 2 GB" — a different rounding for a different subject, already locale-aware and already
 * documented. It is named here rather than exempted by a pattern, so a second one cannot arrive
 * by looking like it.
 */
const OWN_CONVENTION = ["shell/storage-state.ts"];

/** The three surfaces that name a file's size, and there are exactly three. */
const CALLERS = [
  "components/AttachmentPreview.tsx",
  "components/AttachmentStrip.tsx",
  "components/ComposeAttach.tsx",
  // A forward's original files and the sentence under them.
  "shell/ForwardFiles.tsx",
  "shell/SendStatus.tsx",
  "views/ComposeView.tsx",
];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (e.endsWith(".ts") || e.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const ALL = files(APP).map((f) => ({ rel: f.slice(APP.length + 1), text: readFileSync(f, "utf8") }));

describe("a file's size is formatted in one place", () => {
  it("nobody under app/ builds a unit ladder of their own", () => {
    // The needle is the UNIT STRING a ladder has to produce. A formatter that divides but never
    // names a unit cannot put a size on screen.
    const offenders = ALL
      .filter((f) => /["`]\s*KB\b|["`]\s*MB\b|["`]\s*GB\b|\bKB`|\bMB`|\bGB`/.test(f.text))
      .map((f) => f.rel)
      .filter((rel) => !OWN_CONVENTION.includes(rel))
      .sort();
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("and the module with its own convention still has it, so the rule above is not vacuous", () => {
    // The positive control: if the needle stopped matching anything at all, the assertion above
    // would pass for a webapp full of private formatters.
    for (const rel of OWN_CONVENTION) {
      const f = ALL.find((x) => x.rel === rel);
      expect(f, rel).toBeTruthy();
      expect(/["`]\s*MB\b|\bMB`/.test(f!.text), `${rel} must still name a unit`).toBe(true);
    }
  });

  it("every surface that names a file's size reaches the shared formatter", () => {
    const importers = ALL
      .filter((f) => /\bformatFileSize\b/.test(f.text))
      .map((f) => f.rel)
      .sort();
    expect(importers).toEqual([...CALLERS].sort());
    for (const rel of CALLERS) {
      const f = ALL.find((x) => x.rel === rel)!;
      // From the shared package, never re-declared locally.
      expect(/import \{[^}]*\bformatFileSize\b[^}]*\} from "@ohmail\/ui"/.test(f.text), rel).toBe(true);
      expect(/function formatFileSize\b/.test(f.text), `${rel} must not redefine it`).toBe(false);
    }
  });
});
