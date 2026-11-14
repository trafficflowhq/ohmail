/**
 * A PROVIDER'S OWN SIGN-IN, as the form reads it. Which tile signs in is a row of data, and whether it does here is
 * what the shell answered: unread is shut.
 */
import type { SignInProvider, SignInWays } from "./types.js";

/** The provider whose sign-in connects a tile, by the tile's id. Another provider is another row. */
export const SIGN_IN_OF_PRESET: Readonly<Record<string, SignInProvider>> = Object.freeze({
  microsoft: "microsoft",
});

/** The tile a sign-in's return is about. */
export const PRESET_OF_SIGN_IN: Readonly<Record<SignInProvider, string>> = Object.freeze({
  microsoft: "microsoft",
});

/** Every door shut: what a form holds until the shell's answer is read, and whenever it could not be. */
export const WAYS_SHUT: SignInWays = Object.freeze({
  microsoft: Object.freeze({ redirect: false, device: false }),
});

/**
 * HOW A TILE CONNECTS HERE: by the provider's redirect, by a code typed at the provider (only where the shell runs
 * that ceremony from this form), or by a password. The password fields are the second way on a tile that signs in,
 * taken by an explicit press (`secondWay`).
 */
export function wayOf(
  preset: string | null,
  ways: SignInWays,
  runsCode: boolean,
  secondWay: boolean,
): { readonly provider: SignInProvider; readonly by: "redirect" | "code" } | null {
  const provider =
    preset === null || !Object.hasOwn(SIGN_IN_OF_PRESET, preset) ? undefined : SIGN_IN_OF_PRESET[preset];
  if (provider === undefined || secondWay) return null;
  const door = ways[provider];
  if (door.redirect === true) return { provider, by: "redirect" };
  return door.device === true && runsCode ? { provider, by: "code" } : null;
}

/** The provider's ceremony by code exists on this server, and this form does not run it: it is offered elsewhere. */
export function codeElsewhere(preset: string | null, ways: SignInWays, runsCode: boolean): boolean {
  const provider =
    preset === null || !Object.hasOwn(SIGN_IN_OF_PRESET, preset) ? undefined : SIGN_IN_OF_PRESET[preset];
  if (provider === undefined) return false;
  return !ways[provider].redirect && ways[provider].device && !runsCode;
}

/** The floor under a poll of a sign-in by code. The server's own pace is never undercut. */
export const POLL_FLOOR_MS = 5_000;

/** How long a shell waits before the next poll: the server's word, and never under the floor. */
export function pollDelay(retryAfterMs: number): number {
  return Math.max(POLL_FLOOR_MS, Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
}
