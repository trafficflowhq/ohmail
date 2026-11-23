/**
 * The QR scan — `${origin}/pair#${fragment}` through the camera: probe, then
 * confirmation, only then the redeem. `conn.probePair` asks the address what
 * it is (spending nothing), {@link PairConfirm} renders what it measured, and
 * `conn.pairConfirmed` spends the code — unreachable without the probe's
 * admission (`net/pairing.ts`), so nothing becomes this phone's pinned server
 * unseen. The token leaves this screen only in the redeem body: never logged,
 * rendered or put in a route param. A ref disarms per-frame double probes (the
 * token is single-use); a denied camera offers ask-again and the by-hand path.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { type Refusal } from "../src/refusal";
import { sayRefusal } from "../src/refusal";
import { StyleSheet, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { Copy } from "../src/copy";
import { useConnection } from "../src/net/connection";
import { discardAdmission, parsePairLink, type PairAdmission } from "../src/net/pairing";
import { Txt } from "../src/ui/base";
import { requestPairingLink } from "../src/ui/manual-pair-mode";
import { PairConfirm } from "../src/ui/PairConfirm";
import { OnboardingButton, OnboardingPage, useOnboardingLook } from "../src/ui/OnboardingPage";
import { useLocale } from "../src/i18n/LocaleProvider";
import { SurfaceBoundary } from "../src/ui/ErrorBoundary";

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
  return (
    <SurfaceBoundary surface="scan">
      <ScanBody />
    </SurfaceBoundary>
  );
}

function ScanBody() {
  /* Subscribed to the language, so a switch in Settings redraws this screen instead of
     waiting for the next navigation — see `src/i18n/LocaleProvider.tsx`. */
  useLocale();
  const conn = useConnection();
  const { palette } = useOnboardingLook();
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>({ k: "scanning", badCode: false });
  /** Armed = the next decoded frame may act. Disarmed while parsing/redeeming/failed. */
  const armed = useRef(true);
  /**
   * A CONFIRMATION LEFT UNPRESSED GIVES THE CODE'S MATERIAL BACK — declined, or navigated away
   * from. The probe had to install the code's key to dial at all, so that key is a lease and
   * this is where it ends (`net/pairing.ts#discardAdmission`). Keyed on the admission OBJECT,
   * which the `busy` flip keeps, so the press is not mistaken for a dismiss.
   */
  const pressed = useRef(false);
  const pending = phase.k === "confirming" ? phase.admission : null;
  useEffect(() => {
    if (pending === null) return;
    return () => {
      if (!pressed.current) discardAdmission(pending);
    };
  }, [pending]);

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
      pressed.current = false;
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
      pressed.current = true;
      void conn.pairConfirmed(current.admission, current.token).then((outcome) => {
        if (outcome.ok) {
          /* A CONFIRMED PAIRING LANDS IN THE MAILBOX. Replacing with the Servers pane left the
             person on a stack with nothing under it to pop into — from first run, welcome; from
             Settings, servers under servers — so Back did nothing and only a relaunch left it.
             "/" is what the standalone door already replaces with, for the same reason. */
          router.replace("/");
          return;
        }
        setPhase({ k: "failed", reason: outcome.reason });
      });
      return { ...current, busy: true };
    });
  }, [conn]);

  /* Declining re-arms the camera and forgets the token; the effect above gives the code's key
     back with it. Nothing was spent and nothing is left installed, so this is genuinely a return
     to where they were — not a cancellation of anything. */
  const decline = useCallback(() => {
    armed.current = true;
    setPhase({ k: "scanning", badCode: false });
  }, []);

  const back = router.canGoBack() ? () => router.back() : undefined;
  if (phase.k === "confirming") {
    return (
      <PairConfirm
        admission={phase.admission}
        busy={phase.busy}
        onConfirm={confirm}
        onCancel={decline}
        back={back}
      />
    );
  }

  const granted = permission?.granted === true;
  const denied = permission !== null && !granted;
  const failed = phase.k === "failed";
  const manual = () => {
    requestPairingLink();
    router.replace("/connect");
  };
  const allow = () => void requestPermission();
  const retry = () => {
    armed.current = true;
    setPhase({ k: "scanning", badCode: false });
  };
  const feedback = phase.k === "probing" ? Copy.pairingBusy : phase.k === "scanning" && phase.badCode ? Copy.scanBadCode : null;

  return (
    <OnboardingPage
      showUnsaved
      back={back}
      row
      actions={
        <>
          {failed ? <OnboardingButton label={Copy.scanAgain} grow onPress={retry} /> : null}
          {denied && !failed ? <OnboardingButton label={Copy.scanAllow} grow onPress={allow} /> : null}
          <OnboardingButton label={Copy.scanManual} kind="soft" grow onPress={manual} />
        </>
      }
    >
      {failed ? (
        <Txt accessibilityRole="alert" style={{ color: palette.ink }}>{sayRefusal(phase.reason)}</Txt>
      ) : (
        <>
          <View
            style={[styles.camera, { backgroundColor: palette.line }]}
            accessibilityLabel={denied ? Copy.scanCameraOff : Copy.scanHint}
            accessible
          >
            {granted ? (
              <CameraView
                style={StyleSheet.absoluteFill}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={phase.k === "scanning" ? onScanned : undefined}
              />
            ) : null}
            <View pointerEvents="none" style={styles.guide}>
              {corners.map((corner, index) => (
                <View key={index} style={[styles.corner, corner, { borderColor: granted ? palette.sheet : palette.ink2 }]} />
              ))}
            </View>
          </View>
          <Txt style={[styles.tag, { backgroundColor: palette.soft, color: palette.ink2 }]}>{Copy.scanDevices}</Txt>
          {feedback !== null ? (
            <Txt accessibilityLiveRegion="polite" style={{ color: palette.ink, marginTop: 8 }}>{feedback}</Txt>
          ) : null}
        </>
      )}
    </OnboardingPage>
  );
}

const styles = StyleSheet.create({
  camera: { width: "100%", aspectRatio: 1, borderRadius: 20, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  guide: { width: "56%", height: "56%" },
  corner: { position: "absolute", width: 32, height: 32 },
  tag: { alignSelf: "flex-start", marginTop: 24, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, overflow: "hidden" },
});

const corners = [
  { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 12 },
  { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 12 },
  { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 12 },
  { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 12 },
];
