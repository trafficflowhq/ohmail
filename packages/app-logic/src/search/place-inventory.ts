import {
  folderLeaf,
  VIEW_OF_FOLDER,
  type OhmailEngine,
  type SessionRenewalDoor,
} from "@ohmail/client-engine";
import type { EngineMessage, SearchPlaceCount } from "@ohmail/wire";
import { useEffect, useMemo, useState } from "react";

type InventoryEngine = Pick<OhmailEngine, "read" | "searchPlaces">;
type InventoryScope = string | null | false;

/** The store's facet for a folder path: a view id, or the leaf. */
export const folderKeyOf = (folder: string): string =>
  (VIEW_OF_FOLDER as Record<string, string | undefined>)[folder] ?? folderLeaf(folder);

/** The Place picker reads one inventory per engine and account, with the device mirror offline. */
export function useSearchPlaceInventory(
  engine: InventoryEngine | null,
  scope: InventoryScope,
  enabled = true,
  renewal: Pick<SessionRenewalDoor, "onRenewed"> | null = null,
) {
  const [answer, setAnswer] = useState<{
    engine: InventoryEngine;
    scope: InventoryScope;
    places: readonly SearchPlaceCount[];
  }>();
  const serverPlaces = answer?.engine === engine && answer.scope === scope ? answer.places : null;
  useEffect(() => {
    if (!engine || !enabled || scope === false || serverPlaces !== null) return;
    let current = true;
    let reading = false;
    let queued = false;
    let known = false;
    const read = () => {
      if (!current || known) return;
      if (reading) {
        queued = true;
        return;
      }
      reading = true;
      queued = false;
      void engine.searchPlaces().then((places) => {
        reading = false;
        if (!current) return;
        if (places !== null) {
          known = true;
          setAnswer({ engine, scope, places });
        } else if (queued) read();
      });
    };
    const stop = renewal?.onRenewed(read);
    read();
    return () => {
      current = false;
      stop?.();
    };
  }, [engine, scope, enabled, renewal, serverPlaces]);
  const messageStamp =
    enabled && engine !== null && serverPlaces === null ? engine.read().stampOf("message") : 0;
  return useMemo(() => {
    if (!enabled || !engine) return [];
    const counts =
      serverPlaces === null
        ? mirrorPlaces(engine, messageStamp)
        : new Map(serverPlaces.map(({ folder, count }) => [folder, count]));
    return folderPicks([...counts.keys()]).map((pick) => ({
      pick,
      label: pick.key,
      count: counts.get(pick.raw)!,
    }));
  }, [enabled, engine, messageStamp, serverPlaces]);
}

function mirrorPlaces(engine: InventoryEngine, _messageStamp: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { folder } of engine.read().list<EngineMessage>("message")) {
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  return new Map([...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)));
}

/** Use the display leaf unless two different paths would have the same name. */
export function folderPicks(paths: readonly string[]): { group: "folder"; key: string; raw: string }[] {
  const keys = new Map<string, number>();
  for (const path of paths) {
    const key = folderKeyOf(path);
    keys.set(key, (keys.get(key) ?? 0) + 1);
  }
  return paths.map((raw) => {
    const key = folderKeyOf(raw);
    return { group: "folder", key: keys.get(key) === 1 ? key : raw, raw };
  });
}
