/**
 * The destinations below the mail places — the More screen's rows, as a component TWO hosts
 * mount: the More tab (compact) and the big-screen drawer behind the list pane's sidebar
 * toggle (prototype v5: "the destinations live behind the sidebar toggle as a drawer over
 * the list pane"). One list, so the two cannot drift: piles, folders, History, Scheduled,
 * the honest search sentence, Settings and the pairing door. `onNavigate` lets the drawer
 * close itself before the push; the More screen passes nothing.
 */
import { View } from "react-native";
import { router } from "expo-router";
import { Copy } from "../copy";
import { useTheme } from "../theme";
import { useWorld } from "../state/world";
import { Rule, Section, TapRow, Txt } from "./base";
import { FoldersGroup } from "./FoldersGroup";
import { Icon } from "./Icon";

export function MoreNav({ onNavigate }: { onNavigate?: () => void }) {
  const w = useWorld();
  const pileCountOf = (kind: string) => w.piles.find((p) => p.kind === kind)?.items.length ?? 0;
  const go = (path: string) => {
    onNavigate?.();
    router.push(path);
  };

  return (
    <>
      <Section style={{ paddingTop: 16 }}>{Copy.triage}</Section>
      <Nav label={Copy.replyLater} count={pileCountOf("replyLater")} onPress={() => go("/triage")} />
      <Nav label={Copy.setAside} count={pileCountOf("setAside")} onPress={() => go("/triage")} />
      <Nav label={Copy.resurface} count={pileCountOf("resurface")} onPress={() => go("/triage")} />

      {/* THE FOLDERS GROUP — rendered ONLY while the account's "Use folders" flag is on
          (the server's consent answer), so the flag-off screen is the pre-feature screen
          (FOLDERS-SPEC.md §10). The rail's own placement: below the piles, above the
          utility rows — the webapp puts it under Tags, which this screen does not have.
          The stage-2 verbs (spec §18) ride the world's own actions — the engine's
          folder_create/rename/delete family, plus the summary read for the delete
          confirm's server-truth counts. */}
      {w.folders.enabled ? (
        <FoldersGroup
          folders={w.folders.list}
          unread={w.folders.unread}
          onOpen={(id) => go(`/folder/${encodeURIComponent(id)}`)}
          verbs={{
            create: w.actions.folderCreate,
            rename: w.actions.folderRename,
            remove: w.actions.folderDelete,
            dismiss: w.actions.folderDismiss,
            summary: w.folders.summary,
          }}
          soleMailboxId={w.folders.soleCreateMailboxId}
          /* What this list does NOT hold, and where that mail is (JUNK-INVISIBLE). */
          junkSaid={w.folders.junkSaid}
        />
      ) : null}

      <Rule inset={20} />

      {/* HISTORY — where the browser's rail puts it: first of the utility rows, above
          Drafts and Trash and below the piles/folders. NO COUNT, deliberately: History is
          all read by construction (an unread message makes its sender active, so it queues
          in the Screener instead), so a number here would claim attention nothing in it
          wants. Shown unconditionally, unlike Scheduled below — this is a PLACE the mailbox
          always has, and hiding it on zero would be the phone asserting an empty History
          from a mirror that may simply not have synced. */}
      <Nav label={Copy.history} sub={Copy.historyNavSub} onPress={() => go("/history")} chevron />

      {/* DRAFTS — the browser rail's own order puts it directly under History
          and above Trash. Present while the account HOLDS one, and also while the mirror has
          never settled, exactly as Scheduled below: a row hidden on zero would assert "nothing
          half-written" from a database that has simply not synced (unknown ≠ empty,
          `state/surface.ts`). It is not a permanent row on zero, because this app does not write
          drafts and a standing "Drafts 0" would teach a phone-only reader nothing — the moment
          a send here cannot be confirmed the row carries it, which is the state this destination
          exists for. The count is silent while unsettled for the piles' reason. */}
      {!w.boot.settled || w.drafts.length > 0 ? (
        <Nav
          label={Copy.draftsTitle}
          count={w.boot.settled ? w.drafts.length : undefined}
          onPress={() => go("/drafts")}
        />
      ) : null}

      {/* SCHEDULED (Send later, mail 0077) — its own destination, in the rail's idiom.
          Present while the account HOLDS an appointment, and also while the mirror has
          never settled: a row hidden on zero would otherwise assert "nothing scheduled"
          from a database that has simply not synced yet (unknown ≠ empty,
          `state/surface.ts`). Once a drain has completed and the answer is genuinely none,
          the row goes — the composer's own "Send later" is where the feature is
          discovered, and a permanent "Scheduled 0" teaches nothing. The count is silent
          while unsettled for the same reason the piles' badges are. */}
      {!w.boot.settled || w.scheduled.length > 0 ? (
        <Nav
          label={Copy.scheduled}
          count={w.boot.settled ? w.scheduled.length : undefined}
          onPress={() => go("/scheduled")}
        />
      ) : null}

      {/* TRASH — the browser rail's utility-row order (History above Trash), closing the
          recovery gap the delete confirm names: the mail went to the provider's Trash, and
          this is where it can be put back from. Gated on the engine's capability PAIR
          (list + restore, one predicate) — the webapp disables its palette row on the same
          answer, and a row opening "not available here" teaches nothing on a phone. NO COUNT,
          like History: a number here would claim attention deleted mail does not want. */}
      {w.trash.available ? <Nav label={Copy.trashTitle} onPress={() => go("/trash")} chevron /> : null}

      {/* Search over the synced mirror — a destination like the rail's. */}
      <Nav label={Copy.search} onPress={() => go("/search")} chevron />
      <Nav label={Copy.settings} onPress={() => go("/settings")} chevron />
      {/* The pairing door: the server picker (QR scan, own-server, managed). */}
      <Nav label={Copy.serversRow} onPress={() => go("/servers")} chevron />
    </>
  );
}

export function Nav({
  label,
  sub,
  count,
  chevron,
  onPress,
}: {
  label: string;
  /** The rail's own second line, where the browser carries one (`rail.historyTitle`). */
  sub?: string;
  count?: number;
  chevron?: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <TapRow
      onPress={onPress}
      accessibilityRole="link"
      accessibilityLabel={
        sub !== undefined
          ? Copy.ariaLabelDetail(label, sub)
          : count === undefined ? label : Copy.ariaLabelCount(label, count)
      }
      style={{
        marginHorizontal: 8,
        paddingHorizontal: 12,
        paddingVertical: 12,
        minHeight: 46,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
      }}
    >
      <View style={{ flexShrink: 1 }}>
        <Txt variant="navLabel">{label}</Txt>
        {sub ? (
          <Txt variant="caption" tone="ink3" numberOfLines={2} style={{ marginTop: 2 }}>
            {sub}
          </Txt>
        ) : null}
      </View>
      <View style={{ flex: 1 }} />
      {count !== undefined ? (
        <Txt variant="caption" tone="ink3" tabular>
          {count}
        </Txt>
      ) : null}
      {chevron ? <Icon name="chev" size={13} color={t.c.ink3} /> : null}
    </TapRow>
  );
}
