/**
 * THE PHONE SHELL'S COPY OF THE RELAY'S ROUTES, ENTRY FOR ENTRY. The shell's HTTP door passes only the
 * routes in `apps/mobile/src/shell/relay-routes.json`, a copy of the relay's allow-list
 * (`packages/api/src/relay-allowlist.ts`) as method and pattern in its order, written by
 * `node scripts/phone-relay-routes.mjs` after `npm run build`, never by hand. The phone's app names no
 * server package, so the copy is held to the list here: read as data, compared entry for entry. A route
 * the relay gains, loses or moves turns this red until the script writes the copy again.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RELAY_ALLOWLIST } from "@trafficflow/api/relay-allowlist";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const routes: unknown = JSON.parse(readFileSync(join(ROOT, "apps/mobile/src/shell/relay-routes.json"), "utf8"));

describe("the phone shell's copy of the relay's routes", () => {
  it("passes what the relay's own list passes, entry for entry", () => {
    expect(routes).toEqual(RELAY_ALLOWLIST.map((s) => `${s.method} ${s.pattern}`));
  });
});
