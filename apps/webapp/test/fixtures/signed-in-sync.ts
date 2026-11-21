export const SYNC_FIXTURE_OWNER = "acct_live_1";

/** The test server names the account whose mirror answers the walk. */
export function serveSignedInSync(
  serve: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return async (input, init) => {
    const answer = await serve(input, init);
    if (answer.ok && String(input).startsWith("/api/") && !String(input).startsWith("/api/auth/")) {
      answer.headers.set("X-Ohmail-Account", SYNC_FIXTURE_OWNER);
    }
    return answer;
  };
}

export function writeSignedInSync(): void {
  document.cookie = `tf_owner=${SYNC_FIXTURE_OWNER}; Path=/`;
}

export function clearSignedInSync(): void {
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
}
