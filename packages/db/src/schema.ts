/**
 * Both halves, for everything that runs on the hosted service. A barrel and nothing else: it
 * exists so the split — `./schema-mail.js` (publishable, what a desktop install carries) and
 * `./schema-cloud.js` (private) — did not have to be a rename across every consumer. A local
 * install must not import this file: importing it pulls the Cloud half into the artifact's
 * closure, the thing the split exists to prevent; the sidecar imports `mailSchema` directly and
 * its bundle is measured for the absence of the rest.
 */
export * from "./schema-mail.js";
export * from "./schema-cloud.js";

import { mailSchema } from "./schema-mail.js";
import { cloudSchema } from "./schema-cloud.js";

/** Every table, mail then cloud. The shape every existing consumer already expects. */
export const schema = { ...mailSchema, ...cloudSchema };
