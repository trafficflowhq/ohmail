/**
 * A STORE'S UPGRADE UNDER A CONNECT, as the steps that wait on it say it: the mailbox step while its connect runs,
 * and the copy opening.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { PageLinePart } from "@ohmail/ui/base";
import type { PhoneDoor } from "./contract.js";
import { useDoorWords } from "./namespace.js";
import { UPGRADE_SLOW_MS, upgradeOf } from "./states.js";

/** The store's upgrade under a connect, as parts of a page's line; none while nothing upgrades. */
export function useUpgradeLine(door: PhoneDoor): PageLinePart[] {
  const { t } = useDoorWords();
  const state = useSyncExternalStore(door.state.subscribe, door.state.read, door.state.read);
  const [now, setNow] = useState(() => Date.now());
  const line = upgradeOf(state, now);
  const since = state.migrating?.since ?? null;
  const waits = line !== null && !line.slow && since !== null;
  /* The step's own timer, ended with it: the second line joins once the upgrade has run a while. */
  useEffect(() => {
    if (!waits || since === null) return;
    const id = setTimeout(() => setNow(Date.now()), Math.max(0, since + UPGRADE_SLOW_MS - Date.now()));
    return () => clearTimeout(id);
  }, [waits, since]);
  if (line === null) return [];
  const parts: PageLinePart[] = [{ heavy: t(`upgrade.${line.key}`, line.values) }];
  if (line.slow) parts.push({ note: t("upgrade.migratingSlow") });
  return parts;
}
