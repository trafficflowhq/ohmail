/**
 * WRITE's SCREEN ON THE MAIL GROUND, made once for every host that hands the ground: the letter for the place
 * `write` and the reply for the reader's slot, both over the one composer `ground/WritingMount.tsx` stands. The
 * editor is the rich one, and the links it draws are read as the letter's body reads them (`@ohmail/letter-body`),
 * so a link in a letter being written is one the body would draw. Made at module scope: neither part changes
 * identity, and neither mounts again.
 */
import { linkHref, useRenderedLinks } from "@ohmail/letter-body/links";
import { richEditor } from "../write/editor/index.js";
import { writeEntry } from "../write/entry.js";
import type { WriteEntry } from "../write/ports.js";

export const WRITE: WriteEntry = writeEntry({
  editor: richEditor({ href: linkHref, useRendered: useRenderedLinks }),
});
