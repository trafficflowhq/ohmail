"use client";

import { LastResort } from "./last-resort";

/**
 * LAST RESORT. `error.tsx` covers a throw in a route group's root layout; this covers the one
 * nothing else can — a throw in the boundary above it, or in the document Next is rendering into.
 * It REPLACES the root layout when it fires, so it writes its own `<html>`/`<body>`: there is no
 * document to inherit. `lang="en"` because the thing that knew the reader's language is gone;
 * the page states both languages itself.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>
        <LastResort digest={error.digest} />
      </body>
    </html>
  );
}
