import { measurementId } from "../../analytics.mjs";

/**
 * The website's measurement id for THIS build, or null — the one gate every analytics surface
 * keys on (the notice, the loader, the footer line, the privacy and subprocessor text). The
 * literal `process.env.NEXT_PUBLIC_…` read is what Next inlines at build time, in both bundles.
 */
export function analyticsId(): string | null {
  return measurementId(process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID);
}
