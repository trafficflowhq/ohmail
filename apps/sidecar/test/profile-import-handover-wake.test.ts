import { describe, expect, it } from "vitest";
import type { Route } from "@trafficflow/api/local";
import { withImportHandover } from "../src/engine.js";

/**
 * THE LOCAL DOOR WAKES ITS ORGANIZER ON A HANDED-OVER PRESS. The shared confirm route records
 * the ask and rings `sync_requested_at`, which only the hosted worker reads; the desktop's and the
 * phone's organizer is this process, idling up to its poll ceiling. So a 202 — and only a 202 —
 * starts one drain, whose tail runs the ask. Driven with a stub route, so every answer is reachable.
 */
describe("withImportHandover", () => {
  const answered = (status: number): Route => ({
    method: "POST",
    pattern: "/mailboxes/:id/profile-import",
    cost: "connection",
    relay: true,
    handler: async () => new Response("{}", { status, headers: { "content-type": "application/json" } }),
  });

  it("a 202 starts one drain for that mailbox; a 200 or a refusal starts none", async () => {
    const woke: Array<{ id: string; cycles: number | undefined }> = [];
    const runtimeFor = (id: string) => ({ syncUntilQuiet: async (cycles?: number) => { woke.push({ id, cycles }); return 0; } });
    const drive = async (status: number): Promise<number> => {
      const [wrapped] = withImportHandover([answered(status)], runtimeFor);
      const res = await wrapped!.handler(
        new Request("http://local/mailboxes/mbx-1/profile-import", { method: "POST" }), {} as never, { id: "mbx-1" },
      );
      return res.status;
    };
    expect(await drive(202)).toBe(202);
    expect(woke).toEqual([{ id: "mbx-1", cycles: 1 }]);
    for (const status of [200, 409, 502]) expect(await drive(status)).toBe(status);
    expect(woke, "a press that was answered, or refused, woke the organizer").toHaveLength(1);
  });

  it("wraps the confirm route alone; every other route passes through untouched", () => {
    const other = { ...answered(202), pattern: "/mailboxes/:id/profile-import/decline" } as Route;
    const [same] = withImportHandover([other], () => undefined);
    expect(same).toBe(other);
  });
});
