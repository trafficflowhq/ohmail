/**
 * Where Google is reached: fixed names in code. Nothing a person typed and nothing an answer names
 * becomes a host here; a calendar's id only ever becomes one escaped segment of a path under the base.
 */
export const GOOGLE_API_HOST = "www.googleapis.com";
/** Where a sign-in is traded: what came back from the sign-in page for a lasting sign-in, and that for a short one. */
export const GOOGLE_TRADE_HOST = "oauth2.googleapis.com";
export const GOOGLE_SIGN_IN_HOST = "accounts.google.com";

/** Every host a request of this folder may name: what the composing program builds the fixed-host request port from. */
export const GOOGLE_HOSTS: ReadonlySet<string> = new Set([GOOGLE_API_HOST, GOOGLE_TRADE_HOST, GOOGLE_SIGN_IN_HOST]);

export const GOOGLE_CALENDAR_BASE = `https://${GOOGLE_API_HOST}/calendar/v3`;
export const GOOGLE_TOKEN_URL = `https://${GOOGLE_TRADE_HOST}/token`;
/** The page a person signs in on. This package only writes the address; a browser opens it. */
export const GOOGLE_AUTHORIZE_URL = `https://${GOOGLE_SIGN_IN_HOST}/o/oauth2/v2/auth`;
