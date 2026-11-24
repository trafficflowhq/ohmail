// The controls: every rule is seen refusing a planted violation, on every run. The fixtures of
// tools/plant/controls.json are written into a copy of the tree, the tools run on the planted
// paths only, and each control's rule must fire where it is expected to and stay silent where not.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** A fixture's text: its lines; `{ "repeat": line, "count": n }` writes one line n times, `{n}` counted up. */
export function fixtureText(control) {
  const lines = control.source.flatMap((line) =>
    typeof line === "string"
      ? [line]
      : Array.from({ length: line.count }, (_, i) => line.repeat.replaceAll("{n}", String(i + 1))),
  );
  return lines.join("\n") + "\n";
}

export function plant(copy, controls) {
  for (const control of controls.filter((c) => c.source)) {
    const file = path.join(copy, control.plant);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, fixtureText(control));
  }
}

/**
 * @param {{ id: string, rule?: string | string[], plant: string, expect?: "refused" | "passes" }[]} controls
 * @param {{ path: string, rule: string, line?: number, message?: string }[]} findings what the tools said
 *   about the planted paths
 * @param {string[]} activeRules every rule the configuration switches on
 * @returns {{ records: { id: string, rule: string, plant: string, outcome: "refused" | "passed", line?: number, message?: string }[], refusals: string[] }}
 */
export function judgeControls(controls, findings, activeRules) {
  const refusals = [];
  const records = [];
  for (const control of controls.filter((c) => c.expect)) {
    for (const rule of [control.rule].flat()) {
      const fired = findings.find((f) => f.path === control.plant && f.rule === rule);
      const record = { id: control.id, rule, plant: control.plant };
      if (control.expect === "refused" && fired) {
        records.push({ ...record, outcome: "refused", line: fired.line, message: fired.message });
      } else if (control.expect === "passes" && !fired) records.push({ ...record, outcome: "passed" });
      else if (control.expect === "refused")
        refusals.push(`controls: ${control.id}: ${rule} did not refuse ${control.plant}`);
      else refusals.push(`controls: ${control.id}: ${rule} refused ${control.plant}, which must pass`);
    }
  }
  for (const rule of activeRules) {
    for (const [outcome, what] of [
      ["refused", "no planted violation was refused by it"],
      ["passed", "no clean file was seen passing it"],
    ]) {
      if (!records.some((record) => record.rule === rule && record.outcome === outcome))
        refusals.push(
          `controls: ${rule} is switched on and ${what}; add its control to tools/plant/controls.json`,
        );
    }
  }
  return { records, refusals };
}

/** A rule's name as a file name: `ohmail/package-borders` → `ohmail-package-borders`. */
export const ruleSlug = (rule) => rule.replace(/^@/, "").replace(/[/:]/g, "-");

/** The record of one rule's planted violation, in the shape of docs/invariant-verdicts. */
export function verdictOf(rule, records, { base, recorded }) {
  const of = (outcome) => records.filter((record) => record.rule === rule && record.outcome === outcome);
  return {
    id: rule,
    base,
    recorded,
    command: "node tools/check.mjs --controls",
    arms: of("refused").map((r) => ({ control: r.id, file: r.plant, line: r.line, refused: r.message })),
    green: of("passed").map((r) => ({ control: r.id, file: r.plant })),
  };
}
