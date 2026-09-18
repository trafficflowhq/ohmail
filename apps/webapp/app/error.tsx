"use client";

import { LastResortDocument } from "./last-resort";

/**
 * THE ROOT BOUNDARY. This app has no `app/layout.tsx` — each route group carries its own root
 * layout — so a throw in ONE of those layouts, or in a provider inside it, unwinds past every
 * boundary below and lands here. Without this file Next paints its own "Application error": a
 * blank tab with no sentence and no way out. It renders ABOVE every layout, so it has no
 * stylesheet, no locale provider and no document: it writes its own, exactly as `global-error`
 * does, and `LastResortDocument` says what happens when it does not.
 */
export default function RootError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  /* The message is deliberately not rendered — the digest is what Next hands a reader to quote,
     and a thrown value can carry anything the app was holding when it threw. */
  return <LastResortDocument digest={error.digest} />;
}
