/**
 * More — everything the desktop rail holds below the mail places.
 *
 * The rail is typographic on desktop: names and counts, no icons. That holds
 * up here too, so this screen is a list of destinations with their real
 * numbers rather than a grid of tiles. The rows themselves are
 * `src/ui/MoreNav.tsx`, shared with the big-screen drawer so the two lists
 * cannot drift. A feature that is not live yet gets a plain sentence, never a
 * control that goes nowhere.
 */
import { View } from "react-native";
import { Copy } from "../../src/copy";
import { useWorld } from "../../src/state/world";
import { Panel, Screen, Scroller, Txt } from "../../src/ui/base";
import { TopBar } from "../../src/ui/chrome";
import { MoreNav } from "../../src/ui/MoreNav";
import { useLocale } from "../../src/i18n/LocaleProvider";

export default function MoreScreen() {
  /* Subscribed to the language, so a switch in Settings redraws this screen instead of
     waiting for the next navigation — see `src/i18n/LocaleProvider.tsx`. */
  useLocale();
  const w = useWorld();

  return (
    <Screen>
      <TopBar />
      <Scroller>
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
                {Copy.phoneBanner(w.mailboxes.organizer.name)}
              </Txt>
              <Txt variant="meta" tone="ink3" style={{ marginTop: 2 }}>
                {w.mailboxes.organizer.stopped
                  ? Copy.phoneBannerStopped(w.mailboxes.organizer.name)
                  : Copy.phoneBannerWhy}
              </Txt>
            </View>
          ) : null}
        </View>

        <Panel style={{ paddingBottom: 8 }}>
          <MoreNav />
        </Panel>
      </Scroller>
    </Screen>
  );
}
