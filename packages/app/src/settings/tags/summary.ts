import { atStamp } from "@ohmail/app-logic/engine";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useEngineOrNull } from "@ohmail/app-logic/engine/context";
import { usePresentedMirror } from "@ohmail/app-logic/reading";
import { useLocale, useText } from "../../text/index.js";
import type { PaneSummary } from "../contract.js";

interface SummaryTag {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

const stop = () => {};
function tagDate(tag: SummaryTag): number {
  const time = Date.parse(tag.createdAt);
  return Number.isNaN(time) ? -Infinity : time;
}

/** Read the same local tag catalog as the Tags rail, without counting messages in the mirror. */
export function useTagSummary(): PaneSummary | null {
  const availableEngine = useEngineOrNull();
  const mirror = usePresentedMirror();
  const engine = mirror === null ? null : availableEngine;
  const locale = useLocale();
  const t = useText("settings");
  const subscribe = useCallback((notify: () => void) => engine?.subscribe(notify) ?? stop, [engine]);
  const version = useSyncExternalStore(
    subscribe,
    () => engine?.read().stampOf("tag") ?? 0,
    () => 0,
  );
  const tags = useMemo(
    () =>
      atStamp(
        version,
        engine
          ?.read()
          .list<SummaryTag>("tag")
          .sort((a, b) => tagDate(a) - tagDate(b) || a.id.localeCompare(b.id)),
      ),
    [engine, version],
  );
  if (!tags) return null;
  if (tags.length === 0) return { detail: t("tagsNone") };
  return {
    count: new Intl.NumberFormat(locale).format(tags.length),
    detail: tags.map((tag) => tag.name).join(" · "),
  };
}
