#!/usr/bin/env node
/**
 * assert-variant.mjs — IS THIS APK THE APP IT SAYS IT IS.
 *
 *   node apps/mobile/scripts/assert-variant.mjs <apk> <variant>
 *
 * Reads the built APK's manifest and holds it to its row of `variants.json`: the package is the row's identifier,
 * the switch's door is guarded by the row's signature permission, its provider stands at the row's authority, and an
 * app that carries no mail push and organizes
 * no mailbox (the calendar's) declares neither the organizer's service and its data-sync grant nor the push
 * connector's service. The binary manifest keeps its strings in a pool, so each is searched for as bytes in both
 * encodings that pool may use (as `.github/scripts/assert-no-fcm.sh` reads it). Exit 0 with one line per check,
 * 1 on any miss, 2 on a usage fault.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const VARIANTS = JSON.parse(readFileSync(new URL("../variants.json", import.meta.url), "utf8"));

/** What only an app that organizes a mailbox and wakes by push may declare. */
export const ORGANIZER_AND_PUSH = [
  "android.permission.FOREGROUND_SERVICE_DATA_SYNC",
  "app.ohmail.organizer.OrganizerService",
  "dev.djara.expounifiedpush.ExpoUPService",
  "org.unifiedpush.android.connector.PUSH_EVENT",
];

/** The switch's door, as every app declares it: `<identifier>.SwitchOpen`, guarded by the pair's signature permission. */
export const aliasOf = (id) => `${id}.SwitchOpen`;

/** The switch's provider, which answers the sibling's one question at the row's authority. */
export const SWITCH_PROVIDER = "app.ohmail.appswitch.SwitchProvider";

const carries = (bytes, text) => bytes.includes(Buffer.from(text, "utf8")) || bytes.includes(Buffer.from(text, "utf16le"));

/** Each check of one manifest against one row: `[ok, line]`. */
export function judgeManifest(bytes, variant, { withSwitch = true } = {}) {
  const row = VARIANTS[variant];
  if (row === undefined) throw new Error(`assert-variant: "${variant}" is no row of variants.json`);
  const checks = [[carries(bytes, row.id), `package ${row.id}`]];
  if (withSwitch) {
    checks.push([carries(bytes, row.permission), `the switch's permission ${row.permission}`]);
    checks.push([carries(bytes, ".SwitchOpen"), "the switch's door .SwitchOpen"]);
    checks.push([carries(bytes, VARIANTS[row.sibling].id), `the sibling ${VARIANTS[row.sibling].id} named`]);
    checks.push([carries(bytes, SWITCH_PROVIDER), `the switch's provider ${SWITCH_PROVIDER}`]);
    checks.push([carries(bytes, row.authority), `the provider's authority ${row.authority}`]);
  }
  if (!row.carries.organizes || !row.carries.mailPush) {
    for (const name of ORGANIZER_AND_PUSH) checks.push([!carries(bytes, name), `no ${name}`]);
  }
  return checks;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [apk, variant] = process.argv.slice(2);
  if (!apk || !variant) {
    console.error("usage: assert-variant.mjs <apk> <variant>");
    process.exit(2);
  }
  const bytes = execFileSync("unzip", ["-p", apk, "AndroidManifest.xml"], { maxBuffer: 64 * 1024 * 1024 });
  const checks = judgeManifest(bytes, variant);
  for (const [ok, line] of checks) console.log(`${ok ? "OK  " : "MISS"} ${line}`);
  process.exit(checks.every(([ok]) => ok) ? 0 : 1);
}
