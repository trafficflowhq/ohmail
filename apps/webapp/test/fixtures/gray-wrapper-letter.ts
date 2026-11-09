/**
 * ── THE NEAR-NEUTRAL GREY WRAPPER ──────────────────────────────────────────────────
 *
 * The reported shape: a plain business letter, laid out in a 600px table, whose page declared a
 * faint grey (`#efefef`). The declared canvas keeps it in the frame, so the frame's paper was
 * painted that grey and the letter read as a dull sheet rather than a white page. The SHAPE is
 * captured here rather than the sender's words — a declared canvas plus a light-but-colourless
 * body background is all the classification and the paper depend on.
 *
 * `paintedPaper` must drop that grey to the app's own white, so a component render of this
 * message carries no `--ohmail-paper` at all.
 */
export const GRAY_WRAPPER_HTML =
  '<body bgcolor="#efefef"><table width="600"><tr><td>' +
  "<p>Guten Tag,</p><p>anbei die Unterlagen wie besprochen.</p><p>Freundliche Grüsse</p>" +
  "</td></tr></table></body>";

export const GRAY_WRAPPER_TEXT =
  "Guten Tag,\n\nanbei die Unterlagen wie besprochen.\n\nFreundliche Grüsse";

/**
 * THE OTHER SIDE OF THE CLAMP: a deliberately COLOURED light canvas. The same 600px frame, but
 * the page is a real pale blue (`#cfe0ff`) — a chroma well past the neutral band — so it is a
 * design the reader chose to keep, and `paintedPaper` must leave its ground alone.
 */
export const TINTED_WRAPPER_HTML =
  '<body bgcolor="#cfe0ff"><table width="600"><tr><td><p>A designed card.</p></td></tr></table></body>';
