import { publicSignupEnabled } from "../signup-mode";

/**
 * The legal pages (imprint, privacy, subprocessors) are noindex exactly while this deployment is
 * a pre-launch waitlist — `TF_PUBLIC_SIGNUP` unset, the same switch that decides the landing CTA.
 * A published Swiss imprint is meant to be findable, so the old "drop `robots` at public launch"
 * TODO is this one read instead of a launch-day memory: the operator opens signup and the pages
 * index by construction. Read at build time, like the landing's own call (`(marketing)/page.tsx`).
 */
export function legalRobots(
  env: Record<string, string | undefined> = process.env,
): { index: false } | undefined {
  return publicSignupEnabled(env) ? undefined : { index: false };
}
