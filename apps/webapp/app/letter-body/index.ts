/**
 * The door of the letter's body: the renderer of one letter, with what a surface that mounts it
 * needs. Each file in this folder was moved here as it stood.
 *
 * A surface that draws a letter imports from here. Two files are taken by their own path and are
 * not handed on from here, because code that draws no letter needs them and must not load the
 * renderer for it: `rendered-links.ts` (the composer, an invitation's note, the desktop's entry)
 * and `mail-doc-cache.ts` (sign-out).
 */
export { MessageBody, COPY as MAIL_BODY_COPY, type MessageBodyProps } from "./MessageBody";
export { BodyText, COPY as BODY_TEXT_COPY } from "./BodyText";
export { BlockNoticeGloss, type BlockNotice } from "./BlockNotice";
