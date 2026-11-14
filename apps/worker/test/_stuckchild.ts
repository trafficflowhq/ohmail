/**
 * THE CHILD PROCESS OF `cli.smoke.test.ts`'s stuck case: the deployed CLI (`runWorkerCli`, with its
 * crash handlers, its `loadConfig` and its fatal hook) over a mail server that never answers a turn.
 * The mailbox is named on the command line; the database and the key ring come from the environment,
 * as a host supplies them. Nothing here asserts: the parent reads the exit code and the log.
 */
import { runWorkerCli } from "../src/index.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

const fleet = new FakeAdapterFleet();
fleet.behave(process.argv[2] ?? "", { syncGate: new Promise<void>(() => { /* never */ }) });

void runWorkerCli({
  configure: (config) => ({ ...config, adapterFactory: fleet.factory, stuckCycleMaxMs: 1_500, lockHeartbeatMs: 200 }),
});
