/**
 * THE QR SCAN — `${origin}/pair#${token}` through the camera, then the same redeem every other
 * entry path uses.
 *
 * The token never leaves this screen except into `pair()` (whose one request carries it in the
 * redeem body); it is never logged, never rendered, never put in a route param. A code that is
 * not an ohmail pairing link gets a sentence and the camera keeps scanning — a QR that says
 * anything else is not an error worth stopping for. The scanner is armed through a ref so the
 * camera's per-frame callback cannot fire a second redeem while the first is in flight (the
 * token is single-use; a double-fire would burn it against itself).
 *
 * Camera permission is a real state, not a precondition: denied, the screen says so and offers
 * BOTH the ask-again button and the by-hand path — the flow never dead-ends on a phone that
 * keeps the camera off.
 */
import { useCallback, useRef, useState } from "react";
import { View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { Copy } from "../src/copy";
import { useConnection } from "../src/net/connection";
import { parsePairLink } from "../src/net/pairing";
import { Button, Panel, Screen, Txt } from "../src/ui/base";
import { DetailBar } from "../src/ui/chrome";

type Phase =
  | { k: "scanning"; badCode: boolean }
  | { k: "pairing" }
  | { k: "failed"; reason: string };

export default function ScanScreen() {
  const conn = useConnection();
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>({ k: "scanning", badCode: false });
  /** Armed = the next decoded frame may act. Disarmed while parsing/redeeming/failed. */
  const armed = useRef(true);

  const onScanned = useCallback(
    ({ data }: { data: string }) => {
      if (!armed.current) return;
      const parsed = parsePairLink(data);
      if (parsed === null) {
        // Not ours (or a token smuggled into the query — refused by the parser). Say so and
        // keep scanning; re-arm after a beat so one lingering frame doesn't flood the state.
        armed.current = false;
        setPhase({ k: "scanning", badCode: true });
        setTimeout(() => {
          armed.current = true;
        }, 1200);
        return;
      }
      armed.current = false;
      setPhase({ k: "pairing" });
      void conn.pair(parsed.origin, parsed.token).then((outcome) => {
        if (outcome.ok) {
          router.replace("/servers");
          return;
        }
        setPhase({ k: "failed", reason: outcome.reason });
      });
    },
    [conn],
  );

  return (
    <Screen>
      <DetailBar title={Copy.scanTitle} />

      {permission?.granted && phase.k !== "failed" ? (
        <View style={{ flex: 1 }}>
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={phase.k === "scanning" ? onScanned : undefined}
          />
          <View style={{ paddingHorizontal: 20, paddingVertical: 14, gap: 10 }}>
            <Txt variant="caption" tone="ink3" style={{ lineHeight: 16 }}>
              {phase.k === "pairing"
                ? Copy.pairingBusy
                : phase.badCode
                  ? Copy.scanBadCode
                  : Copy.scanHint}
            </Txt>
            <Button label={Copy.scanManual} variant="quiet" onPress={() => router.replace("/connect")} />
          </View>
        </View>
      ) : null}

      {permission && !permission.granted ? (
        <Panel style={{ margin: 12, paddingVertical: 16 }}>
          <View style={{ paddingHorizontal: 20, gap: 10 }}>
            <Txt variant="caption" tone="ink2" style={{ lineHeight: 16 }}>
              {Copy.scanCameraOff}
            </Txt>
            <Button label={Copy.scanAllow} variant="solid" onPress={() => void requestPermission()} />
            <Button label={Copy.scanManual} variant="quiet" onPress={() => router.replace("/connect")} />
          </View>
        </Panel>
      ) : null}

      {phase.k === "failed" ? (
        <Panel style={{ margin: 12, paddingVertical: 16 }}>
          <View style={{ paddingHorizontal: 20, gap: 10 }}>
            <Txt variant="settingsLabel" tone="accent">{Copy.connectRefusedTitle}</Txt>
            <Txt variant="caption" tone="ink2" style={{ lineHeight: 16 }}>{phase.reason}</Txt>
            <Button
              label={Copy.scanAgain}
              variant="solid"
              onPress={() => {
                armed.current = true;
                setPhase({ k: "scanning", badCode: false });
              }}
            />
            <Button label={Copy.scanManual} variant="quiet" onPress={() => router.replace("/connect")} />
          </View>
        </Panel>
      ) : null}
    </Screen>
  );
}
