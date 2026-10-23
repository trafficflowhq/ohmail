import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bracketSpan, withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";
import { DE } from "../src/copy.de";
import { EN } from "../src/copy.en";

/**
 * REMOVING THIS PHONE'S OWN MAILBOX NAMES ITS UNSENT DRAFTS FIRST.
 *
 * "Stop and remove" deletes the engine store, and an unsent draft is on no server, so its words
 * went with it on one press. The press now asks first whenever the live session holds unsent
 * drafts, or cannot say; a known zero keeps the single press. A pairing's Forget is unchanged.
 *
 * The handler is EXTRACTED from `app/servers.tsx` and RUN with its closures injected — the
 * `servers-pane-is-never-a-dead-end.test.ts` shape, since this workspace has no React Native
 * renderer. Mutation: make `pressRemove` call `forget()` for any count and §2's first case goes red.
 */

const SRC = readFileSync(fileURLToPath(new URL("../app/servers.tsx", import.meta.url)), "utf8");

function pressRemoveOf(src: string): string {
  const blank = withoutCommentsAndLiterals(src);
  const at = blank.indexOf("const pressRemove = () => {");
  if (at === -1) throw new Error("no `const pressRemove = () => {` in app/servers.tsx");
  const body = bracketSpan(blank, blank.indexOf("{", at), "{", "}");
  if (!body.closed) throw new Error("the handler never closed");
  return `() => {${src.slice(body.start, body.end)}}`;
}

interface Run { forgot: number; asked: Array<{ drafts: number | null }> }

function press(args: { here: boolean; drafts: number | null }): Run {
  const run: Run = { forgot: 0, asked: [] };
  const conn = { unsentDraftsHere: (id: string) => (id === "p-1" ? args.drafts : 0) };
  const make = new Function(
    "here", "conn", "profile", "forget", "setAsking",
    `"use strict"; return (${pressRemoveOf(SRC)});`,
  ) as (...a: unknown[]) => () => void;
  make(
    args.here, conn, { id: "p-1" },
    async () => { run.forgot += 1; },
    (next: { drafts: number | null }) => { run.asked.push(next); },
  )();
  return run;
}

describe("§1 the press, read off the pane", () => {
  it("asks the connection how many unsent drafts the store holds", () => {
    expect(pressRemoveOf(SRC)).toContain("conn.unsentDraftsHere(profile.id)");
  });
  it("the row's verb is that press, and the confirm's danger verb is the forget", () => {
    expect(SRC).toContain("onPress={pressRemove}");
    expect(SRC).toContain("label={Copy.serversStopHereDelete}");
    expect(SRC).toContain("label={Copy.serversStopHereKeep}");
  });
});

describe("§2 the press, run", () => {
  it("unsent drafts on this phone: asks first, deletes nothing", () => {
    expect(press({ here: true, drafts: 2 })).toEqual({ forgot: 0, asked: [{ drafts: 2 }] });
  });
  it("a count it cannot read: asks first too", () => {
    expect(press({ here: true, drafts: null })).toEqual({ forgot: 0, asked: [{ drafts: null }] });
  });
  it("CONTROL: a known zero keeps the single press", () => {
    expect(press({ here: true, drafts: 0 })).toEqual({ forgot: 1, asked: [] });
  });
  it("CONTROL: a pairing's Forget is unchanged — the drafts are on its server", () => {
    expect(press({ here: false, drafts: 3 })).toEqual({ forgot: 1, asked: [] });
  });
});

describe("§3 the sentence", () => {
  it("names the count, says no server has them, in English and German", () => {
    expect(EN.serversStopHereDrafts(2)).toContain("2 unsent drafts");
    expect(EN.serversStopHereDrafts(1)).toContain("the unsent draft");
    expect(EN.serversStopHereDraftsUnknown).toContain("any unsent drafts");
    for (const said of [EN.serversStopHereDrafts(1), EN.serversStopHereDrafts(2), EN.serversStopHereDraftsUnknown]) {
      expect(said).toContain("No mail server");
    }
    for (const said of [DE.serversStopHereDrafts(1), DE.serversStopHereDrafts(2), DE.serversStopHereDraftsUnknown]) {
      expect(said).toContain("Kein Mailserver");
    }
    expect(DE.serversStopHereDrafts(2)).toContain("2 nicht gesendeten");
  });
});
