import { useCallback, useLayoutEffect, useMemo, useReducer } from "react";
import { isPending, settledPhase, type SavedRow } from "./model.js";
import type { ProfileImportAppliedWire, ProfileImportTransport } from "./wire.js";

type SavedVerb = "import" | "replace";

type SavedRowPhase =
  | { kind: "idle" }
  | { kind: "busy"; verb: SavedVerb }
  | { kind: "importing"; fingerprint: string; reason: "slow" | "unreachable" | null }
  | { kind: "failed"; message: string | null }
  | { kind: "imported"; applied: ProfileImportAppliedWire }
  | { kind: "replaced" };

export interface SavedProfileActions {
  phaseOf(row: SavedRow): SavedRowPhase;
  press(row: SavedRow, verb: SavedVerb): void;
  /** One read, driven by the mounted recovery row. A response can still settle after leaving it. */
  readStatus(row: SavedRow): Promise<void>;
}

const IDLE: SavedRowPhase = { kind: "idle" };
const copyKey = (row: SavedRow): string => JSON.stringify([row.mailboxId, row.candidate.fingerprint]);

/** A decision follows this copy until the account or its engine changes. */
export function useSavedProfileActions(
  wire: ProfileImportTransport | null,
  owner: object | null = wire,
): SavedProfileActions {
  const scope = useMemo(
    () => ({
      owner,
      wire,
      phases: new Map<string, SavedRowPhase>(),
      reading: new Set<string>(),
      live: false,
    }),
    [wire, owner],
  );
  const [, redraw] = useReducer((version: number) => version + 1, 0);
  useLayoutEffect(() => {
    scope.live = true;
    return () => {
      scope.live = false;
    };
  }, [scope]);

  const set = useCallback(
    (key: string, phase: SavedRowPhase) => {
      if (!scope.live) return;
      scope.phases.set(key, phase);
      redraw();
    },
    [scope],
  );

  const readStatus = useCallback(
    async (row: SavedRow) => {
      const wire = scope.wire;
      const key = copyKey(row);
      const phase = scope.phases.get(key);
      if (wire === null || !scope.live || phase?.kind !== "importing" || scope.reading.has(key)) return;
      scope.reading.add(key);
      try {
        const status = await wire.status(row.mailboxId, phase.fingerprint);
        const next = settledPhase(status);
        if (next === null || scope.phases.get(key) !== phase) return;
        set(
          key,
          next.kind === "done"
            ? { kind: "imported", applied: next.applied }
            : { kind: "failed", message: next.kind === "failed" ? next.message : null },
        );
      } catch {
        // The organizer still owns the pending import. The mounted row can ask again.
      } finally {
        scope.reading.delete(key);
      }
    },
    [scope, set],
  );

  const press = useCallback(
    (row: SavedRow, verb: SavedVerb) => {
      const wire = scope.wire;
      if (wire === null || !scope.live) return;
      const { mailboxId, candidate } = row;
      const key = copyKey(row);
      const before = scope.phases.get(key);
      if (before !== undefined && before.kind !== "failed") return;
      set(key, { kind: "busy", verb });
      void (async () => {
        try {
          if (verb === "replace") {
            await wire.replace(mailboxId, candidate.fingerprint);
            set(key, { kind: "replaced" });
            return;
          }
          const applied = await wire.apply(
            mailboxId,
            candidate.fingerprint,
            candidate.counts.signatureReplaces,
          );
          if (!isPending(applied)) {
            set(key, { kind: "imported", applied });
            return;
          }
          set(key, { kind: "importing", fingerprint: applied.fingerprint, reason: applied.reason ?? null });
        } catch (error) {
          set(key, {
            kind: "failed",
            message: error instanceof Error && error.message.length > 0 ? error.message : null,
          });
        }
      })();
    },
    [scope, set],
  );

  return { phaseOf: (row) => scope.phases.get(copyKey(row)) ?? IDLE, press, readStatus };
}
