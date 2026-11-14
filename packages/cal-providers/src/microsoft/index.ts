/**
 * Microsoft's calendar by Graph: the reader behind the port, and where Graph is reached. Built from
 * Microsoft's own pages and tried against a double; not yet tried against Microsoft itself. It has a
 * switch of its own: a program serves it by naming the word and the base of the API, and by nothing less.
 */
export const provider = "microsoft" as const;
export { makeReader, type MicrosoftDeps } from "./reader.js";
export { MS_GRAPH_BASE, MS_GRAPH_CALENDAR_SCOPE, MS_SIGN_IN_HOST, microsoftHosts } from "./graph.js";
