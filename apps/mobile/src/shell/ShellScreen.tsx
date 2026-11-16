/**
 * THE SHELL'S SCREEN: the one web view filling the window, the bridge's native end, and the facts
 * that cross it. The page builds the client engine and draws the shared views; this side holds the
 * session's transport, answers the page's requests through the HTTP door, and hands it the window's
 * edges, the keyboard, the network, back and a wake as events. Until the page says it has drawn,
 * the one waiting sentence stands over it; a phone whose web view cannot carry the shell gets one
 * sentence and no view.
 */
import * as Crypto from "expo-crypto";
import { router } from "expo-router";
import * as SQLite from "expo-sqlite";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppState, BackHandler, Keyboard, Linking, Platform, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Copy } from "../copy";
import { backupExclusion, recordBackupExclusion } from "../engine/backup-exclusion";
import { nativeBackupExclusion } from "../engine/backup-exclusion-native";
import { logBackupExclusion } from "../engine/engine-log";
import { ENGINE_DB_FILE } from "../engine/local-engine";
import { nativeNotificationPermission } from "../engine/notification-permission-native";
import { STORE_COPY_FILE } from "../engine/store-copy";
import { askNoticePermission, measureShellBackup, noticePermission, onShellWake } from "./doors";
import { launchVerdict } from "./old-copy";
import { activeLocale } from "../i18n/locale";
import { networkNow, onNetworkChange } from "../net/network-door";
import { Txt } from "../ui/base";
import { usePosture } from "../ui/posture";
import { nativePosture } from "../ui/posture/posture-native";
import { buildCommit } from "../build-info";
import { appRelease } from "../net/app-release";
import { BridgeHost } from "./bridge-host";
import type { FoldReading, NoticePermission, SafeInsets, ShellConfig } from "./bridge-kinds";
import { HttpDoor } from "./http-door";
import { KEPT_FAMILIES } from "./kept-families";
import { scopeOf } from "./scope";
import { shellNative, shellView } from "./shell-native";
import type { ShellRefusal, ShellViewHandle } from "./shell-port";
import { handoffMinter, type ShellSession } from "../net/pairing";
import { webViewVerdict } from "./webview-check";
import { downloadPageOf } from "../net/account";
import { pairingDigest } from "../switch/digest";
import { switchPlaces } from "../switch/receive";
import { switchSender } from "../switch/sender";
import { switchNative } from "../switch/switch-native";
import type { SwitchNative } from "../switch/switch-port";
import { siblingOf } from "../variant";
import { APP } from "../variant-native";

const sha256Hex = (text: string) =>
  Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text, { encoding: Crypto.CryptoEncoding.HEX });
const sha256Base64 = (text: string) =>
  Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text, { encoding: Crypto.CryptoEncoding.BASE64 });

/** Whether the other app is here, as native reads it now; a build without the switch module offers none. */
const otherOf = (native: SwitchNative | null) => (native === null ? "absent" : native.otherState());

export function ShellScreen({ session }: { session: ShellSession }) {
  const native = shellNative();
  const switcher = useMemo(() => switchNative(), []);
  const drawnRef = useRef(false);
  const [scope, setScope] = useState<string | null>(null);
  const [drawn, setDrawn] = useState(false);
  const [refused, setRefused] = useState<ShellRefusal | null>(null);
  const view = useRef<ShellViewHandle | null>(null);
  const lastPlace = useRef<string | null>(null);
  const insets = useSafeAreaInsets();
  const posture = usePosture();
  const keyboard = useRef(0);
  const oldCopy = useRef<"present" | "absent">("absent");

  /* The keeper is told its families before the view exists, so the page's first word is kept; and every place the
     shell keeps mail is marked out of the backups and read back before the view exists, the worst answer recorded. */
  useEffect(() => {
    let live = true;
    void (native?.setFamilies([...KEPT_FAMILIES]) ?? Promise.resolve(false))
      .then(() => scopeOf(session.ownerKey, sha256Hex))
      .then(async (s) => {
        if (native !== null) {
          const at = native.storagePaths(s);
          const dir = String(SQLite.defaultDatabaseDirectory).replace(/\/+$/, "");
          const engine = session.standalone ? [`${dir}/${ENGINE_DB_FILE}`, `${dir}/${STORE_COPY_FILE}`] : [];
          const state = await measureShellBackup(nativeBackupExclusion(), [at.keeper, at.webData, ...engine]);
          recordBackupExclusion(state);
          logBackupExclusion(state, Platform.OS);
        }
        // Whether the screens' old copy of this mailbox waits to be handed across; a handed one is removed here.
        oldCopy.current = (await session.oldCopy?.present().catch(() => false)) === true ? "present" : "absent";
        if (live) setScope(s);
      });
    return () => { live = false; };
  }, [native, session]);

  /* The notice permission as the phone reads it, kept current for the page's `config`. */
  const permission = useRef<NoticePermission>("default");
  useEffect(() => {
    void noticePermission(nativeNotificationPermission()).then((p) => { permission.current = p; }).catch(() => undefined);
  }, []);

  const usable = native !== null && webViewVerdict(native.webViewCheck()) === "usable";

  const host = useMemo(() => {
    const http = new HttpDoor({
      live: () => (scope === null ? null : { session, scope }),
      ready: () => scope !== null,
    });
    const config = (): ShellConfig | null => scope === null ? null : {
      app: APP.app,
      other: otherOf(switcher),
      scope,
      accountId: session.profile.accountId,
      setting: session.standalone ? "standalone"
        : session.profile.flavor === "managed" ? "managed"
        : session.profile.flavor === "selfhost" ? "selfHosted" : "desktopHost",
      serverName: session.standalone ? "" : hostOf(session.profile.origin),
      build: { version: appRelease() ?? null, commit: buildCommit(process.env.EXPO_PUBLIC_COMMIT) },
      language: activeLocale() === "de" ? "de" : "en",
      place: lastPlace.current,
      oldCopy: oldCopy.current,
      notifications: permission.current,
      facts: {
        posture: foldReading(),
        insets: pageInsets(insets),
        keyboard: { height: keyboard.current },
        online: networkNow() !== "offline",
      },
    };
    /* THE SWITCH: this app's pairing named by its digest only, a code minted only for a signed-out sibling from a
       paired door; the store verb falls back to the other app's own page. */
    const digest = () => session.standalone
      ? Promise.resolve(null) : pairingDigest(sha256Base64, session.profile.origin, session.profile.accountId);
    const sender = switchSender({
      app: APP.app, native: switcher, inFront: () => AppState.currentState === "active", now: Date.now, digest,
      mint: handoffMinter(session, siblingOf(APP).app),
    });
    const page = siblingOf(APP).links.host;
    const bridge: BridgeHost = new BridgeHost({
      post: (epoch, text) => void view.current?.post(epoch, text),
      config,
      app: APP.app,
      switch: {
        read: async () => ({ other: otherOf(switcher) }),
        open: async (to) => {
          const went = await sender.open(to);
          return typeof went === "string" ? { went } : went;
        },
        store: async () => ({
          opened: (await sender.store()) || (await Linking.openURL(downloadPageOf(page)).then(() => true, () => false)),
        }),
      },
      http,
      act: async (a) => {
        switch (a.act) {
          // The sign-out's ceremony, with its confirmations and its outcomes, stands on the Servers pane.
          case "openServers":
          case "signOut":
            router.push("/servers");
            return {};
          case "notifications.permission":
            return { permission: (permission.current = await noticePermission(nativeNotificationPermission())) };
          case "notifications.request":
            return { permission: (permission.current = await askNoticePermission(nativeNotificationPermission())) };
          case "backup.read":
            return { backup: backupExclusion() };
          // The status bar follows the system's scheme, as the page's look does.
          case "chrome":
            return {};
          // The diagnostic file's sections are a closed set the shell has none in yet: refused, never an empty file.
          case "diagnostics.share":
            return { refused: "notReady" };
        }
      },
      openHeld: async (token) => (await view.current?.openHeld(token)) ?? false,
      ready: (place) => {
        lastPlace.current = place;
        drawnRef.current = true;
        setDrawn(true);
        // A place the other app opened this one at, held by the connection layer until the page could take it.
        const arrived = switchPlaces.take(session.profile.id);
        if (arrived !== null) bridge.send({ type: "linkIn", target: arrived });
      },
      place: (fragment) => { lastPlace.current = fragment; },
      note: () => {},
      /* The live scope's old copy only, and its removal only under the verdict that stamped this install. */
      oldCopy: {
        page: async (r) => {
          const door = session.oldCopy;
          if (r.scope !== scope) return { refused: "foreignScope" };
          if (door === null || oldCopy.current !== "present") return { refused: "notReady" };
          return door.page(r.after);
        },
        done: async (r) => {
          const door = session.oldCopy;
          const verdict = launchVerdict();
          if (r.scope !== scope) return { refused: "foreignScope" };
          if (door === null || verdict === null || oldCopy.current !== "present") return { refused: "notReady" };
          await door.done(verdict);
          oldCopy.current = "absent";
          return {};
        },
      },
    });
    return bridge;
    // The host is one per session and scope: a new scope is a new page.
  }, [session, scope]);

  /* The facts, as they change: each one an event to the page that is open now. */
  useEffect(() => {
    host.send({ type: "insets", insets: pageInsets(insets) });
  }, [host, insets.top, insets.right, insets.bottom, insets.left]);
  useEffect(() => {
    host.send({ type: "posture", reading: foldReading() });
  }, [host, posture.hasFold, posture.fold]);
  useEffect(() => {
    const shown = Keyboard.addListener("keyboardDidShow", (e) => {
      keyboard.current = e.endCoordinates.height;
      host.send({ type: "keyboard", reading: { height: keyboard.current } });
    });
    const hidden = Keyboard.addListener("keyboardDidHide", () => {
      keyboard.current = 0;
      host.send({ type: "keyboard", reading: { height: 0 } });
    });
    const net = onNetworkChange((s) => host.send({ type: "network", online: s !== "offline" }));
    const app = AppState.addEventListener("change", (s) => {
      if (s !== "active") return;
      host.send({ type: "wake", why: "foreground" });
      // The other app may have come or gone while this one was away.
      host.send({ type: "other", state: otherOf(switcher) });
    });
    /* A place the other app opens this one at while it runs: handed to the page once it has drawn, as the launch's is. */
    const arrivals = switchPlaces.onHeld(() => {
      if (!drawnRef.current) return;
      const arrived = switchPlaces.take(session.profile.id);
      if (arrived !== null) host.send({ type: "linkIn", target: arrived });
    });
    /* A push for this pairing, from the root's wake provider: the page drains now. */
    const pushed = onShellWake((why) => host.send({ type: "wake", why }));
    /* BACK ASKS THE PAGE, which answers within its deadline or not at all; not taken, the app leaves. */
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      void host.ask("back").then((took) => { if (!took) BackHandler.exitApp(); });
      return true;
    });
    return () => { shown.remove(); hidden.remove(); net(); app.remove(); back.remove(); pushed(); arrivals(); };
  }, [host, switcher, session]);

  if (!usable || refused?.why === "webview") {
    return <Sentence words={Copy.shellWebViewMissing} />;
  }
  if (refused?.why === "ended") return <Sentence words={Copy.shellEnded} />;
  const Native = shellView();
  return (
    <View style={styles.fill}>
      <Native
        ref={view}
        style={styles.fill}
        scope={scope}
        onEpoch={(e) => host.begin(e.nativeEvent.epoch)}
        onMessage={(e) => host.receive(e.nativeEvent)}
        onLinkAsk={(e) => host.send({ type: "linkAsk", token: e.nativeEvent.token, url: e.nativeEvent.url })}
        onMailto={(e) => host.send({ type: "mailto", url: e.nativeEvent.url })}
        onRefused={(e) => setRefused(e.nativeEvent)}
      />
      {drawn ? null : <View style={styles.over}><Txt variant="body">{Copy.shellOpening}</Txt></View>}
    </View>
  );
}

function Sentence({ words }: { words: string }) {
  return <View style={styles.over}><Txt variant="body">{words}</Txt></View>;
}

/** The edges the page pads itself by: the route pads the top (the status bar) natively. */
function pageInsets(i: SafeInsets): SafeInsets {
  return { top: 0, right: i.right, bottom: i.bottom, left: i.left };
}

/** The folds as the platform states them now, in the window's coordinates. */
function foldReading(): FoldReading {
  const p = nativePosture();
  return { folds: p?.getFolds() ?? [], hasFold: p?.getHasFold() ?? false };
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return "";
  }
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  over: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", justifyContent: "center", padding: 24 },
});
