/**
 * Piles and utility destinations used by the More tab and the mail drawers.
 * The compact drawer follows the mobile web order and opens the same native routes.
 */
import { View } from "react-native";
import { router, type Href } from "expo-router";
import { design } from "@ohmail/tokens/design";
import { Copy } from "../copy";
import { useTheme } from "../theme";
import { mailColors } from "../theme/mail";
import { useWorld } from "../state/world";
import type { PileKind } from "../state/model";
import { tagHueOf } from "../theme/palette";
import { Rule, Section, TagDot, TapRow, Txt } from "./base";
import { DrawerTapRow } from "./DrawerTapRow";
import { DrawerGroup } from "./DrawerGroup";
import { FoldersGroup } from "./FoldersGroup";
import { Icon, NavigationIcon, type IconName, type NavigationIconName } from "./Icon";
import { morePaneKeyOf, type MoreHref } from "./pane-routes";

export function MoreNav({ onNavigate, foot = true, selected, onPick, onPush, drawer = false }: {
  onNavigate?: () => void;
  drawer?: boolean;
  /** Settings and the pairing door at the end; the drawer pins them itself ({@link MoreNavFoot}). */
  foot?: boolean;
  /** More's pair (two panes): the open destination's key, and the pick that opens one beside the rows. */
  selected?: string | null;
  onPick?: (key: string) => void;
  onPush?: (path: Href) => void;
}) {
  const w = useWorld();
  const t = useTheme();
  const pileCountOf = (kind: PileKind) => drawer && !w.boot.settled
    ? undefined : w.piles.find((p) => p.kind === kind)?.items.length ?? 0;
  const pile = (kind: PileKind): Href => ({ pathname: "/triage", params: { pile: kind } });
  const { go, at } = moreRows(onNavigate, selected, onPick, onPush);

  const search = <Nav label={Copy.search} drawer={drawer} nativeFeedback={drawer} drawerIcon="search"
    selected={at("/search")} onPress={() => go("/search")} chevron={!drawer} />;

  return (
    <View style={drawer ? { gap: 12 } : undefined}>
      {drawer ? null : <Section style={{ paddingTop: 16 }}>{Copy.triage}</Section>}
      <View style={drawer ? { gap: 2 } : undefined}>
        <Nav label={Copy.replyLater} drawer={drawer} drawerIcon="later" count={pileCountOf("replyLater")} selected={at(pile("replyLater"))} onPress={() => go(pile("replyLater"))} />
        <Nav label={Copy.setAside} drawer={drawer} drawerIcon="parked" count={pileCountOf("setAside")} selected={at(pile("setAside"))} onPress={() => go(pile("setAside"))} />
        <Nav label={Copy.resurface} drawer={drawer} drawerIcon="resurface" count={pileCountOf("resurface")} selected={at(pile("resurface"))} onPress={() => go(pile("resurface"))} />
      </View>

      {/* The compact rail always offers Tags. Counts wait for the mirror. */}
      {drawer || w.tags.length > 0 ? (
        <DrawerGroup active={drawer} label={Copy.tagsTitle} collapsed selected={selected?.startsWith("tag:")}>
          {w.tags.map((tag) => (
            <Nav
              key={tag.id}
              label={tag.name}
              drawer={drawer}
              dot={t.c.tag[tagHueOf(tag.hue)].ink}
              count={w.boot.settled ? w.tagged.count(tag.id) : undefined}
              selected={at(`/tag/${encodeURIComponent(tag.id)}`)}
              onPress={() => go(`/tag/${encodeURIComponent(tag.id)}`)}
            />
          ))}
          {drawer && w.tags.length === 0 ? (
            <Txt variant="caption" tone="ink2" style={{ paddingLeft: 42 }}>{Copy.tagNone}</Txt>
          ) : null}
        </DrawerGroup>
      ) : null}

      {/* THE FOLDERS GROUP — rendered ONLY while the account's "Use folders" flag is on
          (the server's consent answer), so the flag-off screen is the pre-feature screen
          (FOLDERS-SPEC.md §10). The rail's own placement: below the piles and Tags, above
          the utility rows.
          The stage-2 verbs (spec §18) ride the world's own actions — the engine's
          folder_create/rename/delete family, plus the summary read for the delete
          confirm's server-truth counts. */}
      {w.folders.enabled ? (
        <FoldersGroup drawer={drawer}
          folders={w.folders.list}
          unread={w.folders.unread}
          onOpen={(id) => go(`/folder/${encodeURIComponent(id)}`)}
          selectedId={selected?.startsWith("folder:") ? selected.slice(7) : null}
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

      {drawer ? null : <Rule inset={20} />}
      <View style={drawer ? { gap: 2 } : undefined}>

        {drawer
          ? <Nav label={Copy.history} drawer drawerIcon="history" selected={at("/history")} onPress={() => go("/history")} />
          : <Nav label={Copy.history} sub={Copy.historyNavSub} selected={at("/history")} onPress={() => go("/history")} chevron />}
        {drawer ? search : null}

        {/* Scheduled mail sits with Drafts on the compact rail. */}
        {drawer || !w.boot.settled || w.drafts.length > 0 ? (
          <Nav
            label={Copy.draftsTitle}
            drawer={drawer} drawerIcon="drafts"
            count={w.boot.settled ? (w.drafts.length + (drawer ? w.scheduled.length : 0)) || undefined : undefined}
            selected={at("/drafts")}
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
        {drawer ? null : !w.boot.settled || w.scheduled.length > 0 ? (
          <Nav
            label={Copy.scheduled}
            count={w.boot.settled ? w.scheduled.length : undefined}
            selected={at("/scheduled")}
            onPress={() => go("/scheduled")}
          />
        ) : null}

        {/* The compact rail keeps Trash in place when the server cannot restore mail. */}
        {w.trash.available || drawer ? (
          <Nav label={Copy.trashTitle} drawer={drawer} drawerIcon="trash" selected={at("/trash")}
            disabled={!w.trash.available} onPress={() => go("/trash")} chevron={!drawer} />
        ) : null}

        {drawer ? (
          <Nav label={Copy.settings} drawer nativeFeedback drawerIcon="settings"
            selected={at("/settings") || selected?.startsWith("settings:")} onPress={() => go("/settings")} />
        ) : search}
      </View>
      {foot && !drawer ? <MoreNavFoot onNavigate={onNavigate} selected={selected} onPick={onPick} /> : null}
    </View>
  );
}

/** The list's last two rows: Settings and the pairing door. */
export function MoreNavFoot({ onNavigate, selected, onPick }: {
  onNavigate?: () => void;
  selected?: string | null;
  onPick?: (key: string) => void;
}) {
  const { go, at } = moreRows(onNavigate, selected, onPick);
  return (
    <>
      <Nav label={Copy.settings} selected={at("/settings")} onPress={() => go("/settings")} chevron />
      {/* The pairing door: the server picker (QR scan, own-server, managed). */}
      <Nav label={Copy.serversRow} selected={at("/servers")} onPress={() => go("/servers")} chevron />
    </>
  );
}

/** A row's press (picked beside More's rows, else pushed) and whether its destination is the one open. */
function moreRows(onNavigate?: () => void, selected?: string | null, onPick?: (key: string) => void, push = router.push) {
  return {
    go: (path: Href) => {
      onNavigate?.();
      if (onNavigate && selected != null && morePaneKeyOf(path as MoreHref) === selected) return;
      const key = onPick ? morePaneKeyOf(path as MoreHref) : null;
      if (onPick && key !== null) onPick(key);
      else push(path);
    },
    at: (path: Href) => selected != null && morePaneKeyOf(path as MoreHref) === selected,
  };
}

export function Nav({
  label,
  icon,
  drawer = false,
  drawerIcon,
  nativeFeedback,
  disabled,
  sub,
  dot,
  count,
  chevron,
  selected,
  onPress,
}: {
  label: string;
  icon?: IconName;
  drawer?: boolean;
  drawerIcon?: NavigationIconName;
  nativeFeedback?: boolean;
  disabled?: boolean;
  /** The rail's own second line, where the browser carries one (`rail.historyTitle`). */
  sub?: string;
  /** A tag's ink — the rail's dot before its name. */
  dot?: string;
  count?: number;
  chevron?: boolean;
  /** The destination open beside More's rows. */
  selected?: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  const Row = nativeFeedback && !disabled ? DrawerTapRow : TapRow;
  const badge = drawer && !count ? undefined : count;
  const activeTag = drawer && selected && dot !== undefined ? mailColors(t) : null;
  const selectedDot = drawer && selected && dot === undefined ? (
    <View style={{ width: 6, height: 6, borderRadius: t.radius.pill, backgroundColor: t.c.ink }} />
  ) : null;
  return (
    <Row
      onPress={onPress}
      disabled={disabled}
      selected={t.mail ? undefined : selected}
      accessibilityState={{ selected: selected === true, disabled: disabled === true }}
      accessibilityRole="link"
      accessibilityLabel={
        disabled ? Copy.ariaLabelDetail(label, Copy.trashUnavailable)
          : sub !== undefined ? Copy.ariaLabelDetail(label, sub)
          : badge === undefined ? label : Copy.ariaLabelCount(label, badge)
      }
      style={{
        marginHorizontal: t.mail ? 0 : 8,
        paddingHorizontal: 12,
        paddingVertical: drawer ? 2 : 12,
        minHeight: drawer ? Number.parseFloat(design.faces.paper.phone["h-m"]) : 46,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        borderRadius: drawer ? t.radius.pill : t.radius.row,
        ...(activeTag ? { backgroundColor: activeTag["nav-on"] } : {}),
      }}
    >
      {drawer && drawerIcon ? <NavigationIcon name={drawerIcon} color={t.c.ink} /> : null}
      {icon ? <Icon name={icon} size={16} color={t.c.ink} /> : null}
      {dot !== undefined ? drawer ? (
        <View style={{ width: 20, alignItems: "center" }}>
          <View style={{ width: 8, height: 8, borderRadius: t.radius.pill, backgroundColor: activeTag?.["on-nav-on"] ?? dot }} />
        </View>
      ) : <TagDot ink={dot} /> : null}
      <View style={{ flexShrink: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Txt variant={drawer && !selected ? dot === undefined ? "railLabel" : "body" : t.mail ? "rowSender" : "navLabel"}
            numberOfLines={drawer ? 1 : undefined}
            style={drawer ? { flexShrink: 1, color: activeTag?.["on-nav-on"] ?? t.c.ink } : undefined}>{label}</Txt>
          {selectedDot}
        </View>
        {sub ? (
          <Txt variant="caption" tone="ink3" numberOfLines={2} style={{ marginTop: 2 }}>
            {sub}
          </Txt>
        ) : null}
      </View>
      <View style={{ flex: 1 }} />
      {badge !== undefined ? (
        <Txt variant={drawer ? "railCount" : "caption"} tone={drawer ? selected ? "ink" : "ink2" : "ink3"} tabular
          style={activeTag ? { color: activeTag["on-nav-on"] } : undefined}>
          {badge}
        </Txt>
      ) : null}
      {chevron ? <Icon name="chev" size={13} color={t.c.ink3} /> : null}
    </Row>
  );
}
