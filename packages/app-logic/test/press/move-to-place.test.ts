import { MemoryMirrorStore } from "@ohmail/client-engine";
import type { EngineMessage } from "@ohmail/wire";
import { expect, it, vi } from "vitest";
import { planMoveToPlace } from "../../src/press/move-to-place.js";
import type { MoveContext } from "../../src/press/verb-context.js";

const date = "2026-09-24T09:00:00.000Z";

function letter(id: string): EngineMessage {
  return {
    id,
    accountId: "account",
    mailboxId: "mailbox",
    from: { name: "Shop News", address: "news@shop.example" },
    date,
    folder: "ohmail/Screener",
  } as EngineMessage;
}

async function mailbox() {
  const mirror = new MemoryMirrorStore();
  await mirror.applyChanges(
    ["picked", "held"].map((id, i) => ({
      type: "message",
      op: "create",
      id,
      seq: i + 1,
      updatedAt: date,
      entity: letter(id),
    })),
  );
  const list = vi.spyOn(mirror, "list");
  const entries = vi.spyOn(mirror, "entries");
  const cx = {
    engine: { verbRead: () => mirror },
    rulesTravel: false,
    ownAddresses: [],
    surfaceById: new Map(),
  } as unknown as MoveContext;
  return { cx, list, entries };
}

it("files only the selected letter without listing the mailbox", async () => {
  const { cx, list, entries } = await mailbox();
  const result = planMoveToPlace(cx, "picked", "reads", new Set(["picked"]), undefined, "leave");

  expect(result?.moves.map((move) => move.messageId)).toEqual(["picked"]);
  expect(result?.plan.mutations.map((mutation) => mutation.kind)).toEqual(["rule_create"]);
  expect(list).not.toHaveBeenCalledWith("message");
  expect(entries).not.toHaveBeenCalledWith("message");
});

it("counts all the sender's held letters for a Screener decision", async () => {
  const { cx } = await mailbox();
  const result = planMoveToPlace(cx, "picked", "reads", new Set(["picked"]));

  expect(result?.plan.moved).toBe(2);
  expect(result?.plan.mutations.map((mutation) => mutation.kind)).toEqual(["screener_decide"]);
  expect(result?.moves).toEqual([]);
});
