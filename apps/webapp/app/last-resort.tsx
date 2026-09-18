"use client";

import { useEffect, useState } from "react";
import { buildId } from "./build-id";
import { reportRenderError } from "./error-report";

/**
 * THE SCREEN BEHIND THE SCREEN. Both boundaries that can fire with no layout around them —
 * `app/error.tsx` (a route group's root layout threw) and `app/global-error.tsx` (the document
 * itself) — render this. It therefore assumes NOTHING: no stylesheet, no locale provider, no
 * catalogue, no shell. That is also why both languages are on the page at once rather than
 * chosen: the thing that would have said which one is the thing that failed, and a wrong guess
 * here is a person who cannot read their own error page.
 */
export function LastResort({ digest }: { digest?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => { reportRenderError(digest); }, [digest]);

  return (
    <div className="ohmail-lr">
      {/* No stylesheet reaches this page, so it carries its own. `style-src` admits it
          (`app/security-headers.ts`: `'self' 'unsafe-inline'` unconditionally). */}
      <style>{LAST_RESORT_CSS}</style>
      <main className="ohmail-lr-card">
        <h1>ohmail hit an error.</h1>
        <p>Nothing is lost — your mail is on your mail server. Reload to carry on.</p>
        <p lang="de">
          Nichts ist verloren — deine Post liegt auf deinem Mailserver. Lade neu, um
          weiterzumachen.
        </p>
        <button
          type="button"
          className="ohmail-lr-go"
          onClick={() => {
            if (typeof window !== "undefined") window.location.reload();
          }}
        >
          Reload · Neu laden
        </button>
        <p className="ohmail-lr-fact">{buildId()}</p>
        {digest ? (
          <p className="ohmail-lr-fact">
            <span>Error reference · Fehlerkennung</span>{" "}
            <code>{digest}</code>{" "}
            <button
              type="button"
              className="ohmail-lr-copy"
              onClick={() => {
                // A clipboard write is refused outright in an insecure context and can be
                // denied at any time. It must not throw here, and it does not have to
                // succeed: the reference is selectable text on the page either way.
                void navigator.clipboard?.writeText(digest).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
            >
              {copied ? "Copied · Kopiert" : "Copy · Kopieren"}
            </button>
          </p>
        ) : null}
      </main>
    </div>
  );
}

/* Both themes, because the canvas tokens live in a stylesheet this page does not have. The
   colours are `(product)/layout.tsx`'s own `themeColor` pair. */
const LAST_RESORT_CSS = `
.ohmail-lr { color-scheme: light dark; background: #fbfaf9; color: #201b16;
  min-height: 100vh; display: flex; align-items: center; justify-content: center;
  padding: 2rem; font: 16px/1.5 system-ui, sans-serif; }
.ohmail-lr-card { max-width: 32rem; display: flex; flex-direction: column; gap: 0.75rem; }
.ohmail-lr-card h1 { font-size: 1.25rem; font-weight: 600; margin: 0; }
.ohmail-lr-card p { margin: 0; }
.ohmail-lr-go { align-self: flex-start; margin-top: 0.5rem; padding: 0.5rem 1rem;
  border: 1px solid currentColor; border-radius: 6px; background: transparent;
  color: inherit; font: inherit; cursor: pointer; }
.ohmail-lr-fact { font-size: 0.8125rem; opacity: 0.7; }
.ohmail-lr-fact code { font-family: ui-monospace, monospace; user-select: all; }
.ohmail-lr-copy { border: 0; background: transparent; color: inherit; font: inherit;
  text-decoration: underline; cursor: pointer; padding: 0; }
@media (prefers-color-scheme: dark) {
  .ohmail-lr { background: #0e0b08; color: #fbfaf9; }
}
`;
