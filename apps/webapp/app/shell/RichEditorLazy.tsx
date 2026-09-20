"use client";

import { Suspense, lazy } from "react";
import { isRichEmpty } from "./rich-text";
import type { RichEditorProps } from "./RichEditor";

/**
 * THE ONE DYNAMIC DOOR TO THE EDITOR. TipTap and ProseMirror were ~126 kB of
 * `/mailbox`'s first load and nobody sees them at first paint: the composer, the inline reply, the
 * Reply Run and the two signature surfaces are each opened by a press. All five import `RichEditor`
 * from HERE, so `RichEditor.tsx` has exactly one static importer — the factory below — and the
 * editor's packages land in a chunk of their own. A static path back in is refused by
 * `test/first-load-defers-editor.test.ts`, which reads a build's own manifest rather than the source.
 */
const Impl = lazy(() =>
  import(/* webpackChunkName: "rich-editor" */ "./RichEditor").then((m) => ({ default: m.RichEditor })));

/**
 * The chunk, asked for before anything renders it. `React.lazy` exposes no preload, so the door
 * owns one: the same specifier, so the two callers share one request. The compose pane's own lazy
 * factory calls it, which is what keeps opening the composer ONE round of two parallel fetches
 * instead of a waterfall of two.
 */
export function preloadRichEditor(): Promise<unknown> {
  return import(/* webpackChunkName: "rich-editor" */ "./RichEditor");
}

/**
 * THE FRAME, while the chunk is in flight — and not `fallback={null}`, which is a hole where the
 * writing area belongs. Every caller hands the editor a surface class carrying its border,
 * background and height floor (`.compose-editor` is 220px), so rendering the same wrapper and the
 * same `.rte-body` link holds the box exactly where the editor will appear: a skeleton with no new
 * CSS and no new copy. The caller's own `ariaLabel` names it and `aria-busy` says it is coming,
 * rather than leaving a screen reader with nothing to land on.
 */
function EditorFrame({ className, ariaLabel, value, editable = true }: RichEditorProps) {
  const cls = [
    "rte",
    isRichEmpty(value) ? "is-empty" : "",
    editable ? "" : "is-locked",
    className ?? "",
  ].filter(Boolean).join(" ");
  return (
    <div className={cls} role="group" aria-label={ariaLabel} aria-busy="true">
      <div className="rte-body" />
    </div>
  );
}

/** The editor, byte-identical in props to `RichEditor` — only the arrival is deferred. */
export function RichEditor(props: RichEditorProps) {
  return (
    <Suspense fallback={<EditorFrame {...props} />}>
      <Impl {...props} />
    </Suspense>
  );
}

export type { RichEditorProps };
