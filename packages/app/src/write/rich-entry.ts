/**
 * WRITE's SCREEN ON THE MAIL GROUND, made once for every host that hands the ground: the letter for the place
 * `write` and the reply for the reader's slot, both over the one composer `mail/ground/WritingMount.tsx` stands. The
 * editor is the rich one, and the links it draws are read as the letter's body reads them (`@ohmail/letter-body`),
 * so a link in a letter being written is one the body would draw. Made at module scope: neither part changes
 * identity, and neither mounts again.
 */
import { createElement } from "react";
import { linkHref, useRenderedLinks } from "@ohmail/letter-body/links";
import { lazyView, LoadFailed } from "../frame/lazy-view.js";
import { preloadLetter, writeEntry } from "./entry.js";
import type { WriteEntry } from "./ports.js";

const loadEditor = () =>
  import("./editor/index.js").then(({ richEditor }) => ({
    default: richEditor({ href: linkHref, useRendered: useRenderedLinks }),
  }));

/** Warm the same code-split views an early Write or Reply opens directly. */
export const prepareWriting = async (): Promise<void> => {
  await Promise.all([preloadLetter(), MailRichEditor.preload()]);
};

export const MailRichEditor = lazyView(loadEditor, {
  loading: ({ label }) => createElement("div", { role: "group", "aria-label": label, "aria-busy": true }),
  failed: (onRetry, { label }) =>
    createElement("div", { role: "group", "aria-label": label }, createElement(LoadFailed, { onRetry })),
});
export const WRITE: WriteEntry = writeEntry({ editor: MailRichEditor });
