/**
 * PAIR BY HAND — the manual fallback behind the QR scan, and the whole entry path for the
 * desktop's LAN door (whose pane offers a COPY LINK, not a QR — its own copy says it:
 * browsers use Tailscale, the mobile app uses LAN).
 *
 * Two fields: the server address and the pairing token — or the whole `${origin}/pair#${fragment}`
 * link pasted into the token field, which the parser splits (and whose query-borne impostor it
 * refuses). Either way the ceremony is the SAME three steps the scanner drives: probe /hello
 * spending nothing, confirm, then spend the token once in the redeem body, learn the
 * server-verified account, boot the mirror. This screen replaced the early hand-typed trio
 * (origin + bearer + account id): nobody types a bearer or an account id anymore — the redeem
 * mints the one and the server names the other.
 *
 * ── THE CONFIRMATION IS HERE TOO, AND THE PASTED LINK IS WHY ──────────────────────────────────
 *
 * A TYPED address is a host somebody named themselves; that is the decision the confirmation
 * exists to obtain, already made. A PASTED LINK is the same unreadable string a QR carries, and
 * it wins over the fields — so a link from a web page, a message or a mail would otherwise reach
 * a redeem here while the scanner refused it. One ceremony, both entrances: every path through
 * this screen renders {@link PairConfirm} before the code is spent.
 *
 * The token field renders as a secret and is never echoed into any error sentence; failures
 * show the ceremony's words, success lands on the Servers screen showing the live mirror.
 */
import { useCallback, useState } from "react";
import { type Refusal } from "../src/refusal";
import { sayRefusal } from "../src/refusal";
import { TextInput, View } from "react-native";
import { router } from "expo-router";
import { Copy } from "../src/copy";
import { useConnection } from "../src/net/connection";
import { parsePairLink, pendingPairOrigin, type PairAdmission } from "../src/net/pairing";
import { useTheme } from "../src/theme";
import { Button, Panel, Screen, Scroller, Section, Txt } from "../src/ui/base";
import { PairConfirm } from "../src/ui/PairConfirm";
import { DetailBar } from "../src/ui/chrome";
import { useLocale } from "../src/i18n/LocaleProvider";

type Phase =
  | { k: "idle" }
  /** The credential-free probe is in flight. Nothing has been spent. */
  | { k: "probing" }
  /** Waiting on a person; the token sits beside the admission and goes nowhere until they press. */
  | { k: "confirming"; admission: PairAdmission; token: string; busy: boolean }
  | { k: "failed"; reason: Refusal };

export default function ConnectScreen() {
  /* Subscribed to the language, so a switch in Settings redraws this screen instead of
     waiting for the next navigation — see `src/i18n/LocaleProvider.tsx`. */
  useLocale();
  const conn = useConnection();
  // The picker's "enter a pairing token" step carries the address it already negotiated — through
  // a value held in THIS process, never a route parameter. The app registers the `ohmail` scheme
  // as a browsable deep link, so a route parameter here would let any web page choose the server
  // a pairing token is sent to, and that token IS the credential (`/pair/redeem` is public and
  // anonymous). See `pendingPairOrigin` for the whole reasoning.
  const [origin, setOrigin] = useState(() => pendingPairOrigin());
  const [token, setToken] = useState("");
  const [phase, setPhase] = useState<Phase>({ k: "idle" });

  const probe = useCallback(async () => {
    // A whole pairing link pasted into the token field wins over the address field — it names
    // its own origin, and splitting it here keeps the one-mechanism rule (the parser is the
    // same one the scanner trusts, query-refusal included).
    const pasted = parsePairLink(token);
    // A HAND-TYPED PAIR CARRIES NO PIN, and that is the honest outcome rather than a gap: a
    // fingerprint is 43 characters nobody will type correctly, so the seam refuses a
    // same-network address typed by hand and says to use the code the desktop shows. A pasted
    // LINK carries its own pin, which is why the paste path still wins over the fields.
    const target = pasted ?? { origin, token, pin: null };
    setPhase({ k: "probing" });
    // NO TOKEN ON THIS CALL. The probe measures; the code is spent in `confirm` below and
    // nowhere else, which is what makes the confirmation unskippable from this screen too.
    const outcome = await conn.probePair(target.origin, target.pin);
    if (outcome.kind === "refused") {
      setPhase({ k: "failed", reason: outcome.reason });
      return;
    }
    setPhase({ k: "confirming", admission: outcome.admission, token: target.token, busy: false });
  }, [conn, origin, token]);

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

  return (
    <Screen>
      <DetailBar title={Copy.connectTitle} />
      <Scroller>
        {/* The FORM is put away for the confirmation, for the reason the scanner puts the camera
            away: a field that can still be edited beside three facts about what answered would
            let somebody read one computer's key while pairing with another — the desktop's own
            client door locks its link field at exactly this point, for exactly this reason. */}
        {phase.k === "confirming" ? (
          <PairConfirm
            admission={phase.admission}
            busy={phase.busy}
            onConfirm={confirm}
            onCancel={() => setPhase({ k: "idle" })}
          />
        ) : null}

        {phase.k !== "confirming" ? (
        <>
        <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 14 }}>
          <Txt variant="h1">{Copy.connectTitle}</Txt>
          <Txt variant="hint" tone="ink3" style={{ marginTop: 6 }}>
            {Copy.connectNote}
          </Txt>
        </View>

        <Panel style={{ paddingBottom: 16 }}>
          <Section style={{ paddingTop: 16 }}>{Copy.connectOrigin}</Section>
          <Field value={origin} onChange={setOrigin} label={Copy.connectOrigin} hint={Copy.connectOriginHint} />
          <Section>{Copy.connectToken}</Section>
          <Field value={token} onChange={setToken} label={Copy.connectToken} secret />
          <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
            <Button
              label={phase.k === "probing" ? Copy.pairingBusy : Copy.connectGo}
              variant="solid"
              onPress={phase.k === "probing" || !token.trim() ? undefined : () => void probe()}
            />
          </View>
        </Panel>
        </>
        ) : null}

        {phase.k === "failed" ? (
          <Panel style={{ marginTop: 14, paddingVertical: 16 }}>
            <View style={{ paddingHorizontal: 20, gap: 6 }}>
              <Txt variant="settingsLabel" tone="accent">
                {Copy.connectRefusedTitle}
              </Txt>
              <Txt variant="hint" tone="ink2">
                {sayRefusal(phase.reason)}
              </Txt>
            </View>
          </Panel>
        ) : null}
      </Scroller>
    </Screen>
  );
}

function Field({
  value,
  onChange,
  label,
  hint,
  secret,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  hint?: string;
  secret?: boolean;
}) {
  const t = useTheme();
  return (
    <View style={{ paddingHorizontal: 16 }}>
      <View
        style={[
          {
            paddingHorizontal: 14,
            borderRadius: t.radius.input,
            backgroundColor: t.c.canvas,
          },
          t.lift("l0"),
        ]}
      >
        <TextInput
          value={value}
          onChangeText={onChange}
          autoCorrect={false}
          autoCapitalize="none"
          secureTextEntry={secret === true}
          accessibilityLabel={label}
          style={[t.type.msgBody, { color: t.c.ink, paddingVertical: 12 }]}
        />
      </View>
      {hint ? (
        <Txt variant="caption" tone="ink3" style={{ marginTop: 6 }}>
          {hint}
        </Txt>
      ) : null}
    </View>
  );
}
