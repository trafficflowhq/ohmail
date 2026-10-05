import { ServiceError } from "../errors.js";

/**
 * A CREDENTIAL'S VERDICT, SAID APART FROM A LAPSED SESSION. A wrong password, code, passkey, login
 * token or challenge and an expired access token both answered 401 `unauthorized`, so a client that
 * renews and re-sends on a 401 sent a wrong code twice, and only a list of paths told the two apart.
 * The verdict names itself now; its messages are unchanged, because clients map those sentences. A
 * session's own refusal ("no active session", "authentication required") stays `unauthorized`.
 * `test/factor-routes-never-refresh.test.ts` holds every credential route to that split.
 */
export const CREDENTIAL_REFUSED = "credential_refused";

/** The 401 every credential verdict answers, minted here and nowhere else. */
export function credentialRefused(message: string): ServiceError {
  return new ServiceError(CREDENTIAL_REFUSED, 401, message);
}
