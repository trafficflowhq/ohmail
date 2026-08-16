/**
 * BOTH HALVES, for everything that runs on the hosted service.
 *
 * A barrel and nothing else. It exists so that the split below — `./schema-mail.js` (41 tables,
 * publishable, what a desktop install carries) and `./schema-cloud.js` (22 tables, private) —
 * did not have to be a rename across every consumer in the repository.
 *
 * **A local install must not import this file.** Importing it pulls the Cloud half into the
 * artifact's closure, which is the thing the split exists to prevent; the sidecar imports
 * `mailSchema` directly and its bundle is measured for the absence of the rest.
 */
export * from "./schema-mail.js";
export * from "./schema-cloud.js";

import { mailSchema } from "./schema-mail.js";
import { cloudSchema } from "./schema-cloud.js";

/** Every table, mail then cloud. The shape every existing consumer already expects. */
export const schema = { ...mailSchema, ...cloudSchema };
