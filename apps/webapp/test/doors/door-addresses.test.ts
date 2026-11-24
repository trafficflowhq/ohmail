import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, middleware } from "../../middleware";
import { EDGE_PATHS, OWN_PATHS } from "../../routes.mjs";

/**
 * A DOOR'S ADDRESS NEVER MOVES. Every page before the app stands at the address the other programs and the mails
 * name (the desktop's link table names `/link-desktop`, the API's own config `/authorize-desktop`, the verification
 * mail `/verify-email`): written here as literals, each answered by its own route file and declared in the route
 * table. And every door that takes or prints a credential answers through the real middleware with the strict nonce
 * policy, `Referrer-Policy: no-referrer` and `Cache-Control: private, no-store`, under any spelling the router serves
 * as that page.
 */

const PRODUCT = fileURLToPath(new URL("../../app/(product)", import.meta.url));

/** The doors, by address, with the route file that answers each. */
const DOORS: Record<string, string> = {
  "/login": "login/page.tsx",
  "/join": "join/page.tsx",
  "/join/invite": "join/invite/page.tsx",
  "/verify-email": "verify-email/page.tsx",
  "/setup": "setup/page.tsx",
  "/approve": "approve/page.tsx",
  "/authorize-desktop": "authorize-desktop/page.tsx",
  "/link-desktop": "link-desktop/page.tsx",
  "/subscribed": "subscribed/page.tsx",
  "/microsoft-approval": "microsoft-approval/page.tsx",
  "/resume": "resume/page.tsx",
  "/account/delete": "account/delete/page.tsx",
};

/** The doors a credential is typed into or printed on. */
const CREDENTIAL = [
  "/login", "/join", "/join/invite", "/verify-email", "/setup", "/approve", "/authorize-desktop", "/link-desktop",
  "/account/delete",
];

const ORIGIN = "https://ohmail.app";
const answer = (path: string): Promise<Response> =>
  middleware(new NextRequest(new Request(`${ORIGIN}${path}`))) as unknown as Promise<Response>;

/** The three headers a credential page answers with. */
function credentialHeaders(res: Response): { nonce: boolean; inline: boolean; referrer: string | null; cache: string | null } {
  const csp = res.headers.get("content-security-policy") ?? "";
  const script = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src")) ?? "";
  return {
    nonce: /'nonce-[^']+'/.test(script),
    inline: script.includes("'unsafe-inline'"),
    referrer: res.headers.get("referrer-policy"),
    cache: res.headers.get("cache-control"),
  };
}
const STRICT = { nonce: true, inline: false, referrer: "no-referrer", cache: "private, no-store" };

/** The spellings the router serves as `path`: encoded, through dot segments, with a trailing dot. */
const spellings = (path: string): string[] => [
  path,
  `/%${path.charCodeAt(1).toString(16)}${path.slice(2)}`,
  `/./${path.slice(1)}`,
  `/x/..${path}`,
  `${path}/.`,
];

describe("every door stands at its address", () => {
  it("each address is answered by its own route file and declared in the route table, the matcher's set too", () => {
    for (const [path, file] of Object.entries(DOORS)) {
      expect(existsSync(`${PRODUCT}/${file}`), `${path}: no ${file}`).toBe(true);
      expect(OWN_PATHS, path).toContain(path);
      expect(EDGE_PATHS, path).toContain(path);
      expect(config.matcher, path).toContain(path);
    }
  });

  it("the website's /delete-account stays the website's, beside the page that deletes from the app", () => {
    expect(OWN_PATHS).toContain("/delete-account");
    expect(existsSync(`${PRODUCT}/delete-account/page.tsx`)).toBe(false);
  });
});

describe("a credential page answers with its three headers, however its path is spelled", () => {
  for (const path of CREDENTIAL) {
    it(path, async () => {
      for (const spelled of spellings(path)) {
        expect(credentialHeaders(await answer(spelled)), spelled).toEqual(STRICT);
      }
    });
  }

  it("a door with no credential keeps the ordinary answer", async () => {
    const res = await answer("/subscribed");
    expect(res.headers.get("referrer-policy")).toBeNull();
    expect(res.headers.get("cache-control")).toBeNull();
  });

  it("a spelling that is another path is not a credential page", async () => {
    for (const other of ["/LOGIN", "/%256cogin", "/account/deleted", "/account"]) {
      expect((await answer(other)).headers.get("referrer-policy"), other).toBeNull();
    }
  });
});
