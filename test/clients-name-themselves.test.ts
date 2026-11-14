import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withoutComments } from "../scripts/lib/source-scan.mjs";

/**
 * EVERY ENGINE A CLIENT BUILDS NAMES ITSELF ON THE WIRE: the HTTP adapter has no header seam of its own that
 * a host is made to fill, so each host's TRANSPORT names the client (`x-ohmail-client`), and each of the four
 * places a product builds an `HttpAdapter` is held by a behaviour test at its own door (the web's API client,
 * refresh and adapter in `apps/webapp/test/account-erased-elsewhere.test.tsx`, the window's bridge in
 * `apps/desktop/test/bridge-fetch.test.ts`, the paired page's manager in `host-client-bearer.test.ts`, the
 * phone's manager and pre-session asks in `apps/mobile/test/bearer.test.ts` and `pairing.test.ts`). A fifth
 * construction is a door nobody has named, and a current app answered "too old" on the day by a door that
 * forgot: so it is red here until its door is named and tested, and this list grows with it.
 */
const REPO = fileURLToPath(new URL("..", import.meta.url));

/** The product files that build an adapter, each with the transport that names its client. */
const DOORS: Readonly<Record<string, string>> = {
  "apps/webapp/app/shell/engine-config.ts": "web: the adapter's headers seam and the session transport, with the API client and the refresh",
  "apps/desktop/src/bridge-fetch.ts": "desktop window: bridgeFetch names every request, engine and wires alike",
  "apps/desktop/src/host-client/host-engine.ts": "paired page: the bearer manager's transport names every request",
  "apps/mobile/src/engine/boot.ts": "phone: the bearer manager's headers and transport",
};

/** Files, by path, that construct an adapter in non-test source. Pure over a file's text. */
export function buildsAnAdapter(source: string): boolean {
  return /\bnew\s+HttpAdapter\s*\(/.test(withoutComments(source));
}

function productFiles(): string[] {
  const listed = execFileSync("git", ["ls-files", "--", "apps", "packages"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return listed.split("\n").filter((f) =>
    /\.(?:ts|tsx|mts)$/.test(f) && !f.endsWith(".d.ts") && !/(?:^|\/)(?:test|tests|__tests__)\//.test(f) && !/\.test\./.test(f));
}

describe("every engine a client builds is named at a transport", () => {
  it("only the four known doors construct an HttpAdapter in product code", async () => {
    const { readFileSync } = await import("node:fs");
    const files = productFiles();
    expect(files.length, "the listing found nothing to read").toBeGreaterThan(1000);
    const found = files.filter((f) => buildsAnAdapter(readFileSync(`${REPO}${f}`, "utf8")));
    expect(found.sort()).toEqual(Object.keys(DOORS).sort());
  });

  it("CONTROL: the scan finds a fifth construction and ignores one in a comment", () => {
    expect(buildsAnAdapter("const a = new HttpAdapter({ baseUrl: '' });")).toBe(true);
    expect(buildsAnAdapter("// new HttpAdapter({ baseUrl: '' })\nconst a = 1;")).toBe(false);
    expect(buildsAnAdapter("/** hand this to `new HttpAdapter({ baseUrl, fetch })` */\nconst a = 1;")).toBe(false);
  });
});
