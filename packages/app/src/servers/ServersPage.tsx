/**
 * THE PHONE'S LIST OF SERVERS, on the door's page: what this phone is paired with and which of them is open, what a
 * forget could not take back, and the ways to add one (the four the first screen asks about). A row's press opens it,
 * or pairs it again where its pairing ended; its one verb forgets a pairing, or stops and removes this phone's own
 * mailbox, which asks first (`StopAndRemove.tsx`). Sync now and Disconnect stand at the column's foot while a session
 * is live. Everything drawn is the last state native told; Back is the door's way out, and where nothing can be opened
 * again, the first screen.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { Button, Empty, Tag, type IconName } from "@ohmail/ui/base";
import {
  ActionPanel,
  SettingActs,
  SettingLine,
  SettingNote,
  SettingsHead,
  SettingsSheet,
  Sheet,
} from "@ohmail/ui/mail";
import type { ServersDoor, ServersState } from "./contract.js";
import { serversView, type OpenSheet, type PairedLine, type ServersName, type ServersView } from "./model.js";
import { useServersWords, type ServersWords } from "./namespace.js";
import { StopAndRemove, useRemoval, type Removal } from "./StopAndRemove.js";
import "./placement.css";

/** A way's sign, as the first screen draws it. */
const WAY_SIGN = {
  cloud: "mail",
  server: "disk",
  computer: "desktop",
  standalone: "phone",
} as const satisfies {
  readonly [W in ServersView["ways"][number]["id"]]: IconName;
};

function nameOf(name: ServersName, t: ServersWords["t"]): string {
  return name.k === "own" ? t("ownName") : name.k === "hosted" ? t("ways.cloud.name") : name.address;
}

/** What stands first: the open session and how its sync went, or why there is none. */
function OpenSheetOf({ open, door }: { readonly open: OpenSheet; readonly door: ServersDoor }): ReactNode {
  const { t, say } = useServersWords();
  if (open.k === "none") return null;
  if (open.k === "refused")
    return (
      <SettingsSheet wants={{ word: t("refused") }}>
        {open.said === null ? null : <SettingNote warn>{say(open.said)}</SettingNote>}
        {open.pairAgain ? (
          <SettingActs>
            <Button kind="two" size="s" onPress={() => door.waysIn("scan")}>
              {t("pairAgain")}
            </Button>
          </SettingActs>
        ) : null}
      </SettingsSheet>
    );
  const opening = open.phase === "opening";
  const sync = open.sync;
  return (
    <SettingsSheet
      title={open.name === null ? t("title") : nameOf(open.name, t)}
      sign={open.own ? "phone" : "desktop"}
      aside={<Tag>{t(opening ? "opening" : "connected")}</Tag>}
    >
      {opening ? (
        <SettingLine label={t("openingLine")} />
      ) : open.syncing ? (
        <SettingLine label={t("syncing")} />
      ) : null}
      {sync === null ? null : (
        <SettingNote warn>
          {sync.k === "failed"
            ? `${t("syncFailed")} ${say(sync.said)}`
            : `${t("syncStopped")} ${sync.why === "keyChanged" ? say({ code: "pinChanged", args: [] }) : t("certificateRefused")}`}
        </SettingNote>
      )}
    </SettingsSheet>
  );
}

/** What this phone is paired with: a press opens a row (or pairs it again), its verb forgets or removes it. */
function PairedSheet({
  lines,
  note,
  door,
  removal,
}: {
  readonly lines: readonly PairedLine[];
  readonly note: "forget" | "remove";
  readonly door: ServersDoor;
  readonly removal: Removal;
}): ReactNode {
  const { t } = useServersWords();
  const open = (line: PairedLine): void => {
    if (line.pairAgain) door.waysIn("scan");
    else void door.switchTo(line.id).catch(() => {});
  };
  return (
    <SettingsSheet title={t("paired")} aside={String(lines.length)}>
      {lines.map((line) => (
        <SettingLine
          key={line.id}
          label={nameOf(line.name, t)}
          icon={line.own ? "phone" : "desktop"}
          tag={line.tag === null ? undefined : t(line.tag === "open" ? "openTag" : `kind.${line.tag}`)}
          value={
            line.value.k === "account"
              ? line.value.account
              : line.value.k === "own"
                ? t("ownLine")
                : line.value.k === "ended"
                  ? t("pairEnded")
                  : undefined
          }
          narrow="detail"
          activateLabel
          onPress={() => open(line)}
        >
          {line.pairAgain ? (
            <Button kind="quiet" size="s" onPress={() => door.waysIn("scan")}>
              {t("pairAgain")}
            </Button>
          ) : null}
          <Button kind="quiet" size="s" onPress={() => removal.press(line)}>
            {t(line.verb === "forget" ? "forget" : "stopAndRemove")}
          </Button>
        </SettingLine>
      ))}
      <SettingNote>{t(note === "forget" ? "forgetNote" : "removeNote")}</SettingNote>
    </SettingsSheet>
  );
}

/** The ways to add one: the question the first screen asks, each opening the ways in at its step. */
function WaysSheet({ view, door }: { readonly view: ServersView; readonly door: ServersDoor }): ReactNode {
  const { t } = useServersWords();
  const { os } = door.config;
  const lineOf = (id: ServersView["ways"][number]["id"]): string =>
    id === "computer" || id === "standalone" ? t(`ways.${id}.line.${os}`) : t(`ways.${id}.line`);
  return (
    <SettingsSheet title={t("connectTo")}>
      {view.ways.map((way) => (
        <SettingLine
          key={way.id}
          label={t(`ways.${way.id}.name`)}
          icon={WAY_SIGN[way.id]}
          value={lineOf(way.id)}
          narrow="under"
          activateLabel
          onPress={() => door.waysIn(way.opens)}
        />
      ))}
    </SettingsSheet>
  );
}

/** The way out: native's, over an open mailbox or where a row can be opened again; else the first screen. */
function useLeave(door: ServersDoor): () => void {
  return useCallback(() => {
    const s: ServersState = door.state.read();
    if (s.session === "live" || s.paired.some((row) => row.kind === "own" || !row.needsPair)) door.leave();
    else door.waysIn("welcome");
  }, [door]);
}

export function ServersPage({ door }: { readonly door: ServersDoor }): ReactNode {
  const { t, say } = useServersWords();
  const state = useSyncExternalStore(door.state.subscribe, door.state.read);
  const view = serversView(state, door.config);
  const removal = useRemoval(door);
  const leave = useLeave(door);
  const now = useRef(removal);
  now.current = removal;
  /* The hardware back: an open dialog keeps the mailbox; otherwise the way out, never the app's end. */
  useEffect(
    () =>
      door.back.subscribe(() => {
        if (now.current.asking !== null) now.current.keep();
        else leave();
        return true;
      }),
    [door, leave],
  );
  const verbs = view.verbs ? (
    <ActionPanel
      label={t("title")}
      items={[
        {
          id: "sync",
          label: t(state.syncing ? "syncing" : "syncNow"),
          icon: "pull",
          kind: "ink",
          rank: 0,
          disabled: state.syncing,
          widest: t("syncNow"),
          onPress: () => door.sync(),
        },
        { id: "disconnect", label: t("disconnect"), icon: "x", rank: 0, onPress: () => door.disconnect() },
      ]}
    />
  ) : undefined;
  return (
    <div className="srv-page">
      <Sheet
        kind="reading"
        label={t("title")}
        back={{ label: t("back"), onPress: leave }}
        head={<SettingsHead title={t("title")} hot={view.hot} />}
        foot={verbs}
      >
        {view.after === null ? null : (
          <SettingsSheet hot>
            <SettingNote warn>{say(view.after)}</SettingNote>
          </SettingsSheet>
        )}
        <OpenSheetOf open={view.open} door={door} />
        {view.paired === null ? null : (
          <PairedSheet lines={view.paired.lines} note={view.paired.note} door={door} removal={removal} />
        )}
        {view.empty ? (
          <SettingsSheet>
            <Empty label={t("empty")} />
          </SettingsSheet>
        ) : null}
        <WaysSheet view={view} door={door} />
      </Sheet>
      <StopAndRemove removal={removal} />
    </div>
  );
}
