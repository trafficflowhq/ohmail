/**
 * The namespaces the no-page's words come from. The page reads none itself: the server file reads these and hands the
 * words in, so the page's HTML carries them whatever the document inlined.
 */
export const NO_PAGE_NAMESPACES = ["gate"] as const;
