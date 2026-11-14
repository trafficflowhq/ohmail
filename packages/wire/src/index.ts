/**
 * @ohmail/wire — what travels between an ohmail client and an ohmail server, and what each keeps
 * of it: requests, answers, record kinds, acts and reason words, declared once. The server's
 * routes and every client take their types from here, so a change on one side that the other has
 * not followed does not compile.
 *
 * TYPES ONLY. This package exports no value and imports no package: every closed set is a union
 * here, and whoever needs it as a list at run time keeps the list and proves it with `Complete`
 * (`complete.ts`). Nothing of it reaches any bundle.
 */
export type * from "./complete.js";
export type * from "./base.js";
export type * from "./records.js";
export type * from "./mail.js";
export type * from "./bodies.js";
export type * from "./organizing.js";
export type * from "./mailbox-states.js";
export type * from "./mailboxes.js";
export type * from "./screener.js";
export type * from "./screener-answers.js";
export type * from "./drafts.js";
export type * from "./search.js";
export type * from "./workflows.js";
export type * from "./rest-only.js";
export type * from "./mirror.js";
export type * from "./readings.js";
export type * from "./acts.js";
export type * from "./acts-drafts.js";
export type * from "./acts-rules.js";
export type * from "./act-answers.js";
export type * from "./requests.js";
export type * from "./reasons.js";
export type * from "./client.js";
export type * from "./routes.js";
export type * from "./unbound-calls.js";
export type * from "./calendar.js";
