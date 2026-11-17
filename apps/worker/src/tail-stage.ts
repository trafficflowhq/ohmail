import { asDatabaseFault, isShardConnectionFault } from "./db-fault.js";
import { DatabaseFaultError } from "@ohmail/organizer/dead-letter";

/** `database`: the pass talks only to our database, so its throw is tagged as ours. `mixed`: it also
 *  talks to a remote (a model, the entitlements program, object storage) and tags its own db calls. */
export type TailOrigin = "database" | "mixed";

export interface TailStageRunner {
  /** Run one stage; a throw is announced as the shard's when it is a connection fault, then `failed`. */
  runTailStage(op: string, origin: TailOrigin, pass: () => Promise<unknown>, failed: (err: unknown) => void): Promise<void>;
  /** The hook for a catch INSIDE a database-only pass that goes on past one unit's failure. */
  tailFaultNote(op: string): (err: unknown) => void;
}

/**
 * ONE RUNNER FOR EVERY CYCLE-TAIL STAGE. A stage's catch may swallow its own failure, never the
 * shard's: a connection fault is announced BEFORE the stage's line, so `/health` and the pager see a
 * database that refuses wherever the tail met it. Only connection faults announce
 * ({@link isShardConnectionFault}); a statement or lock timeout on one account stays that stage's.
 * `test/tail-stage-runner-census.test.ts` holds every tail catch to this runner.
 */
export function tailStageRunner(announce: (err: unknown) => void): TailStageRunner {
  const note = (err: unknown): void => { if (isShardConnectionFault(err)) announce(err); };
  return {
    async runTailStage(op, origin, pass, failed) {
      try {
        await (origin === "database" ? asDatabaseFault(op, pass) : pass());
      } catch (err) {
        // Contained by design: the shard hears a connection fault, the stage logs its own line.
        note(err);
        failed(err);
      }
    },
    tailFaultNote: (op) => (err) => {
      note(err instanceof DatabaseFaultError ? err : new DatabaseFaultError(op, err));
    },
  };
}
