"use client";

import { LastResort } from "./last-resort";

/**
 * THE ROOT BOUNDARY. This app has no `app/layout.tsx` — each route group carries its own root
 * layout (`(product)`, `(marketing)`, `(marketing-de)`), so a throw in ONE of those layouts, or
 * in a provider inside it, unwinds past every boundary below and lands here. Without this file
 * Next paints its own "Application error": a blank tab with no sentence and no way out, which is
 * the whole defect. It renders above the layouts and therefore has no stylesheet and no locale
 * provider — see `LastResort`, which is written for exactly that.
 */
export default function RootError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  /* The message is deliberately not rendered — the digest is what Next hands a reader to quote,
     and a thrown value can carry anything the app was holding when it threw. */
  return <LastResort digest={error.digest} />;
}
