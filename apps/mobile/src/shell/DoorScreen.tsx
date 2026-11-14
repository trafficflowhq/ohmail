/**
 * THE DOOR'S SCREEN: the native view at the door's page, with no scope, and the door's host under it
 * (`door-host.ts`). The page draws the ways in and the list of servers; this side holds what a page must never hold
 * (a pairing's code, the redeem, a mailbox's password on its way to the engine) and three things only native can
 * draw: the camera, above the web view at the rectangle the page reports (the page's policy lets it play no media);
 * the sentence before the system asks about notices; and a quiet cover until the page says it has drawn.
 */
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Crypto from "expo-crypto";
import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { BackHandler, Keyboard, Platform, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { buildCommit } from "../build-info";
import { Copy } from "../copy";
import { phoneEngineStart } from "../engine/engine-artifact";
import { engineLogSink } from "../engine/engine-log";
import { openNotificationSettings } from "../engine/notification-permission-native";
import { PHONE_CLAIM_NAME, standaloneAvailable } from "../engine/standalone-door";
import { activeLocale } from "../i18n/locale";
import { appRelease } from "../net/app-release";
import { useConnection } from "../net/connection";
import { networkNow, onNetworkChange } from "../net/network-door";
import { useTheme } from "../theme";
import { NotifyPermission } from "../ui/NotifyPermission";
import { usePosture } from "../ui/posture";
import { nativePosture } from "../ui/posture/posture-native";
import { useNotifyPermission } from "../ui/useNotifyPermission";
import { APP } from "../variant-native";
import type { FoldReading, SafeInsets } from "./bridge-kinds";
import { DoorHost } from "./door-host";
import type { DoorAt, Rect } from "./door-kinds";
import { wakeShell } from "./doors";
import { Sentence } from "./Sentence";
import { shellNative, shellView } from "./shell-native";
import type { ShellRefusal, ShellViewHandle } from "./shell-port";
import { webViewVerdict } from "./webview-check";

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function DoorScreen({ asked }: { asked: DoorAt | null }) {
  const native = shellNative();
  const conn = useConnection();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const posture = usePosture();
  const [permission, requestPermission] = useCameraPermissions();
  const notify = useNotifyPermission();
  const [drawn, setDrawn] = useState(false);
  const [refused, setRefused] = useState<ShellRefusal | null>(null);
  const [camera, setCamera] = useState<Rect | null>(null);
  const view = useRef<ShellViewHandle | null>(null);
  const keyboard = useRef(0);
  /* What the host reads when a request arrives, as the last render left it: the host is one for the screen's life. */
  const now = useRef({ conn, insets, permission, notify });
  now.current = { conn, insets, permission, notify };

  const host = useMemo(() => new DoorHost({
    post: (epoch, text) => void view.current?.post(epoch, text),
    conn: () => now.current.conn,
    facts: () => ({
      app: APP.app,
      os: Platform.OS === "ios" ? "ios" : "android",
      pad: Platform.OS === "ios" && Platform.isPad === true,
      language: activeLocale() === "de" ? "de" : "en",
      build: { version: appRelease() ?? null, commit: buildCommit(process.env.EXPO_PUBLIC_COMMIT) },
      facts: {
        posture: foldReading(),
        insets: pageInsets(now.current.insets),
        keyboard: { height: keyboard.current },
        online: networkNow() !== "offline",
      },
    }),
    asked,
    tickets: {
      mint: () => hex(Crypto.getRandomBytes(16)),
      now: Date.now,
      later: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
    },
    standalone: {
      offered: () => APP.carries.organizes && standaloneAvailable({ startEngine: phoneEngineStart() }),
      deps: () => ({
        startEngine: phoneEngineStart(),
        /* The native halves behind a dynamic import, as every caller reaches them: a static one would make this
           module's graph unloadable outside React Native. */
        platform: async () => (await import("../engine/local-engine-native")).nativeEnginePlatform(),
        machineName: () => PHONE_CLAIM_NAME,
        network: networkNow,
        buildCommit: buildCommit(process.env.EXPO_PUBLIC_COMMIT),
        /* The id the launch stamped, never a fresh one; unsettled, the engine refuses a nameless claimant. */
        installId: async () => {
          const engine = await import("../engine/native");
          const marker = await import("../state/install-marker");
          return (await marker.installGeneration(engine.nativeEngineDeps())) ?? "";
        },
        logSink: engineLogSink(),
        listHeld: (accountId) => now.current.conn.listHeldStandalone(accountId),
      }),
      startSession: async (door, _address, launch) => {
        (await import("../engine/organizer-session-native")).startOrganizerSessionNative(door, launch);
      },
      noticeGate: () => now.current.notify.gate(),
    },
    camera: {
      permitted: () => now.current.permission?.granted === true,
      allow: async () => (await requestPermission()).granted,
      show: setCamera,
    },
    /* A mailbox was opened: over the open mailbox's own route the door is dismissed, else the root places the app. */
    entered: () => (router.canGoBack() ? router.dismissAll() : router.replace("/")),
    back: () => (router.canGoBack() ? router.back() : router.replace("/")),
    ready: () => setDrawn(true),
    wake: () => wakeShell("foreground"),
    openSettings: () => openNotificationSettings(),
    // One host per screen: what it reads of a render it reads through `now`.
  }), [asked, requestPermission]);

  useEffect(() => () => host.close(), [host]);

  /* The connection as it changes: the page draws the last state and keeps no row of its own. */
  useEffect(() => {
    host.changed();
  }, [host, conn.state, conn.profiles, conn.activeId, conn.syncing, conn.syncError]);

  /* A door the connection's state opened gives way once a mailbox is open, unless a press of its own is still
     between its code or password and its end: that press leaves by itself. A door asked for over an open mailbox stays. */
  const open = conn.state.k === "shell" || conn.state.k === "live";
  useEffect(() => {
    if (asked === null && open && !host.busy()) router.replace("/");
  }, [asked, open, host]);

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
    /* BACK ASKS THE PAGE, which answers within its deadline or not at all. Not taken, the door's own way out; and
       where that leads nowhere (the first screen, a list nothing of which can be opened), the app leaves. */
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      void host.back().then(async (took) => {
        if (!took && (await host.leave()) === "stayed") BackHandler.exitApp();
      });
      return true;
    });
    return () => { shown.remove(); hidden.remove(); net(); back.remove(); };
  }, [host]);

  const usable = native !== null && webViewVerdict(native.webViewCheck()) === "usable";
  if (!usable || refused?.why === "webview") return <Sentence words={Copy.shellWebViewMissing} />;
  if (refused?.why === "ended") return <Sentence words={Copy.shellEnded} />;
  const Native = shellView();
  return (
    <View style={styles.fill}>
      <Native
        ref={view}
        style={styles.fill}
        scope={null}
        door
        onEpoch={(e) => {
          setDrawn(false);
          host.begin(e.nativeEvent.epoch);
        }}
        onMessage={(e) => host.receive(e.nativeEvent)}
        /* The door's page draws no letter: a link it shows is the app's own, and the person's press opens it. */
        onLinkAsk={(e) => void view.current?.openHeld(e.nativeEvent.token)}
        onMailto={() => {}}
        onRefused={(e) => setRefused(e.nativeEvent)}
      />
      {camera !== null && permission?.granted === true ? (
        <View pointerEvents="none" style={[styles.camera, { left: camera.x, top: camera.y, width: camera.w, height: camera.h }]}>
          <CameraView
            style={styles.fill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={({ data }) => host.scanned(data)}
          />
        </View>
      ) : null}
      {drawn ? null : <View style={[styles.over, { backgroundColor: t.c.canvas }]} />}
      <NotifyPermission open={notify.open} onAnswer={notify.answer} />
    </View>
  );
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

const styles = StyleSheet.create({
  fill: { flex: 1 },
  camera: { position: "absolute", overflow: "hidden" },
  over: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
});
