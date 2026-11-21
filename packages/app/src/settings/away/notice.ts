import { useEffect, useSyncExternalStore } from "react";
import { awayEffectivePiles, AWAY_PILE_VIEW, isAwayPile } from "@ohmail/app-logic/away";
import { useDemoMode } from "@ohmail/app-logic/engine";
import { useFrame, type FrameNotice } from "../../frame/index.js";
import { createFeed, NONE, type AwayWire } from "../../host/index.js";
import { useLocale, useText } from "../../text/index.js";

type AwayReading = Awaited<ReturnType<AwayWire["state"]>>;

/** One feed per confirmed account in this tab. A reply to an earlier read cannot undo a save. */
export function awayFeedOver(transport: AwayWire) {
  const current = createFeed<AwayReading | null>(null);
  let serial = 0;
  let installed = 0;
  let started = false;
  let pending: Promise<AwayReading> | null = null;
  function remember(next: AwayReading | null, at: number) {
    if (at < installed) return;
    installed = at;
    current.set(next);
  }
  function initialState(): Promise<AwayReading> {
    if (pending !== null) return pending;
    const reading = wire.state().finally(() => {
      if (pending === reading) pending = null;
    });
    pending = reading;
    return reading;
  }
  const wire: AwayWire = {
    snapshot: current,
    async state() {
      const at = ++serial;
      try {
        const row = await transport.state();
        remember(row, at);
        return row;
      } catch (error) {
        remember(null, at);
        throw error;
      }
    },
    initialState,
    async save(next) {
      const row = await transport.save(next);
      pending = null;
      remember(row, ++serial);
      return row;
    },
  };
  return {
    wire,
    start() {
      if (started) return;
      started = true;
      void initialState().catch(() => undefined);
    },
    read: current.read,
    subscribe: current.subscribe,
  };
}

type AwayFeed = ReturnType<typeof awayFeedOver>;
const noRow = () => null;
const noFeed = () => () => {};

const PILE_WORD = {
  ohbox: "noticePileOhbox",
  reads: "noticePileReads",
  receipts: "noticePileReceipts",
  screener: "noticePileScreener",
} as const;

/** The saved row says who is answered. Settings and this notice share the same wire. */
export function useAwayNotice(feed: AwayFeed | null): readonly FrameNotice[] {
  const demo = useDemoMode();
  const { commands, host } = useFrame();
  const active = !demo && host.capabilities.awayRunsOn !== NONE;
  const locale = useLocale();
  const t = useText("away");
  const row = useSyncExternalStore(feed?.subscribe ?? noFeed, feed?.read ?? noRow, noRow);
  useEffect(() => {
    if (active) feed?.start();
  }, [active, feed]);

  if (!active || !row?.enabled) return [];
  const piles = awayEffectivePiles(row.piles ?? [], row.audience)
    .filter(isAwayPile)
    .map((pile) => t(PILE_WORD[AWAY_PILE_VIEW[pile]]));
  const title =
    piles.length === 0
      ? t("noticeNone")
      : t("notice", {
          audience: row.audience,
          throttle: row.throttle,
          piles: new Intl.ListFormat(locale === "en" ? "en-US" : locale, { type: "disjunction" }).format(
            piles,
          ),
        });
  return [
    {
      kind: "away",
      title,
      acts: [{ label: t("noticeSettings"), onPress: () => commands.go({ place: "settings", sub: "away" }) }],
    },
  ];
}
