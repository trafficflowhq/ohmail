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
 * THERE IS DELIBERATELY NO `totpQrSvg` HERE ANY MORE.
 *
 * There used to be, and what it returned was not a QR code: a 180×180 white rectangle with
 * the raw `otpauth://` URI drawn across it as one line of 6px text, under the comment "real
 * QR rendering is a client concern; the service returns a self-contained placeholder". The
 * client half was never built. So `/join` injected that placeholder with
 * `dangerouslySetInnerHTML`, labelled it `aria-label="TOTP QR"` for screen readers, and the
 * copy above it said "Scan this with your authenticator app" — three statements, none of
 * them true, on the fallback path taken by exactly the people whose device cannot make a
 * passkey.
 *
 * A drawn-on-the-server QR is also the wrong shape even when it works: the provisioning URI
 * contains the shared secret, so rendering it into an image server-side puts the secret into
 * a second representation for no benefit the client cannot provide itself.
 *
 * `totpEnroll` returns `secret` and `otpauthUrl`. The web client offers the key for manual
 * entry (every authenticator app supports it) and the `otpauth://` URI as a link, which on a
 * phone hands the enrollment straight to the app — the one platform where scanning was never
 * possible anyway, because the code would be on the same screen as the camera. If a real QR
 * is wanted later it is a client-side encoder over `otpauthUrl`, and nothing here changes.
 */
