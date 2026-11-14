/**
 * The body the reader's states page mounts: the reader's own body entry, handed through here so the page's
 * typecheck reads the entry's declared type (`reader-body-part.d.mts`) and not the body package's sources, which
 * its program would read under rules the package is not written for. The page's bundle takes the real entry.
 */
export { letterBody } from "../../src/reader/body/index.js";
