/** @vitest-environment jsdom */
/**
 * WHAT THE WINDOW CAN ADDRESS NOW THAT ITS CSP ADMITS TAURI'S COMMAND SCHEME. The real guard, on each
 * platform's spelling, hands exactly that one address to the page's own `fetch` and throws for every
 * other: the other platform's spelling, loopback, a look-alike host, a socket, a beacon, a target
 * that is not a string. And a mail cannot name the scheme: the sanitiser blanks every `ipc:` use and
 * every fetching use of `http://ipc.localhost`; the one link left is ignored by the shell's popup
 * table (`engine_tests.rs` `popup_rows`). Watched red: the guard handing on both spellings.
 */
import { describe, expect, it } from "vitest";
import { installOfflineGuard, isOwnCommandChannel } from "../src/offline-guard.js";

const REFUSED = /offline by construction/;

/** A scope whose leaving APIs all work, recording what reaches them. */
function liveScope() {
  const reached: string[] = [];
  class Opened {
    constructor(url: string) {
      reached.push(`open ${url}`);
    }
  }
  const scope: Record<string, unknown> = {
    fetch: (target: unknown) => {
      reached.push(`fetch ${String(target)}`);
      return Promise.resolve("answered");
    },
    XMLHttpRequest: Opened,
    WebSocket: Opened,
    EventSource: Opened,
    navigator: {
      sendBeacon: (url: string) => {
        reached.push(`beacon ${url}`);
        return true;
      },
    },
  };
  return { scope, reached };
}

const PLATFORMS = [
  { platform: "linux", own: "ipc://localhost/", foreign: "http://ipc.localhost/" },
  { platform: "darwin", own: "ipc://localhost/", foreign: "http://ipc.localhost/" },
  { platform: "win32", own: "http://ipc.localhost/", foreign: "ipc://localhost/" },
] as const;

describe("the guard hands on this build's command channel and nothing else", () => {
  for (const { platform, own, foreign } of PLATFORMS) {
    it(`${platform}: only ${own}<command> reaches the page's own fetch`, async () => {
      const { scope, reached } = liveScope();
      installOfflineGuard(scope, platform);
      const fetch = scope.fetch as (target: unknown, init?: unknown) => unknown;

      await expect(fetch(`${own}engine_request`, { method: "POST", body: "{}" })).resolves.toBe("answered");
      expect(reached).toEqual([`fetch ${own}engine_request`]);

      const refused: unknown[] = [
        `${foreign}engine_request`,
        "http://127.0.0.1/",
        "http://localhost/",
        "https://ohmail.app/",
        "https://ipc.localhost.example.invalid/",
        "ipc://elsewhere.invalid/engine_request",
        `http://ipc.localhost:80/engine_request`,
        ` ${own}engine_request`,
        `${own.toUpperCase()}engine_request`,
        new URL(`${own}engine_request`),
        { url: `${own}engine_request`, toString: () => "https://elsewhere.invalid/" },
      ];
      for (const target of refused) expect(() => fetch(target), String(target)).toThrow(REFUSED);
      for (const api of ["WebSocket", "EventSource", "XMLHttpRequest"]) {
        expect(() => new (scope[api] as new (u: string) => unknown)("ws://ipc.localhost/"), api).toThrow(REFUSED);
      }
      const nav = scope.navigator as { sendBeacon: (u: string) => unknown };
      expect(() => nav.sendBeacon(`${own}engine_request`)).toThrow(REFUSED);
      expect(reached, "nothing else reached a live API").toHaveLength(1);
    });
  }

  it("hands the call on with the scope as `this`, as a browser's fetch requires", () => {
    let self: unknown = null;
    const scope: Record<string, unknown> = {
      fetch: function (this: unknown) {
        self = this;
        return Promise.resolve(null);
      },
    };
    installOfflineGuard(scope, "linux");
    const unbound = scope.fetch as (target: string) => unknown;
    void unbound("ipc://localhost/engine_status");
    expect(self).toBe(scope);
  });

  it("a build for a platform it has no spelling for hands on nothing, matching its closed policy", () => {
    const { scope, reached } = liveScope();
    installOfflineGuard(scope, "");
    for (const target of ["ipc://localhost/engine_request", "http://ipc.localhost/engine_request"]) {
      expect(isOwnCommandChannel(target, "")).toBe(false);
      expect(() => (scope.fetch as (t: string) => unknown)(target)).toThrow(REFUSED);
    }
    expect(reached).toEqual([]);
  });
});

/** Both spellings, in every place a mail can name an address. */
const MAIL = [
  `<p><a href="ipc://localhost/engine_request">a</a> <a href="http://ipc.localhost/engine_request">b</a></p>`,
  `<img src="ipc://localhost/x"><img src="http://ipc.localhost/x">`,
  `<img srcset="ipc://localhost/x 1x, http://ipc.localhost/y 2x">`,
  `<picture><source srcset="http://ipc.localhost/z"><img src="http://ipc.localhost/w"></picture>`,
  `<div style="background:url(ipc://localhost/x)">c</div>`,
  `<div style="background-image:url('http://ipc.localhost/x')">d</div>`,
  `<style>.e{background:url(http://ipc.localhost/s)} .f{background:url(ipc://localhost/s)}</style>`,
  `<table background="http://ipc.localhost/t"><tr><td>t</td></tr></table>`,
].join("\n");

describe("a mail cannot name the command scheme", () => {
  it("blanks every ipc: use and every fetching use of http://ipc.localhost; the link left is the shell's to ignore", async () => {
    const { sanitizeMailHtml } = await import("../../webapp/app/components/MessageBody.js");
    const out = sanitizeMailHtml(MAIL, {});
    expect(out.html).not.toMatch(/ipc:/i);
    const doc = new DOMParser().parseFromString(`<!doctype html><body>${out.html}`, "text/html");
    const naming = [...doc.querySelectorAll("*")].flatMap((el) =>
      [...el.attributes].filter((a) => /ipc\.localhost/i.test(a.value)).map((a) => `${el.tagName.toLowerCase()}[${a.name}]`),
    );
    // The link's href and the two labels that show the reader its host; no src, srcset, style or background.
    expect(naming.sort()).toEqual(["a[data-ohmail-host]", "a[href]", "a[title]"]);
    expect(doc.querySelector("style")?.textContent ?? "").not.toMatch(/ipc/i);
    // What would have fetched is on the blocked list, reachable (if ever) only through the image proxy.
    expect(out.blocked.length).toBeGreaterThan(0);
    expect(new Set(out.blocked.map((b) => b.host))).toEqual(new Set(["ipc.localhost"]));
  });
});
