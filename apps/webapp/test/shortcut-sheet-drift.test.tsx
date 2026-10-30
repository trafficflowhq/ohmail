/** @vitest-environment jsdom */
/**
 * THE TWO LISTS OF THE SAME INSTRUCTION SAY THE SAME SENTENCE.
 *
 * The `?` sheet is generated from the keyboard registry and cannot drift from the bindings —
 * that property is `keymap-census.test.tsx`'s, and it is why the sheet lists each destination
 * once, drops the place the rail does not have, and starts every row with a capital.
 *
 * It cannot see the OTHER list. The ⌘K palette reaches the same destinations by name, and while
 * each surface had its own message for them the two drifted one word apart: the palette said
 * "Go to Ohbox" and the sheet said "Go to the Ohbox". Reported as exactly that — the sheet
 * saying one beside the other — because a reader who has both lists open reads them together.
 * Reads and Receipts were byte-identical twins in two namespaces, one edit away from the same
 * fault.
 *
 * So the destination rows read the registry's own namespace, and the palette's copies are gone.
 * Two cases hold it: the RENDERED sentences agree, and no destination message may be defined in
 * both namespaces again, in any catalogue.
 *
 * ── WHY THE CENSUS IS HERE AND NOT IN `copy-census.test.ts` ─────────────────────────────────
 *
 * That file is shared and everybody writes to it. This rule is about one pair of namespaces and
 * belongs beside the rendered case that gives it its meaning; a rule with no driven case beside
 * it is a rule whose point gets edited away.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import en from "../messages/en.json";
import de from "../messages/de.json";

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function setViewport(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

async function mountShell(locale: "en" | "de" = "en"): Promise<void> {
  await unmount();
  const { AppShell } = await import("../app/shell/AppShell.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale, messages: locale === "de" ? de : en, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
        }),
      }),
    );
  });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
};

/** The palette's rows as `{ caps, label }` — the caps are the row's own keycaps, joined. */
function paletteRows(): Array<{ caps: string; label: string }> {
  return [...host!.querySelectorAll<HTMLElement>(".palette [role=option]")].map((li) => {
    const caps = [...(li.querySelector(".keys")?.querySelectorAll("kbd") ?? [])]
      .map((k) => k.textContent ?? "").join("");
    /* The label is the row WITHOUT its keycap span, taken by removing that node from a clone.
       Subtracting the caps STRING from the row's text is what this used to do, and it is wrong
       for a reason a control caught: `String.replace` takes the first occurrence anywhere, so a
       label that happens to contain the chord's letters comes back scrambled. Measured on the
       mutation that deletes the message — next-intl then renders the raw key `shortcuts.goOhbox`
       and the row read `shortcuts.Ohboxgo`. The case went red either way; a test whose failure
       text is garbled is a test somebody has to debug before they can read it. */
    const clone = li.cloneNode(true) as HTMLElement;
    clone.querySelector(".keys")?.remove();
    return { caps, label: (clone.textContent ?? "").trim() };
  });
}

/** The `?` sheet's rows as `{ caps, label }`, one entry per chord spelling. */
function sheetRows(): Array<{ caps: string; label: string }> {
  const out: Array<{ caps: string; label: string }> = [];
  for (const li of host!.querySelectorAll(".ks li")) {
    const label = li.querySelector(".ks-lab")?.textContent ?? "";
    for (const chord of li.querySelectorAll(".ks-chord")) {
      out.push({ caps: [...chord.querySelectorAll("kbd")].map((k) => k.textContent ?? "").join(""), label });
    }
  }
  return out;
}

beforeEach(() => {
  setViewport();
  window.location.hash = "#/ohbox";
});

afterEach(async () => {
  await unmount();
  vi.restoreAllMocks();
});

describe("the palette and the ? sheet name a destination with one sentence", () => {
  it("`g o` reads the same in both lists — and it is the sheet's wording that wins", async () => {
    await mountShell();

    await key("k", { metaKey: true });
    const rows = paletteRows();
    expect(rows.length, "the palette drew no rows").toBeGreaterThan(0);
    const palOhbox = rows.find((r) => r.caps === "go");
    expect(palOhbox, `no palette row wears the chord g o — rows: ${rows.map((r) => r.caps).join("|")}`).toBeTruthy();

    // Out of the palette, into the sheet.
    await key("Escape");
    await key("?");
    const sheet = sheetRows();
    expect(sheet.length, "the ? sheet did not open").toBeGreaterThan(0);
    const sheetOhbox = sheet.find((r) => r.caps === "go");
    expect(sheetOhbox, "no sheet row wears the chord g o").toBeTruthy();

    expect(palOhbox!.label).toBe(sheetOhbox!.label);
    /* Named, so the case says WHICH sentence survived rather than only that they agree — two
       lists agreeing on the wrong words would pass the line above. */
    expect(sheetOhbox!.label).toBe(en.shortcuts.goOhbox);
    expect(sheetOhbox!.label).toBe("Go to the Ohbox");
  });

  it("Reads and Receipts agree too — they were the identical twins beside the reported pair", async () => {
    await mountShell();
    await key("k", { metaKey: true });
    const pal = paletteRows();
    await key("Escape");
    await key("?");
    const sheet = sheetRows();

    for (const [chord, expected] of [["gr", en.shortcuts.goReads], ["ge", en.shortcuts.goReceipts]] as const) {
      const p = pal.find((r) => r.caps === chord);
      const s = sheet.find((r) => r.caps === chord);
      expect(p, `no palette row for ${chord}`).toBeTruthy();
      expect(s, `no sheet row for ${chord}`).toBeTruthy();
      expect(p!.label).toBe(s!.label);
      expect(s!.label).toBe(expected);
    }
  });
});

/** Types into the open palette's field. */
async function query(text: string): Promise<void> {
  const input = host!.querySelector<HTMLInputElement>(".palette input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The rail's places by their shown name. Search is the `/` verb's row, which the palette names as a command. */
function railPlaces(): Array<{ id: string; name: string }> {
  return [...host!.querySelectorAll<HTMLElement>("[data-rail-id]")]
    .filter((b) => b.dataset.railId !== "search")
    .map((b) => {
      const clone = b.cloneNode(true) as HTMLElement;
      clone.querySelector(".cnt")?.remove();
      return { id: b.dataset.railId!, name: (clone.textContent ?? "").trim() };
    });
}

describe("every place the rail and the g-keys reach has a Go to row in the palette", () => {
  for (const [locale, goTo] of [["en", "go to"], ["de", "zu"]] as const) {
    it(`${locale}: each g-key of the ? sheet is a palette row, found by its place's name and by "${goTo} <name>"`, async () => {
      await mountShell(locale);
      const places = railPlaces();
      expect(places.length, "the rail drew no places").toBeGreaterThan(8);
      await key("?");
      const goRows = sheetRows().filter((r) => /^g./.test(r.caps));
      expect(goRows.length, "the sheet lists no g-keys").toBeGreaterThan(8);
      await key("Escape");

      await key("k", { metaKey: true });
      const all = paletteRows();
      const missing = goRows.filter((s) => !all.some((p) => p.caps === s.caps && p.label === s.label));
      expect(missing.map((s) => `${s.caps} ${s.label}`), "g-keys with no palette row").toEqual([]);

      const unfound: string[] = [];
      for (const { id, name } of places) {
        for (const q of [name, `${goTo} ${name}`]) {
          await query(q);
          if (!paletteRows().some((p) => goRows.some((s) => s.caps === p.caps))) unfound.push(`${id}: "${q}"`);
        }
      }
      expect(unfound, "rail places the palette does not find").toEqual([]);
    });
  }
});

describe("the census — a destination has one message, in one namespace", () => {
  it("no `go…` key is defined in both `palette` and `shortcuts`, in any catalogue", () => {
    /* Scoped to the DESTINATIONS (`go…`), which is what the two lists share. `search` is
       deliberately not one of them: the palette names a command ("Search everything") and the
       sheet labels a key ("Search"), which is two different jobs for two surfaces rather than
       one sentence written twice. */
    const offenders: string[] = [];
    for (const [locale, cat] of [["en", en], ["de", de]] as const) {
      const palette = cat.palette as unknown as Record<string, unknown>;
      const shortcuts = cat.shortcuts as unknown as Record<string, unknown>;
      for (const k of Object.keys(palette)) {
        if (!/^go[A-Z]/.test(k)) continue;
        if (k in shortcuts) {
          offenders.push(
            `${locale}: palette.${k} = ${JSON.stringify(palette[k])} beside shortcuts.${k} = ${JSON.stringify(shortcuts[k])}`,
          );
        }
      }
    }
    expect(offenders, `a destination is written twice:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("and the destination messages the registry uses are all still THERE", () => {
    /* The positive control for the rule above: "no duplicates" is also satisfied by deleting
       both copies, which would leave the palette and the sheet rendering nothing. */
    for (const cat of [en, de]) {
      for (const k of ["goOhbox", "goReads", "goReceipts", "goScreener"]) {
        const v = (cat.shortcuts as unknown as Record<string, string>)[k];
        expect(typeof v === "string" && v.trim().length > 0, `shortcuts.${k} is missing`).toBe(true);
      }
    }
  });
});

describe("the sheet scrolls rather than being cut off at a short window", () => {
  it("`.ks` carries a ceiling and its own scroll", () => {
    /* Read off the stylesheet, and that is the honest instrument: jsdom lays nothing out, so a
       rendered-height assertion here would measure zero and pass whatever the rule said. The
       reported fault was a sheet running past the fold of a 720px window with no way to reach
       the rest of it, and `max-height` + `overflow-y: auto` IS the mechanism that answers it. */
    const css = readFileSync("apps/webapp/app/app.css", "utf8");
    const rule = /\n\.ks \{([^}]*)\}/.exec(css);
    expect(rule, "no `.ks` rule in app.css").toBeTruthy();
    const body = rule![1]!;
    expect(body, "the sheet has no ceiling, so a long list runs off the window").toMatch(/max-height:\s*[^;]+;/);
    expect(body, "the sheet cannot be scrolled").toMatch(/overflow-y:\s*auto\s*;/);
  });
});
