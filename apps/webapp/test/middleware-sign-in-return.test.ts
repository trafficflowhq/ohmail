import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { middleware } from "../middleware";

/**
 * THE DOCUMENT A PROVIDER'S SIGN-IN RETURNS TO SENDS NO REFERRER. The return comes back to `/` with a single-use
 * code and state in its query. The page's script takes them out of the address before its first request, but the
 * document's own requests come before any script, and under the default policy they would carry the whole address
 * to this origin's API. So that document is answered `Referrer-Policy: no-referrer`.
 */
const ORIGIN = "https://ohmail.app";
const answer = async (path: string, cookie?: string): Promise<Response> =>
  middleware(new NextRequest(new Request(`${ORIGIN}${path}`, cookie ? { headers: { cookie } } : {})));
const policy = async (path: string, cookie?: string): Promise<string | null> =>
  (await answer(path, cookie)).headers.get("referrer-policy");

describe("the sign-in return's document", () => {
  it.each([
    "/?oauth=pending&state=a-state&code=a-code",
    "/?oauth=error&reason=consent_declined",
    "/?settings=mailboxes&oauth=pending&state=a-state&code=a-code",
  ])("is answered with no referrer: %s", async (path) => {
    expect(await policy(path)).toBe("no-referrer");
    expect(await policy(path, "tf_owner=acct-1")).toBe("no-referrer");
  });

  it("no other document at the root is touched: the policy there stays the app's own", async () => {
    const plain = await policy("/");
    expect(plain).not.toBe("no-referrer");
    expect(await policy("/?settings=mailboxes")).toBe(plain);
    expect(await policy("/?demo=1")).toBe(await policy("/?demo=1&x=1"));
  });
});
