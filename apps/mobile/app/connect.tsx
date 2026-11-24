/**
 * Pair by hand — the manual fallback behind the QR scan, and the entry path
 * for the desktop's LAN door. Two fields: server address and pairing token —
 * or the whole `${origin}/pair#${fragment}` link pasted into the token field,
 * which the parser splits (refusing its query-borne impostor). The ceremony is
 * the scanner's own three steps: probe /hello spending nothing, confirm, then
 * spend the token once in the redeem body and boot the mirror. A pasted link
 * wins over the fields, so every path here renders {@link PairConfirm} before
 * the code is spent. The token renders as a secret, never echoed into errors.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { type Refusal } from "../src/refusal";
import { refuse, sayRefusal } from "../src/refusal";
import { View } from "react-native";
import { router } from "expo-router";
import { Copy } from "../src/copy";
import { useConnection } from "../src/net/connection";
import {
  discardAdmission, parsePairLink, pendingPairOrigin, type PairAdmission,
} from "../src/net/pairing";
import { Field } from "../src/ui/Field";
import { clearPairingLinkRequest, pairingLinkRequested } from "../src/ui/manual-pair-mode";
import { Button, Txt } from "../src/ui/base";
import { PairConfirm } from "../src/ui/PairConfirm";
import { OnboardingPage, OnboardingTag, useOnboardingLook, useOnboardingButton } from "../src/ui/OnboardingPage";
import { useLocale } from "../src/i18n/LocaleProvider";
import { SurfaceBoundary } from "../src/ui/ErrorBoundary";

type Phase =
  | { k: "idle" }
  /** The credential-free probe is in flight. Nothing has been spent. */
  | { k: "probing" }
  /** Waiting on a person; the token sits beside the admission and goes nowhere until they press. */
  | { k: "confirming"; admission: PairAdmission; token: string; busy: boolean }
  | { k: "failed"; reason: Refusal };

export default function ConnectScreen() {
  return (
    <SurfaceBoundary surface="connect">
      <ConnectBody />
    </SurfaceBoundary>
  );
}

function ConnectBody() {
  const onboardingButton = useOnboardingButton();
  /* Subscribed to the language, so a switch in Settings redraws this screen instead of
     waiting for the next navigation — see `src/i18n/LocaleProvider.tsx`. */
  useLocale();
  const conn = useConnection();
  const { palette } = useOnboardingLook();
  const [byLink, setByLink] = useState(pairingLinkRequested);
  useEffect(clearPairingLinkRequest, []);
  // The picker's "enter a pairing token" step carries the address it already negotiated — through
  // a value held in THIS process, never a route parameter. The app registers the `ohmail` scheme
  // as a browsable deep link, so a route parameter here would let any web page choose the server
  // a pairing token is sent to, and that token IS the credential (`/pair/redeem` is public and
  // anonymous). See `pendingPairOrigin` for the whole reasoning.
  const [origin, setOrigin] = useState(() => pendingPairOrigin());
  const [token, setToken] = useState("");
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  /**
   * A CONFIRMATION LEFT UNPRESSED GIVES THE CODE'S MATERIAL BACK — the scanner's rule, and the
   * pasted link reaching this screen carries the same key. Keyed on the admission OBJECT, which
   * the `busy` flip keeps, so the press is not mistaken for a dismiss.
   */
  const pressed = useRef(false);
  const pending = phase.k === "confirming" ? phase.admission : null;
  useEffect(() => {
    if (pending === null) return;
    return () => {
      if (!pressed.current) discardAdmission(pending);
    };
  }, [pending]);

  const probe = useCallback(async () => {
    // A whole pairing link pasted into the token field wins over the address field — it names
    // its own origin, and splitting it here keeps the one-mechanism rule (the parser is the
    // same one the scanner trusts, query-refusal included).
    const pasted = parsePairLink(token);
    if (byLink && pasted === null) {
      setPhase({ k: "failed", reason: refuse("pairCodeRejected") });
      return;
    }
    // A HAND-TYPED PAIR CARRIES NO PIN, and that is the honest outcome rather than a gap: a
    // fingerprint is 43 characters nobody will type correctly, so the seam refuses a
    // same-network address typed by hand and says to use the code the desktop shows. A pasted
    // LINK carries its own pin, which is why the paste path still wins over the fields.
    const target = pasted ?? { origin, token, pin: null };
    pressed.current = false;
    setPhase({ k: "probing" });
    // NO TOKEN ON THIS CALL. The probe measures; the code is spent in `confirm` below and
    // nowhere else, which is what makes the confirmation unskippable from this screen too.
    const outcome = await conn.probePair(target.origin, target.pin);
    if (outcome.kind === "refused") {
      setPhase({ k: "failed", reason: outcome.reason });
      return;
    }
    setPhase({ k: "confirming", admission: outcome.admission, token: target.token, busy: false });
  }, [byLink, conn, origin, token]);

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

  const back = router.canGoBack() ? () => router.back() : undefined;
  if (phase.k === "confirming") {
    return (
      <PairConfirm
        admission={phase.admission}
        busy={phase.busy}
        onConfirm={confirm}
        onCancel={() => setPhase({ k: "idle" })}
        back={back}
      />
    );
  }

  return (
    <OnboardingPage
      showUnsaved
      back={back}
      actions={
        <Button appearance={onboardingButton}
          label={phase.k === "probing" ? Copy.pairingBusy : Copy.connectGo}
          disabled={phase.k === "probing" || !token.trim()}
          onPress={() => void probe()}
        />
      }
    >
      <View style={{ gap: 12 }}>
        <View>
          {byLink ? null : (
            <Field value={origin} onChange={setOrigin} label={Copy.connectOrigin} locked={phase.k === "probing"}
              sentence={{ before: Copy.phoneServerSentence, placeholder: Copy.phoneServerBlank, compact: true, after: Copy.phonePairSentenceJoin }}
              input={{ keyboardType: "url" }}
            />
          )}
          <Field value={token} onChange={setToken} label={byLink ? Copy.phonePairLink : Copy.connectToken} secret locked={phase.k === "probing"}
            sentence={{
              before: byLink ? Copy.phonePairLinkSentence : Copy.phonePairTokenSentence,
              placeholder: Copy.phonePairTokenBlank,
              compact: !byLink,
              end: "hot",
            }}
            input={{ autoComplete: "off", textContentType: "none", importantForAutofill: "no" }}
          />
        </View>
        {phase.k === "failed" ? (
          <Txt accessibilityRole="alert" style={{ color: palette.ink, fontWeight: "700" }}>{sayRefusal(phase.reason)}</Txt>
        ) : null}
        {byLink ? (
          phase.k === "probing" ? null : <OnboardingTag label={Copy.phonePairManualSwitch} onPress={() => { setByLink(false); setPhase({ k: "idle" }); }} />
        ) : (
          <>
            <Txt variant="body" style={{ color: palette.ink, fontWeight: "700" }}>{Copy.phonePairLinkHint}</Txt>
            <Txt variant="body" style={{ color: palette.ink2 }}>{Copy.phonePairNetworkHint}</Txt>
          </>
        )}
      </View>
    </OnboardingPage>
  );
}
