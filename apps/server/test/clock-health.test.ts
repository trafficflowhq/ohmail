import { expect, it, vi } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { SCHEDULED_SEND_EVERY_MS, SCHEDULED_SEND_FIRST_DELAY_MS } from "../src/clocks.js";
import { ownedDbPort } from "../src/deps.js";
import { buildProgram } from "../src/program.js";
import { loadSettings } from "../src/settings.js";
import { PLAIN_ENV, PROCESS_DOOR, env, processInput, recordingLogger } from "./_envs.js";

it("reports when the self-host clock stops beating and logs once when it resumes", async () => {
  const db = await makeTestDb();
  const { logger, lines } = recordingLogger();
  const program = buildProgram(loadSettings(env(PLAIN_ENV), PROCESS_DOOR), processInput(logger));
  program.runtime.db = ownedDbPort(db as unknown as Parameters<typeof ownedDbPort>[0]);
  const pending = Promise.withResolvers<{ sent: number; failed: number; dropped: number }>();
  const drain = vi.spyOn(program.runtime.services.auth, "drainSecurityNotices")
    .mockImplementationOnce(() => pending.promise);
  const read = () => program.dispatch(new Request("http://localhost/health"));
  const finish = () => pending.resolve({ sent: 0, failed: 0, dropped: 0 });
  vi.useFakeTimers();
  const clocks = program.startClocks()!;
  try {
    await vi.advanceTimersByTimeAsync(SCHEDULED_SEND_FIRST_DELAY_MS);
    await vi.waitFor(() => expect(drain).toHaveBeenCalledTimes(1));
    const first = await read();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      clocks: { selfhost_send: { lastBeatAt: expect.any(Number), stalled: false } },
    });

    await vi.advanceTimersByTimeAsync(32 * SCHEDULED_SEND_EVERY_MS);
    const stalled = await read();
    expect(stalled.status).toBe(503);
    expect(await stalled.json()).toMatchObject({ clocks: { selfhost_send: { stalled: true } } });
    expect(drain).toHaveBeenCalledTimes(1);

    finish();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(SCHEDULED_SEND_EVERY_MS);
    await vi.waitFor(() => expect(drain).toHaveBeenCalledTimes(2));
    const recovered = await read();
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ clocks: { selfhost_send: { stalled: false } } });
    expect(lines.filter((line) => line.event === "api_clock_recovered")).toHaveLength(1);
  } finally {
    finish();
    await clocks.stop();
    await program.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});
