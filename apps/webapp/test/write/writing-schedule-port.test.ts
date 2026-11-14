import { describe, expect, it } from "vitest";
import { writeBesideOf, SEND_LATER_FLOOR_MS } from "@ohmail/app-logic/writing/writing-of";
import { fileSize } from "../../../../packages/app/src/mail/ground/writing-words.js";
import { engineOver, storeWith } from "../_draft-shell.js";

describe("writeBesideOf", () => {
  it("says the scope it was made for and refuses a time inside the floor", async () => {
    const engine = engineOver(await storeWith([], []), [], { on: false }, { wait: null });
    const online = () => true;
    const beside = writeBesideOf(engine, "acc-1", "strict", true, fileSize, online);
    expect(beside.scope).toBe("acc-1");
    expect(beside.surface).toBe("strict");
    /* What one send may carry is the host's own answer, handed on as the host says it. */
    expect(writeBesideOf(engine, "acc-1", "mailbox", true, fileSize, online).surface).toBe("mailbox");
    expect(writeBesideOf(engine, "acc-1", 4096, true, fileSize, online).surface).toBe(4096);
    const now = Date.parse("2026-09-27T09:00:00.000Z");
    expect(beside.later.floor(now)).toBe(now + SEND_LATER_FLOOR_MS);
    expect(beside.later.options(now).every((o) => Date.parse(o.at) > now + SEND_LATER_FLOOR_MS)).toBe(true);
    expect(beside.lines.split("a@x.invalid, b")).toEqual({ chips: ["a@x.invalid"], tail: "b" });
  });
});
