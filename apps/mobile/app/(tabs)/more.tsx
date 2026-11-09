/**
 * More — everything the desktop rail holds below the mail places.
 *
 * The rail is typographic on desktop: names and counts, no icons. That holds
 * up here too, so this screen is a list of destinations with their real
 * numbers rather than a grid of tiles. The rows themselves are
 * `src/ui/MoreNav.tsx`, shared with the big-screen drawer so the two lists
 * cannot drift. A feature that is not live yet gets a plain sentence, never a
 * control that goes nowhere. On two panes it is a pair like the mail lists: the rows beside the
 * destination one opened (the `open` param, a `pane-routes` key), never a window-wide list.
 */
import { useSyncExternalStore } from "react";
import { View } from "react-native";
import { router, useNavigation } from "expo-router";
import { Copy } from "../../src/copy";
import { useWorld, type World } from "../../src/state/world";
import { foldedNow, subscribeFolded } from "../../src/ui/nav-fold";
import { phoneBannerLines } from "../../src/state/live";
import { Panel, Rule, Screen, Scroller, Txt } from "../../src/ui/base";
import { TopBar } from "../../src/ui/chrome";
import { MoreNav, Nav } from "../../src/ui/MoreNav";
import { useLocale } from "../../src/i18n/LocaleProvider";
import { SurfaceBoundary } from "../../src/ui/ErrorBoundary";
import { ListDetail, useListDetail } from "../../src/ui/list-detail";
import { askBeforePaneLeave, MorePickContext } from "../../src/ui/more-pane";
import { morePathOf } from "../../src/ui/pane-routes";
import AwayScreen from "../away";
import DraftsScreen from "../drafts/index";
import FolderScreen from "../folder/[id]";
import HistoryScreen from "../history";
import ScheduledScreen from "../scheduled";
import SearchScreen from "../search";
import ServersScreen from "../servers";
import SettingsScreen from "../settings";
import TagScreen from "../tag/[id]";
import TrashScreen from "../trash/index";
import TriageScreen from "../triage";

export default function MoreScreen() {
  return (
    <SurfaceBoundary surface="more">
      <MoreBody />
    </SurfaceBoundary>
  );
}

function MoreBody() {
  /* Subscribed to the language, so a switch in Settings redraws this screen instead of
     waiting for the next navigation — see `src/i18n/LocaleProvider.tsx`. */
  useLocale();
  const w = useWorld();
  const folded = useSyncExternalStore(subscribeFolded, foldedNow);
  const { open: param, close, twoPane } = useListDetail(toRoute);
  const open = param !== null && morePathOf(param) !== null ? param : null;
  const navigation = useNavigation<{ setParams(p: { open: string }): void }>();
  /* A pick is a param change, so an unsaved edit in the pane is asked about here (`more-pane`). */
  const pick = (key: string) => {
    if (key !== open) askBeforePaneLeave(() => navigation.setParams({ open: key }));
  };

  const list = (
    <Screen>
      <TopBar />
      <Scroller avoidKeyboard>
        {/* The header names whose mail this is: the paired server and account. */}
        <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 14 }}>
          <Txt variant="h1" numberOfLines={1}>{w.account.name}</Txt>
          <Txt variant="meta" tone="ink3" style={{ marginTop: 4 }} numberOfLines={1}>
            {w.account.email}
          </Txt>
          {/* ── WHO ORGANIZES THIS MAILBOX ──────────────────────────────────────────────────
              Under the account it is about, because that is the question it answers: this
              phone reads, and the decisions it takes are carried out on the machine named
              here. Drawn only when the server has ANSWERED (`mailboxes.known`) and names one
              holder for every mailbox — `live.ts#phoneOrganizer` has the two cases that are
              deliberately silence, and a phone that has not asked yet says nothing at all. */}
          {w.mailboxes.organizer ? (
            <View style={{ marginTop: 10 }}>
              <Txt variant="meta" numberOfLines={2}>
                {phoneBannerLines(w.mailboxes.organizer).head}
              </Txt>
              <Txt variant="meta" tone="ink3" style={{ marginTop: 2 }}>
                {phoneBannerLines(w.mailboxes.organizer).why}
              </Txt>
            </View>
          ) : null}
        </View>

        {/* WHAT THE DOCK OR THE RAIL FOLDED, reachable here: the same fold result, so "into
            More" is never "gone". It heads the one card, above the piles, never a card of its
            own (one folded destination stood as a lone one-row card). Absent while nothing folded. */}
        <Panel style={{ paddingTop: folded.length > 0 ? 8 : 0, paddingBottom: 8 }}>
          {folded.map((id) => {
            const d = FOLDABLE[id];
            if (!d) return null;
            return <Nav key={id} label={d.label()} count={d.count(w)} onPress={() => router.navigate(d.path)} />;
          })}
          {folded.length > 0 ? <Rule inset={20} /> : null}
          <MoreNav selected={twoPane ? open : null} onPick={twoPane ? pick : undefined} />
        </Panel>
      </Scroller>
    </Screen>
  );

  return (
    <MorePickContext.Provider value={twoPane ? pick : null}>
      <ListDetail
        open={open}
        onClose={() => askBeforePaneLeave(close)}
        toRoute={toRoute}
        list={list}
        renderDetail={(key) => <MoreDestination paneKey={key} />}
      />
    </MorePickContext.Provider>
  );
}

const toRoute = (key: string) => morePathOf(key) ?? "/more";

/** The destination a key names, drawn for More's pane: no bar of its own, its params given. */
function MoreDestination({ paneKey }: { paneKey: string }) {
  const at = paneKey.indexOf(":");
  const head = at < 0 ? paneKey : paneKey.slice(0, at);
  const arg = at < 0 ? undefined : paneKey.slice(at + 1);
  switch (head) {
    case "settings": return <SettingsScreen inPane />;
    case "history": return <HistoryScreen inPane />;
    case "search": return <SearchScreen inPane />;
    case "triage": return <TriageScreen inPane pile={arg} />;
    case "drafts": return <DraftsScreen inPane />;
    case "trash": return <TrashScreen inPane />;
    case "away": return <AwayScreen inPane />;
    case "servers": return <ServersScreen inPane />;
    case "scheduled": return <ScheduledScreen inPane />;
    case "tag": return <TagScreen inPane id={arg} />;
    case "folder": return <FolderScreen inPane id={arg} />;
    default: return null;
  }
}

/** The destinations the dock and the rail can fold, with the counts their buttons carry. */
const FOLDABLE: Record<string, { path: string; label: () => string; count: (w: World) => number }> = {
  index: { path: "/", label: () => Copy.ohbox, count: (w) => w.ohbox.unread },
  screener: { path: "/screener", label: () => Copy.screener, count: (w) => w.screener.waiting.length },
  reads: { path: "/reads", label: () => Copy.reads, count: (w) => w.reads.newCount },
  receipts: { path: "/receipts", label: () => Copy.receipts, count: (w) => w.receipts.newCount },
};
