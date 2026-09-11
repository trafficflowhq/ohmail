"use client";

import type { CSSProperties, ReactNode } from "react";

/* The marker — the page's one typographic device: a terracotta band swept under a load-bearing
   phrase. It appears exactly twice — the hero's promise and the self-hosted card's path line —
   which is what keeps it a brand mark rather than decoration. The material and sweep live in
   landing.css under `.l-mk`; this file is only the element and the tag map. <mark>, not <span>:
   the phrase keeps its "marked text" semantics and the sentence stays ONE sentence to a screen
   reader; nothing splits a word or restates the text in an aria-label. `--mkn` is the phrase's
   index within its sentence, which is all the stagger needs; the CSS turns it into a delay. */
export function Mark({
  dir,
  i,
  children,
}: {
  dir: "in" | "out";
  i?: number;
  children: ReactNode;
}) {
  return (
    <mark
      className="l-mk"
      data-mk={dir}
      style={i === undefined ? undefined : ({ "--mkn": i } as CSSProperties)}
    >
      {children}
    </mark>
  );
}

/**
 * The rich-text tags every marked sentence on this page shares. Two tags, because direction carries
 * meaning: `<k>` sweeps in from the left with the reading, `<o>` sweeps out to the right — used for
 * the one phrase on the page that is about leaving. WHICH phrases are marked is decided in
 * messages/en.json, not the components, so a translation re-decides its own emphasis. Call it per
 * render: next-intl invokes the callbacks in document order, so the counter it closes over hands
 * out indices in reading order, and a fresh call per render keeps that true under StrictMode's
 * double invoke.
 */
export function markTags() {
  let n = 0;
  return {
    k: (chunks: ReactNode) => (
      <Mark dir="in" i={n++}>
        {chunks}
      </Mark>
    ),
    o: (chunks: ReactNode) => (
      <Mark dir="out" i={n++}>
        {chunks}
      </Mark>
    ),
  };
}
