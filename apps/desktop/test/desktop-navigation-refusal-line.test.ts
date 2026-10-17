/**
 * THE NAVIGATION GUARD'S LINE, THROUGH THE DIAGNOSTIC FILE'S GATE. The shell writes one JSON line
 * per refused navigation (`src-tauri/src/navigation.rs`): the scheme's class and the host's, never
 * the address. Its keys are read out of the Rust source and each must be a label the scrub keeps,
 * or a diagnostic file would say that a navigation was refused and not what kind.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_LABEL_FIELDS, scrubLogLine } from "@trafficflow/core/diagnostics";

const SOURCE = readFileSync(new URL("../src-tauri/src/navigation.rs", import.meta.url), "utf8");
const ids = (_domain: "mailbox" | "account", id: string) => id;

/** The keys `refusal_line` writes, in order, read out of its format string. */
function lineKeys(): string[] {
  const at = SOURCE.indexOf('\\"event\\":\\"navigation_refused\\"');
  expect(at, "refusal_line's format string moved").toBeGreaterThan(0);
  const text = SOURCE.slice(SOURCE.lastIndexOf('"{{', at), SOURCE.indexOf('}}"', at));
  return [...text.matchAll(/\\"([A-Za-z]+)\\":/g)].map((m) => m[1]!);
}

describe("the shell's navigation refusal line in a diagnostic file", () => {
  it("writes service, event and two labels, and the scrub keeps both labels", () => {
    const keys = lineKeys();
    expect(keys).toEqual(["service", "event", "scheme", "hostClass"]);
    for (const key of keys.slice(2)) expect(DIAGNOSTIC_LABEL_FIELDS, key).toContain(key);
    const line = '{"service":"shell","event":"navigation_refused","scheme":"https","hostClass":"public"}';
    expect(scrubLogLine(line, ids)).toMatchObject({
      shape: "event",
      service: "shell",
      event: "navigation_refused",
      labels: { scheme: "https", hostClass: "public" },
    });
  });

  it("an address under either label is not copied: the label grammar takes no dot and no slash", () => {
    const line =
      '{"service":"shell","event":"navigation_refused","scheme":"https://evil.example/x","hostClass":"evil.example"}';
    const entry = scrubLogLine(line, ids);
    expect(entry.shape === "event" ? entry.labels : null).toEqual({});
  });
});
