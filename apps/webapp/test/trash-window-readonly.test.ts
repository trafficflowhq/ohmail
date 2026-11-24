/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * READ-ONLY BY CONSTRUCTION — the live Trash window's defining property, measured at the door.
 *
 * The window shows mail the mirror has never held, and it must never change it: there is no
 * restore for a message whose origin folder nobody recorded, so ohmail choosing one would be
 * ohmail filing somebody else's mail. The server half carries the same argument and counts the
 * mirror tables around every read (`packages/api/src/trash-window.ts`, `trash-window.test.ts`).
 *
 * This file is the client half of that: the door's methods over a fetch double, the door's key
 * set, and the absence of any second transport. NO MODULE MOCK here on purpose — the real
 * `api()` runs, so what is asserted is what would go on the wire.
 *
 * MUTATIONS WATCHED (recorded in the lane's report): `{ method: "POST" }` on either read reddens
 * the first case; a third door key reddens the second; a bare `fetch()` in the hook reddens the
 * third.
 */

process.env.NEXT_PUBLIC_API_BASE = "/api";

const read = (p: string): string =>
  readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

describe("the live Trash path issues no mutation", () => {
  it("the door is GET and only GET, over a fetch that records every method", async () => {
    const { trashWindow } = await import("../app/api-client");
    const methods: Array<string | undefined> = [];
    const paths: string[] = [];
    const bodies: Array<string | null> = [];
    const fake = vi.fn(async (url: string, init?: RequestInit) => {
      paths.push(url);
      methods.push(init?.method);
      bodies.push(init?.body === undefined ? null : String(init.body));
      return new Response(JSON.stringify({ mailboxes: [], items: [], nextCursor: null }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    });
    const had = globalThis.fetch;
    globalThis.fetch = fake as unknown as typeof fetch;
    try {
      await trashWindow.list();
      await trashWindow.list({ cursor: "c1" });
      await trashWindow.body("mb1", 7, "77");
    } finally {
      globalThis.fetch = had;
    }
    expect(methods).toEqual(["GET", "GET", "GET"]);
    // No request body either — a GET carrying one would be a write wearing a read's verb.
    expect(bodies).toEqual([null, null, null]);
    expect(paths).toEqual([
      "/api/trash/window",
      "/api/trash/window?cursor=c1",
      "/api/trash/window/body?mailboxId=mb1&uid=7&uidValidity=77",
    ]);
  });

  it("the door offers exactly two calls, and neither names a method", () => {
    /* A third key here would be a verb nobody ruled. The server half serves three GETs and no
       verb at all; the client binds the two the view reads. */
    const src = read("../app/api-client.ts");
    const from = src.indexOf("export const trashWindow = {");
    expect(from).toBeGreaterThan(0);
    const door = src.slice(from, src.indexOf("\n};", from));
    expect(door).not.toMatch(/method:/);
    expect([...door.matchAll(/^  (\w+):/gm)].map((m) => m[1])).toEqual(["list", "body"]);
  });

  it("the control type carries no verb, and the hook opens no second fetch door", () => {
    const src = read("../../../packages/app-logic/src/trash/live-window.ts");
    /* A SECOND FETCH PATH is the hard stop: every byte this window reads comes through the one
       API door, so this module names no transport of its own. */
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/new XMLHttpRequest/);
    const start = src.indexOf("export interface TrashWindowControl {");
    const end = src.indexOf("\n}", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const iface = src.slice(start, end);
    for (const verb of ["restore", "rescue", "delete", "move", "mutate", "purge"]) {
      expect(iface, `the control must offer no ${verb}`).not.toContain(`${verb}:`);
    }
    // A positive control on the same slice: the reads it DOES offer are named there.
    for (const reader of ["items", "mailboxes", "nextCursor", "bodyFor", "openBody"]) {
      expect(iface).toContain(`${reader}:`);
    }
  });
});
