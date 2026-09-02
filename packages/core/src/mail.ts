/**
 * `@trafficflow/core/mail` — THE MAIL HALF OF CORE, described without the model half.
 *
 * Same modules as the default barrel minus `ai/*`: the taxonomy prompt, the drafting prompt, the
 * Anthropic client seam and the workflow proposer. What remains is everything that reads, parses,
 * threads, dedups, routes, reconciles and stores mail, plus the crypto and the redacting logger.
 *
 * ── WHY A SECOND ENTRY POINT AND NOT A REORGANISATION ─────────────────────────────────────
 *
 * The default barrel is `export *` over twenty-odd modules, so importing one symbol from it
 * loads all of them. That is invisible and free inside a server we deploy whole, and it is
 * neither once the same package is compiled into something we hand to a stranger: the local
 * engine configures no model and can never classify, yet it carried the verbatim prompts.
 *
 * This file is ADDITIVE. `./index.js` keeps every export it has, so no existing consumer moves
 * and nothing about the hosted service changes. The only difference is that a consumer which
 * wants the mail half can now say so and get exactly that.
 *
 * ── THE PORT IS HERE; THE IMPLEMENTATION IS NOT ───────────────────────────────────────────
 *
 * `PipelineDeps.classifier` is optional, and a deployment that supplies none routes on rules
 * alone. So the mail half has to be able to NAME the seam without carrying anything that can
 * fill it — hence `classifier-port.js`, which is three interfaces and no prompt. A consumer of
 * this entry point can describe a pipeline, and cannot build a model client.
 */
export const CORE_VERSION = "0.0.0";

export * from "./types.js";
export * from "./identity.js";
export * from "./mime.js";
export * from "./ics.js";
export * from "./html-storage.js";
export * from "./sensitive.js";
export * from "./rules.js";
export * from "./authserv-ids.js";
export * from "./ports.js";
export * from "./dedup.js";
export * from "./gone.js";
export * from "./reconciler.js";
export * from "./threading.js";
export * from "./pipeline.js";
// The junk-husk verify/rewrite BOTH restore doors share — the API's "Not junk" rescue and the
// worker's convergence pass. Mail-half by the same test as `pipeline.js` beside it: it names no
// model and imports only the mail schema and this package's own identity/mime vocabulary.
export * from "./husk-restore.js";
// The seams only — see the header. Never `./ai/classify.js` or `./ai/draft.js`, which are the
// implementations: those name a model, carry the prompts, and are the private half wholesale.
// A consumer of this entry point can be HANDED a classifier or a drafter and can describe one;
// it cannot construct one, and nothing here tells it what model would answer.
export type { ClassifierInput, ClassifierResult, ClassifierPort } from "./classifier-port.js";
export type {
  DraftIncoming, DraftContext, DraftInput, DraftResult, DraftPort,
} from "./draft-port.js";
// The token-source port, from the auth-assembly seam (`adapters/imap-auth.js`) where it is
// defined — the same line as the two ports above: a consumer of this entry point can be handed
// an OAuth token provider and can describe one, and the Microsoft client that implements it
// (`oauth/microsoft.js`) is deliberately not here.
export type { OAuthTokenProvider } from "./adapters/imap-auth.js";
/*
 * ── AND THE QUESTION, WHICH IS MAIL-HALF CODE AND NOT MODEL CODE ──────────────────────────
 *
 * `classify-prompt.js` and `draft-prompt.js` are leaves outside `ai/`: the routing taxonomy, the
 * reply policy, the two response schemas, the outbound sensitivity sink, the drafting redaction
 * allow-list, and the coercion of whatever a model answers. They name no model, carry no client,
 * and import only mail vocabulary.
 *
 * They are here — unlike the implementations, which are not and never will be — because a
 * standalone install runs against a model belonging to the person using it, and it has to ask
 * the SAME question a hosted deployment asks. A second copy of the taxonomy is how two installs
 * come to file one message into two different folders, and a second copy of the redaction
 * allow-list is how one of them comes to send a raw body. Sharing them is what makes those two
 * failures impossible rather than merely unlikely.
 *
 * A consumer of this entry point can therefore ask the question and still cannot construct a
 * client to ask it with — which is the same line this file has always drawn, in the same place.
 */
export * from "./classify-prompt.js";
export * from "./draft-prompt.js";
// The WORKFLOW SHAPES and their validators — the step/trigger grammar plus the two validators the
// rules engine checks a stored workflow against. `workflow-shapes.js` is a LEAF outside `ai/` on
// purpose: it names no model and carries no prompt, so it is mail-half code the local engine may
// carry, and keeping it out of `ai/` lets `core/dist/ai/` be the private model half without
// exception. The module that calls the classifier and the workflow runner beside it (which calls
// the drafter) both live under `ai/` and are deliberately NOT here — a consumer of this entry point
// can validate and store a workflow, and cannot generate one.
export * from "./workflow-shapes.js";
export * from "./send.js";
// `Re: ` exactly once — the reply subject, promoted out of the client engine because the away
// responder is REPLY-ONLY and composes from `packages/services`, which may not import the browser
// engine. A leaf with its own source subpath (`@trafficflow/core/reply-subject`) for the graphs
// that cannot load this barrel; see the module header and `//reply-subject` in the manifest.
export * from "./reply-subject.js";
// The away responder's whole suppression set, as one pure function over one row, plus the text
// hash `throttle='per_message'` is keyed by. Mail-half by the same test as `pipeline.js`: it names
// no model, and its only imports are this package's own `rules.js` and `node:crypto`.
export * from "./away-eligibility.js";
export * from "./sent-record.js";
export * from "./outbound-text.js";
export * from "./crypto.js";
export * from "./log.js";
export * from "./privacy/tracker-blocker.js";
