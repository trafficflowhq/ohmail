/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_LOCALE, LOCALE_COOKIE, LOCALE_STORAGE_KEY, localeFromCookieHeader, readStoredLocale,
  rememberLocale, setActiveCatalog,
} from "../app/shell/locale";

/**
 * THE ACCOUNT-TIED HALF, and the three states a device can be in.
 *
 * The preference lives in two places on purpose and the rule between them is the whole feature:
 *
 *   account says 'de'  + device says 'en'  ⇒ German. The account WINS.
 *   account says null  + device says 'de'  ⇒ German. Nothing overrides a device that has chosen.
 *   account says null  + device says null  ⇒ English.
 *
 * The second row is why `account_settings.locale` is nullable and why nothing backfills it: if the
 * migration had written `'en'` for every existing account, row two would become "English" and every
 * German-set browser would be reset on its next boot, by a setting nobody touched.
 *
 * The cookie is the third medium and exists for one thing `localStorage` cannot do: the `(product)`
 * layout renders on the SERVER, so the first paint of every navigation would be English and then flip
 * without it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* jsdom gives `document.cookie` and `localStorage`; both are per-test state and are cleared. */
beforeEach(() => {
  window.localStorage.clear();
  document.cookie = `${LOCALE_COOKIE}=; Path=/; Max-Age=0`;
});
afterEach(() => {
  setActiveCatalog(DEFAULT_LOCALE, null);
  vi.restoreAllMocks();
});

describe("where the local preference is kept", () => {
  it("rememberLocale writes BOTH the storage and the cookie — one without the other flips on reload", () => {
    rememberLocale("de");
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("de");
    expect(localeFromCookieHeader(document.cookie)).toBe("de");
    expect(readStoredLocale()).toBe("de");
  });

  it("the cookie is host-only and path-wide — it carries no Domain, like the session cookie", () => {
    rememberLocale("de");
    // `document.cookie` cannot report attributes, so the WRITE is inspected instead. The narrowness
    // is a standing invariant of this origin (see `packages/api/src/cookies.ts`), and a display
    // preference is never a reason to widen it.
    const src = fs.readFileSync(path.join(HERE, "..", "app", "shell", "locale.ts"), "utf8");
    const write = /document\.cookie\s*=\s*[\s\S]*?;\n/.exec(src)?.[0] ?? "";
    expect(write).toContain("Path=/");
    expect(write).not.toContain("Domain=");
    expect(write).toContain("SameSite=Lax");
  });

  it("reading a cookie header picks this cookie out of a crowd, and ignores a lookalike", () => {
    expect(localeFromCookieHeader("tf_session=abc; ohmail.locale=de; other=1")).toBe("de");
    expect(localeFromCookieHeader("ohmail.locale.other=de")).toBeNull();
    expect(localeFromCookieHeader("ohmail.locale=fr")).toBeNull();
    expect(localeFromCookieHeader("")).toBeNull();
    expect(localeFromCookieHeader(null)).toBeNull();
  });

  it("a blocked localStorage is not an error — the live locale still applies", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(() => rememberLocale("de")).not.toThrow();
    // The cookie still got written, so the next server render is still German.
    expect(localeFromCookieHeader(document.cookie)).toBe("de");
  });
});

// THE SELECTOR (today's `LanguageRow`, Settings › General) moved word for word to `locale-account-row.test.tsx`: it
// waits for the General pane's mount.

describe("the account preference wins over the device's", () => {
  // Its three cases over a copy of today's rule ("account de + device en ⇒ adopt de", "account null + device de ⇒
  // adopt NOTHING…", "account de + device de ⇒ adopt nothing…") are held by the ground's own boot
  // (`packages/app/test/mail/boot-locale.test.tsx`), over the real hook and the host's controls.

  it("the effect in AppShell adopts rather than sets — a boot must not PATCH the account", () => {
    // Read from the source, because the distinction is invisible at runtime on a passing test and
    // catastrophic in production: `setLocale` on the Cloud client writes the account, so adopting a
    // value that CAME from the account would re-PATCH it on every boot of every tab.
    /* The adoption moved with the boot duties to the mail ground (`packages/app/src/mail/ground/boot-locale.ts`). */
    const shell = fs.readFileSync(path.join(HERE, "..", "..", "..", "packages", "app", "src", "mail", "ground", "boot-locale.ts"), "utf8");
    const effect = /const localeControls = useFrame\(\)\.host\.device\.language;[\s\S]*?\}, \[adoptLocale, accountLocale, activeLocale\]\);/
      .exec(shell)?.[0];
    expect(effect, "the boot adoption effect is no longer where this guard reads it").toBeDefined();
    expect(effect!).toContain("adoptLocale");
    expect(effect!).not.toContain("setLocale");
  });
});
