/** Google's calendar by its own API: the reader behind the port, the hosts it is reached at, and its sign-in's addresses and trades. */
export const provider = "google" as const;
export { makeReader } from "./reader.js";
export { GOOGLE_API_HOST, GOOGLE_AUTHORIZE_URL, GOOGLE_CALENDAR_BASE, GOOGLE_HOSTS, GOOGLE_SIGN_IN_HOST, GOOGLE_TOKEN_URL, GOOGLE_TRADE_HOST } from "./hosts.js";
export { GOOGLE_SCOPES, exchangeGoogleCode, googleAuthorizeUrl, googleBearer, renewGoogleAccess, type GoogleAccess, type GoogleClient, type GoogleGrant, type GoogleSignIn } from "./sign-in.js";
