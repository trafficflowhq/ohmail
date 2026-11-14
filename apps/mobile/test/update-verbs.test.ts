import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EN } from "../src/copy.en";
import { DE } from "../src/copy.de";
import { MANAGED_ORIGIN } from "../src/net/pairing";
import {
  APP_STORE_ID, APP_STORE_ID_SHAPE, DOWNLOAD_PAGE, PLAY_PACKAGE, storeUrlOf, updateVerbs, webAddressOf,
} from "../src/net/update-verbs";

/**
 * WHAT THE "TOO OLD" CARD OFFERS: the way to the update for THIS build, and the way into the web. A verb with
 * nowhere to go is withheld, never drawn dead; the card never offers a store to a build from the release
 * page, nor the release page to a store build.
 */
const ORIGIN = "https://mail.example.test";
/** A server the person runs, as the profile holds it: its pages are at the origin the phone paired with. */
const OWN = { origin: ORIGIN, flavor: "selfhost" };
/** A Cloud pairing, as the Cloud door stores it: the API host, which serves no page. */
const CLOUD = { origin: MANAGED_ORIGIN, flavor: "managed" };
const WEB_APP = "https://ohmail.app";
const copyDeck = (locale: "en" | "de") => (locale === "en" ? EN : DE);
const ids = (v: ReturnType<typeof updateVerbs>): string[] => v.map((x) => x.id);

describe("the verbs", () => {
  it("a store build on Android: Play, then the browser", () => {
    const v = updateVerbs({ os: "android", distribution: "store", server: OWN });
    expect(ids(v)).toEqual(["store", "browser"]);
    expect(v[0]!.url).toBe(`https://play.google.com/store/apps/details?id=${PLAY_PACKAGE}`);
    expect(v[1]!.url).toBe(ORIGIN);
  });

  it("a build from the release page: the download page, then the browser, and never a store", () => {
    for (const os of ["android", "ios"]) {
      const v = updateVerbs({ os, distribution: "sideload", server: OWN });
      expect(ids(v), os).toEqual(["download", "browser"]);
      expect(v[0]!.url).toBe(DOWNLOAD_PAGE);
    }
  });

  it("the App Store verb is WITHHELD while the listing's id is unknown, and drawn once it is a real one", () => {
    expect(APP_STORE_ID === "" || APP_STORE_ID_SHAPE.test(APP_STORE_ID), "a held id that is not a numeric App Store id").toBe(true);
    expect(ids(updateVerbs({ os: "ios", distribution: "store", server: OWN, appStoreId: "" }))).toEqual(["browser"]);
    expect(ids(updateVerbs({ os: "ios", distribution: "store", server: OWN, appStoreId: "not-a-number" }))).toEqual(["browser"]);
    const v = updateVerbs({ os: "ios", distribution: "store", server: OWN, appStoreId: "1234567890" });
    expect(ids(v)).toEqual(["store", "browser"]);
    expect(v[0]!.url).toBe("https://apps.apple.com/app/id1234567890");
    expect(storeUrlOf("ios", "")).toBeNull();
    expect(storeUrlOf("web")).toBeNull();
    // The published listing: the build's own id is a real one, and the verb leads to it.
    expect(APP_STORE_ID_SHAPE.test(APP_STORE_ID), "the published listing's id").toBe(true);
    expect(storeUrlOf("ios")).toBe(`https://apps.apple.com/app/id${APP_STORE_ID}`);
    expect(ids(updateVerbs({ os: "ios", distribution: "store", server: OWN }))).toEqual(["store", "browser"]);
  });

  it("no browser verb where the phone knows no server address, or one that is not a web address", () => {
    expect(ids(updateVerbs({ os: "android", distribution: "store", server: null }))).toEqual(["store"]);
    for (const origin of ["", "javascript:alert(1)", "ftp://x.example", "mail.example.test"]) {
      expect(ids(updateVerbs({ os: "android", distribution: "store", server: { origin, flavor: "selfhost" } })), origin).toEqual(["store"]);
    }
    expect(updateVerbs({ os: "ios", distribution: "store", server: null, appStoreId: "" })).toEqual([]);
    expect(ids(updateVerbs({ os: "ios", distribution: "store", server: null }))).toEqual(["store"]);
  });

  it("a Cloud pairing opens the web app, never the API host it paired with", () => {
    expect(MANAGED_ORIGIN, "the Cloud door stores the API host").toBe("https://api.ohmail.app");
    // The App Store build paired with Cloud: the browser is its one verb, so it must lead somewhere.
    expect(updateVerbs({ os: "ios", distribution: "store", server: CLOUD, appStoreId: "" })).toEqual([{ id: "browser", url: WEB_APP }]);
    const android = updateVerbs({ os: "android", distribution: "store", server: CLOUD });
    expect(ids(android)).toEqual(["store", "browser"]);
    expect(android[1]!.url).toBe(WEB_APP);
    for (const os of ["android", "ios"]) {
      for (const distribution of ["store", "sideload"] as const) {
        const urls = updateVerbs({ os, distribution, server: CLOUD, appStoreId: "1234567890" }).map((x) => x.url);
        expect(urls.filter((u) => u.startsWith(MANAGED_ORIGIN)), `${os} ${distribution}`).toEqual([]);
      }
    }
  });

  it("the browser's address by the kind of server: its own origin where it serves its pages, none where no page is known", () => {
    expect(webAddressOf(CLOUD)).toBe(WEB_APP);
    expect(webAddressOf({ origin: `${MANAGED_ORIGIN}/`, flavor: "managed" }), "a trailing slash is the same host").toBe(WEB_APP);
    expect(webAddressOf(OWN)).toBe(ORIGIN);
    expect(webAddressOf({ origin: "https://192.168.1.20:8443", flavor: "desktop-host" })).toBe("https://192.168.1.20:8443");
    // A hosted API at another address has no page this app can name; nor has a flavor it does not know.
    expect(webAddressOf({ origin: "https://api.staging.example.test", flavor: "managed" })).toBeNull();
    expect(webAddressOf({ origin: "http://127.0.0.1:4317", flavor: "local" })).toBeNull();
    expect(webAddressOf({ origin: ORIGIN, flavor: "something-newer" })).toBeNull();
    expect(ids(updateVerbs({ os: "android", distribution: "store", server: { origin: "https://api.staging.example.test", flavor: "managed" } })))
      .toEqual(["store"]);
  });

  it("the Play package is the one app.json builds", () => {
    const app = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8")) as { expo: { android: { package: string } } };
    expect(PLAY_PACKAGE).toBe(app.expo.android.package);
  });
});

describe("the sentences", () => {
  it("are the browser's own, in both languages, from the same catalogue keys", () => {
    const catalogue = (locale: "en" | "de") => (JSON.parse(readFileSync(new URL(`../../webapp/messages/${locale}.json`, import.meta.url), "utf8")) as {
      update: Record<string, string>;
    }).update;
    for (const locale of ["en", "de"] as const) {
      const deck = copyDeck(locale);
      expect(deck.updateTooOld, locale).toBe(catalogue(locale).lineTooOld);
      expect(deck.updateServerUpdating, locale).toBe(catalogue(locale).lineServerUpdating);
    }
  });

  it("the verbs read as the ruling says, in both languages", () => {
    expect([copyDeck("en").updateOpenStore, copyDeck("en").updateOpenDownload, copyDeck("en").updateOpenBrowser])
      .toEqual(["Open the store", "Open the download page", "Open in the browser"]);
    expect([copyDeck("de").updateOpenStore, copyDeck("de").updateOpenDownload, copyDeck("de").updateOpenBrowser])
      .toEqual(["Store öffnen", "Download-Seite öffnen", "Im Browser öffnen"]);
  });
});
