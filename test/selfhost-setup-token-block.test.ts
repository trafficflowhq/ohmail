// @services: none — runs the server's print and reads the boot smoke's parser as text
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { printSetupToken } from "../apps/server/src/setup-token.js";

/**
 * THE FIRST-RUN SETUP BLOCK IS READ BY MACHINES AS WELL AS PEOPLE. The self-host boot smoke finds the
 * token in `docker compose logs api` by its shape (a line holding FIRST-RUN SETUP, then a line of 16 or
 * more token characters four or more spaces in, within a window), the Umbrel guide greps six lines after
 * the marker, and a reader of the log ends the block at the first line that starts with the fence. So
 * the words may change and the shape may not: this runs the smoke's own pattern, read out of
 * `deploy/selfhost/boot-smoke.mjs`, over what the server prints, and finds the token once.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SMOKE = readFileSync(join(ROOT, "deploy/selfhost/boot-smoke.mjs"), "utf8");

/** The smoke's three pieces, as it writes them; the test fails if they cannot be found. */
function smokeParser(): (log: string) => string[] {
  const prefix = /\.map\(\(l\) => l\.replace\(\/(.+?)\/, ""\)\)/.exec(SMOKE);
  const marker = /if \(!lines\[i\]\.includes\("([^"]+)"\)\) continue;/.exec(SMOKE);
  const window = /Math\.min\(i \+ (\d+), lines\.length\)/.exec(SMOKE);
  const line = /const m = \/(.+?)\/\.exec\(lines\[j\]\);/.exec(SMOKE);
  expect([prefix, marker, window, line], "the boot smoke's token reader moved: point this test at it").not.toContain(null);
  const strip = new RegExp(prefix![1]!);
  const tokenLine = new RegExp(line![1]!);
  const span = Number(window![1]);
  return (log) => {
    const lines = log.replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((l) => l.replace(strip, ""));
    const found: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]!.includes(marker![1]!)) continue;
      for (let j = i; j < Math.min(i + span, lines.length); j++) {
        const m = tokenLine.exec(lines[j]!);
        if (m) found.push(m[1]!);
      }
    }
    return found;
  };
}

/** Stand-ins of the real shape: 43 base64url characters, with `-` and `_`, one starting with `-`. */
const standIn = (head: string, tail: string): string => [head, "c7LpD0HsJf2GaE9uQ4oViN6x", tail].join("_");
const TOKEN = standIn("k3TqZ8mW-1RbX5n", "rA");
const DASHED = standIn("-3TqZ8mWv1RbX5n", "rB");
const block = (token: string): string[] => {
  const lines: string[] = [];
  printSetupToken({ id: "x", token, grant: "invite", label: "first-run setup", expiresAt: new Date("2026-11-17T09:05:00.000Z") }, (l) => lines.push(l));
  return lines;
};

describe("the first-run setup block", () => {
  it("the boot smoke's own reader finds the token once, bare, behind compose's prefix, and the last of two", () => {
    const read = smokeParser();
    for (const token of [TOKEN, DASHED]) {
      expect(read(block(token).join("\n")), token).toEqual([token]);
      expect(read(block(token).map((l) => `api-1  | ${l}`).join("\n")), token).toEqual([token]);
    }
    const two = read([...block(DASHED), ...block(TOKEN)].map((l) => `api-1  | ${l}`).join("\n"));
    expect(two.at(-1)).toBe(TOKEN);
  });

  it("keeps its shape: the marker once, the token alone six spaces in five lines below it, no other token-shaped line", () => {
    const lines = block(TOKEN);
    const marker = lines.findIndex((l) => l.includes("FIRST-RUN SETUP"));
    expect(lines.filter((l) => l.includes("FIRST-RUN SETUP"))).toHaveLength(1);
    expect(lines[marker]).toBe("  FIRST-RUN SETUP");
    expect(lines[marker + 5]).toBe(`      ${TOKEN}`);
    expect(lines.join("\n").split(TOKEN)).toHaveLength(2);
    expect(lines.filter((l) => /^\s{4,}[A-Za-z0-9_-]{16,}\s*$/.test(l))).toEqual([`      ${TOKEN}`]);
    expect(lines.filter((l) => /^ {4,}/.test(l))).toEqual([`      ${TOKEN}`]);
    for (const l of lines) expect(l, "no pipe, tab or escape a log shipper would read").not.toMatch(/[|\t\x1b]/);
  });

  it("is fenced at column 0 on both sides, and nothing between the marker and the token starts like a fence", () => {
    const lines = block(TOKEN);
    const fences = lines.map((l, i) => [l, i] as const).filter(([l]) => l.startsWith("──")).map(([, i]) => i);
    const marker = lines.findIndex((l) => l.includes("FIRST-RUN SETUP"));
    const token = lines.indexOf(`      ${TOKEN}`);
    expect(fences).toHaveLength(2);
    expect(lines[fences[0]!]).toBe("─".repeat(70));
    expect(lines[fences[1]!]).toBe("─".repeat(70));
    expect(fences[0]!).toBeLessThan(marker);
    expect(fences[1]!).toBeGreaterThan(token);
    const lastText = lines.map((l, i) => (l.trim() === "" ? -1 : i)).reduce((a, b) => Math.max(a, b), -1);
    expect(fences[1]!).toBe(lastText);
  });

  it("names no address and keeps the guides' first sentence", () => {
    const text = block(TOKEN).join("\n");
    expect(text).toContain("  No account exists on this server yet.");
    expect(text).not.toMatch(/https?:|@|\/\w/);
    expect(text).toContain("2026-11-17T09:05:00.000Z");
  });
});
