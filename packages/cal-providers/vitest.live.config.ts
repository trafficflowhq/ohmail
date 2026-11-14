import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import base from "../../vitest.config";

/**
 * The run that dials a calendar provider. It is never the default run: the repository's own
 * configuration includes `*.test.ts` only and refuses every socket that leaves this machine, and
 * the files here are named `*.live.ts`.
 *
 *   npx vitest run --config packages/cal-providers/vitest.live.config.ts [a file]
 *
 * The root's configuration, with two things changed: the files it reads, and the guard on
 * outgoing connections left out. A file that needs the calendar test accounts is handed their
 * place by whoever starts the run (`OHCAL_TEST_ACCOUNTS_FILE`) and reads it through
 * `test/support/calendar-test-accounts.ts` alone; it prints statuses and counts and nothing else.
 *
 * The bench's own two programs under `test/support` are named `*.live.ts` as well and are no test
 * files: they are run with node and take their verb as an argument.
 */
const EGRESS_GUARD = "./test/setup/no-external-network.ts";
const setupFiles = base.test?.setupFiles ?? [];

export default defineConfig({
  ...base,
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    ...base.test,
    name: "cal-live",
    include: ["packages/cal-providers/test/*.live.ts"],
    setupFiles: (Array.isArray(setupFiles) ? setupFiles : [setupFiles]).filter((file) => file !== EGRESS_GUARD),
  },
});
