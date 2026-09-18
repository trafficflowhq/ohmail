"use client";

import { LastResortDocument } from "./last-resort";

/**
 * LAST RESORT. `error.tsx` covers a throw in a route group's root layout; this covers the one
 * nothing else can — a throw in the boundary above it. It REPLACES the root layout when it fires,
 * so it writes its own document; in this app the root boundary has to do that too, and both go
 * through the same component rather than keeping two copies of a rule one of them could lose.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  return <LastResortDocument digest={error.digest} />;
}
