#!/usr/bin/env node
/**
 * phone-relay-routes.mjs — writes apps/mobile/src/shell/relay-routes.json from the relay's allow-list, as
 * method and pattern in its order, one entry a line. Run after `npm run build` (it reads the built API
 * package). It stands at the root because the phone's app names no server package: the copy is written
 * from here, `test/phone-relay-routes-copy.test.ts` holds the file equal to the list and names any drift,
 * and `apps/mobile/src/shell/relay-routes.ts` gives it its type.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RELAY_ALLOWLIST } from "@trafficflow/api/relay-allowlist";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "mobile", "src", "shell", "relay-routes.json");
const routes = RELAY_ALLOWLIST.map((s) => `${s.method} ${s.pattern}`);
writeFileSync(OUT, `${JSON.stringify(routes, null, 2)}\n`);
console.log(`RELAY_ROUTES ${routes.length} routes`);
