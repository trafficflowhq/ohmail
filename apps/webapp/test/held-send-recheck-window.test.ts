import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HELD_SEND_RECHECK_MS } from "@ohmail/client-engine";

/**
 * THE WINDOW HAS TWO HOMES AND THEY MUST AGREE. The server keeps looking in the Sent folder for
 * `SEND_UNVERIFIED_RECHECK_MS` (`packages/services/src/send-service.ts`); the Drafts row says "we're
 * checking" inside `HELD_SEND_RECHECK_MS` and "it isn't in your Sent folder" past it. A webapp test
 * cannot import the services package, so the server's constant is read as SOURCE and its arithmetic
 * evaluated — digits and `*` only, so a reworded constant refuses rather than reads as a number.
 */
function serverWindowMs(): number {
  const rel = "packages/services/src/send-service.ts";
  let src: string;
  try { src = readFileSync(resolve(process.cwd(), rel), "utf8"); }
  catch { src = readFileSync(resolve(process.cwd(), "../..", rel), "utf8"); }
  const m = /export const SEND_UNVERIFIED_RECHECK_MS = ([0-9 *]+);/.exec(src);
  if (!m) throw new Error("SEND_UNVERIFIED_RECHECK_MS not found as a product of integers in send-service.ts");
  return m[1]!.split("*").map((t) => Number(t.trim())).reduce((a, b) => a * b, 1);
}

describe("the held-send recheck window", () => {
  it("is the same number on the server and in the client", () => {
    expect(HELD_SEND_RECHECK_MS).toBe(serverWindowMs());
  });
  it("is twenty minutes — the sentence changes when the engine has stopped looking", () => {
    expect(HELD_SEND_RECHECK_MS).toBe(20 * 60 * 1000);
  });
});
