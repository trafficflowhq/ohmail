/**
 * THE TWO PHONE APPS' TABLE. ohmail keeps today's names; each row's sibling names it back; no two apps could collide
 * on a phone (one identifier, one scheme, one link, one provider each); a preview pair stands apart from the released
 * one; and an identifier the table does not know is a fault, never a guess.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mailSurfaceOf } from "../src/shell/mail-surface";
import {
  appOfNative, assertEmbeddedApp, siblingOf, standaloneOf, VARIANTS, variantOfAppId, type VariantId,
} from "../src/variant";

const app = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8")) as {
  expo: { name: string; scheme: string; ios: { bundleIdentifier: string }; android: { package: string } };
};
const rows = Object.entries(VARIANTS) as [VariantId, (typeof VARIANTS)[VariantId]][];

describe("the variant table", () => {
  it("names ohmail exactly as the released app is named today", () => {
    const ohmail = VARIANTS.ohmail;
    expect(ohmail.id).toBe(app.expo.android.package);
    expect(ohmail.id).toBe(app.expo.ios.bundleIdentifier);
    expect(ohmail.name).toBe(app.expo.name);
    expect(ohmail.scheme).toBe(app.expo.scheme);
    expect(ohmail.carries).toEqual({ screens: true, organizes: true, mailPush: true });
    expect(ohmail.without).toEqual({ plugins: [], modules: [] });
  });

  it("pairs every app with a sibling of the other product and the same channel, which names it back", () => {
    for (const [id, row] of rows) {
      const sibling = siblingOf(row);
      expect(sibling.sibling, id).toBe(id);
      expect(sibling.app, id).not.toBe(row.app);
      expect(sibling.channel, id).toBe(row.channel);
      // One guard per pair: both apps declare the same signature permission.
      expect(sibling.permission, id).toBe(row.permission);
    }
  });

  it("gives no two apps one identifier, scheme, link or provider", () => {
    for (const key of ["id", "scheme", "authority"] as const) {
      expect(new Set(rows.map(([, r]) => r[key])).size, key).toBe(rows.length);
    }
    expect(new Set(rows.map(([, r]) => `${r.links.host}${r.links.path}`)).size).toBe(rows.length);
  });

  it("keeps the preview pair apart from the released one", () => {
    const release = new Set(rows.filter(([, r]) => r.channel === "release").map(([, r]) => r.permission));
    for (const [id, row] of rows.filter(([, r]) => r.channel === "preview")) {
      expect(release.has(row.permission), id).toBe(false);
      expect(siblingOf(row).channel, id).toBe("preview");
    }
  });

  it("finds a row by the identifier the system reports, and refuses one it does not know", () => {
    expect(variantOfAppId("app.ohcal")).toBe(VARIANTS.ohcal);
    expect(variantOfAppId("app.ohmail.preview")).toBe(VARIANTS["ohmail-preview"]);
    for (const id of ["", "app.ohmail.", "app.Ohmail", "com.example.ohmail"]) {
      expect(() => variantOfAppId(id), id).toThrow(/variants\.json/);
    }
  });

  it("lets only the mail app organize a mailbox alone; the calendar app needs a server or a paired computer", () => {
    expect(standaloneOf(VARIANTS.ohmail)).toBe(true);
    expect(standaloneOf(VARIANTS.ohcal)).toBe(false);
    expect(VARIANTS.ohcal.carries).toEqual({ screens: false, organizes: false, mailPush: false });
  });

  it("cannot be changed at run time", () => {
    expect(Object.isFrozen(VARIANTS)).toBe(true);
    expect(Object.isFrozen(VARIANTS.ohcal.without.plugins)).toBe(true);
    expect(() => {
      (VARIANTS.ohmail as { id: string }).id = "app.other";
    }).toThrow();
  });

  it("knows the app by the identifier the system reports, and no app in a build without the switch module", () => {
    expect(appOfNative("app.ohcal")).toBe(VARIANTS.ohcal);
    expect(() => appOfNative(null)).toThrow(/no switch module/);
    expect(() => appOfNative("app.ohcal.widgets")).toThrow(/variants\.json/);
  });

  it("stops an app whose embedded configuration names another app than the one installed", () => {
    expect(() => assertEmbeddedApp(VARIANTS.ohcal, "app.ohcal")).not.toThrow();
    expect(() => assertEmbeddedApp(VARIANTS.ohcal, undefined)).not.toThrow();
    expect(() => assertEmbeddedApp(VARIANTS.ohcal, "app.ohmail")).toThrow(/configured as "app\.ohmail" and installed as "app\.ohcal"/);
    expect(() => assertEmbeddedApp(VARIANTS.ohmail, "app.ohcal")).toThrow(/make it again/);
  });
});

describe("the surface each app shows mail in", () => {
  it("is the screens in ohmail until the build asks for the shell, and the shell in ohcal whatever it asks", () => {
    expect(mailSurfaceOf(undefined, VARIANTS.ohmail)).toBe("screens");
    expect(mailSurfaceOf("", VARIANTS.ohmail)).toBe("screens");
    expect(mailSurfaceOf("shell", VARIANTS.ohmail)).toBe("shell");
    expect(mailSurfaceOf(undefined, VARIANTS.ohcal)).toBe("shell");
    expect(mailSurfaceOf("shell", VARIANTS["ohcal-preview"])).toBe("shell");
  });

  it("refuses the screens for an app that carries none, and any other word, as a build error", () => {
    expect(() => mailSurfaceOf("screens", VARIANTS.ohcal)).toThrow(/ohcal carries no screens/);
    expect(() => mailSurfaceOf("web", VARIANTS.ohmail)).toThrow(/EXPO_PUBLIC_OHMAIL_MAIL_SURFACE is "web"/);
    expect(() => mailSurfaceOf("web", VARIANTS.ohcal)).toThrow(/EXPO_PUBLIC_OHMAIL_MAIL_SURFACE is "web"/);
  });
});
