/**
 * THE QR SCAN — `${origin}/pair#${fragment}` through the camera, a PROBE, the confirmation, and
 * only then the redeem.
 *
 * ── A SCAN IS NOT A DECISION, AND IT USED TO BE ONE ───────────────────────────────────────────
 *
 * This screen parsed the code and called the redeem inside the camera's own frame callback. So
 * whatever answered the address in a QR became this phone's server — with its key pinned for the
 * life of the pairing — before anybody had seen an address. A QR is a string nobody can read, and
 * the desktop's Devices pane has claimed the opposite in every shipped release: "a device pairing
 * over your network shows these characters before it pairs."
 *
 * The ceremony is three steps now. `conn.probePair` asks the address what it is, spending nothing
 * and passing no token; {@link PairConfirm} renders what it measured; `conn.pairConfirmed` spends
 * the code, and it cannot be reached without the probe's admission (`net/pairing.ts`).
 *
 * The token never leaves this screen except into that last call (whose one request carries it in
 * the redeem body); it is never logged, never rendered, never put in a route param — which is why
 * the confirmation is a COMPONENT rendered here and not a route of its own. A code that is not an
 * ohmail pairing link gets a sentence and the camera keeps scanning. The scanner is armed through
 * a ref so the camera's per-frame callback cannot fire a second probe while the first is in
 * flight, and it stays disarmed for the whole confirmation — the token is single-use and a
 * double-fire would burn it against itself.
 *
 * Camera permission is a real state, not a precondition: denied, the screen says so and offers
 * BOTH the ask-again button and the by-hand path — the flow never dead-ends on a phone that
 * keeps the camera off.
 */
import { useCallback, useRef, useState } from "react";
import { type Refusal } from "../src/refusal";
import { sayRefusal } from "../src/refusal";
import { View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { Copy } from "../src/copy";
import { useConnection } from "../src/net/connection";
import { parsePairLink, type PairAdmission } from "../src/net/pairing";
import { Button, Panel, Screen, Scroller, Txt } from "../src/ui/base";
import { PairConfirm } from "../src/ui/PairConfirm";
import { DetailBar } from "../src/ui/chrome";
import { useLocale } from "../src/i18n/LocaleProvider";

type Phase =
  /** The camera is live. `badCode` = the last frame was not one of ours. */
  | { k: "scanning"; badCode: boolean }
  /** The credential-free probe is in flight. Nothing has been spent. */
  | { k: "probing" }
  /**
   * WAITING ON A PERSON. The admission is what the confirmation renders; the TOKEN sits beside it
   * in this screen's state and goes nowhere until the confirm is pressed. `busy` is the redeem in
   * flight — kept in the same phase so the facts stay on screen under it rather than being
   * replaced by a spinner over nothing.
   */
  | { k: "confirming"; admission: PairAdmission; token: string; busy: boolean }
  | { k: "failed"; reason: Refusal };

export default function ScanScreen() {
  /* Subscribed to the language, so a switch in Settings redraws this screen instead of
     waiting for the next navigation — see `src/i18n/LocaleProvider.tsx`. */
  useLocale();
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
      setPhase({ k: "probing" });
      // The pin rides straight from the scanned code into the probe — never re-derived, never
      // fetched. A fingerprint asked for over the network is a fingerprint an attacker on that
      // network can answer with; the point of the QR is that this one came off the screen.
      //
      // THE TOKEN IS NOT PASSED HERE. The probe negotiates and measures; it spends nothing, so a
      // server that refuses at this stage costs a sentence and not the single-use code.
      void conn.probePair(parsed.origin, parsed.pin).then((outcome) => {
        if (outcome.kind === "refused") {
          setPhase({ k: "failed", reason: outcome.reason });
          return;
        }
        setPhase({ k: "confirming", admission: outcome.admission, token: parsed.token, busy: false });
      });
    },
    [conn],
  );

  /**
   * The one press that spends the code. It reads the token out of the phase it was stored in, so
   * there is no path from a parsed link to a redeem that does not pass through a render of
   * {@link PairConfirm}.
   */
  const confirm = useCallback(() => {
    setPhase((current) => {
      if (current.k !== "confirming" || current.busy) return current;
      void conn.pairConfirmed(current.admission, current.token).then((outcome) => {
        if (outcome.ok) {
          router.replace("/servers");
          return;
        }
        setPhase({ k: "failed", reason: outcome.reason });
      });
      return { ...current, busy: true };
    });
  }, [conn]);

  /* Declining re-arms the camera and forgets the token. Nothing was spent and nothing stored, so
     this is genuinely a return to where they were — not a cancellation of anything. */
  const decline = useCallback(() => {
    armed.current = true;
    setPhase({ k: "scanning", badCode: false });
  }, []);

  return (
    <Screen>
      <DetailBar title={Copy.scanTitle} />

      {/* THE CAMERA IS PUT AWAY FOR THE CONFIRMATION. A live viewfinder under three facts a person
          is being asked to read is both a distraction and a second scanner: the phase disarms the
          callback, and taking the view down means there is nothing left to re-arm it. */}
      {phase.k === "confirming" ? (
        <Scroller>
          <PairConfirm
            admission={phase.admission}
            busy={phase.busy}
            onConfirm={confirm}
            onCancel={decline}
          />
        </Scroller>
      ) : null}

      {permission?.granted && phase.k !== "failed" && phase.k !== "confirming" ? (
        <View style={{ flex: 1 }}>
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={phase.k === "scanning" ? onScanned : undefined}
          />
          <View style={{ paddingHorizontal: 20, paddingVertical: 14, gap: 10 }}>
            <Txt variant="hint" tone="ink3">
              {phase.k === "probing"
                ? Copy.pairingBusy
                : phase.badCode
                  ? Copy.scanBadCode
                  : Copy.scanHint}
            </Txt>
            <Button label={Copy.scanManual} variant="quiet" onPress={() => router.replace("/connect")} />
          </View>
        </View>
      ) : null}

      {permission && !permission.granted && phase.k !== "confirming" ? (
        <Panel style={{ margin: 12, paddingVertical: 16 }}>
          <View style={{ paddingHorizontal: 20, gap: 10 }}>
            <Txt variant="hint" tone="ink2">
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
            <Txt variant="hint" tone="ink2">{sayRefusal(phase.reason)}</Txt>
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
