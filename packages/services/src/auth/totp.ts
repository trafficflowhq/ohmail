import { generateSecret, generateSync, verifySync, generateURI } from "otplib";

const PERIOD = 30; // seconds per TOTP step

export interface TotpVerification {
  valid: boolean;
  /** The matched time step (monotonic, = floor(epoch/period)); persist as the
   *  last-consumed step so the same token cannot be replayed within its window. */
  timeStep: number | null;
}

/** A fresh Base32 secret for a new enrollment (shown once). */
export function newTotpSecret(): string {
  return generateSecret();
}

/** The `otpauth://totp/...` provisioning URI for authenticator apps. */
export function totpUri(opts: { issuer: string; label: string; secret: string }): string {
  return generateURI({ strategy: "totp", ...opts });
}

/** The current code for a secret at a given wall-clock (tests + activation checks). */
export function totpNow(secret: string, now: Date): string {
  return generateSync({ secret, epoch: Math.floor(now.getTime() / 1000) });
}

/**
 * Verify a TOTP code at `now`, tolerating ±`window` steps of clock skew, and
 * REJECT any token whose time step is `<= afterStep` — the single-use-per-timestep
 * guard. Returns the matched `timeStep` so the caller can persist it.
 */
export function verifyTotp(args: {
  secret: string;
  token: string;
  now: Date;
  window: number;
  afterStep: number | null;
}): TotpVerification {
  const epoch = Math.floor(args.now.getTime() / 1000);
  const r = verifySync({
    secret: args.secret,
    token: args.token,
    epoch,
    epochTolerance: args.window * PERIOD,
    ...(args.afterStep != null ? { afterTimeStep: args.afterStep } : {}),
  });
  return { valid: r.valid === true, timeStep: r.valid ? (r as { timeStep: number }).timeStep : null };
}

/*
 * There is deliberately no `totpQrSvg` any more. What it returned was not a QR code: a white
 * rectangle with the raw `otpauth://` URI drawn as 6px text, promising a client half never built
 * — injected with `dangerouslySetInnerHTML`, captioned "Scan this": three statements, none true,
 * on the path taken by exactly the people whose device cannot make a passkey. A server-drawn QR
 * is also wrong when it works: the provisioning URI contains the shared secret. `totpEnroll`
 * returns `secret` and `otpauthUrl`: manual entry plus the URI as a link, which on a phone hands
 * enrollment straight to the app. A real QR later is a client-side encoder over `otpauthUrl`.
 */
