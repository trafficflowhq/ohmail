/**
 * PAIR BY HAND — the manual fallback behind the QR scan, and the whole entry path for the
 * desktop's LAN door (whose pane offers a COPY LINK, not a QR — its own copy says it:
 * browsers use Tailscale, the mobile app uses LAN).
 *
 * Two fields: the server address and the pairing token — or the whole `${origin}/pair#${token}`
 * link pasted into the token field, which the parser splits (and whose query-borne impostor it
 * refuses). Either way the ceremony is the SAME `pair()` the scanner drives: negotiate /hello,
 * spend the token once in the redeem body, learn the server-verified account, boot the mirror.
 * This screen replaced the early hand-typed trio (origin + bearer + account id): nobody types
 * a bearer or an account id anymore — the redeem mints the one and the server names the other.
 *
 * The token field renders as a secret and is never echoed into any error sentence; failures
 * show the ceremony's words, success lands on the Servers screen showing the live mirror.
 */
import { useCallback, useState } from "react";
import { TextInput, View } from "react-native";
import { router } from "expo-router";
import { Copy } from "../src/copy";
import { useConnection } from "../src/net/connection";
import { parsePairLink, pendingPairOrigin } from "../src/net/pairing";
import { useTheme } from "../src/theme";
import { Button, Panel, Screen, Scroller, Section, Txt } from "../src/ui/base";
import { DetailBar } from "../src/ui/chrome";

type Phase = { k: "idle" } | { k: "pairing" } | { k: "failed"; reason: string };

export default function ConnectScreen() {
  const conn = useConnection();
  // The picker's "enter a pairing token" step carries the address it already negotiated — through
  // a value held in THIS process, never a route parameter. The app registers the `ohmail` scheme
  // as a browsable deep link, so a route parameter here would let any web page choose the server
  // a pairing token is sent to, and that token IS the credential (`/pair/redeem` is public and
  // anonymous). See `pendingPairOrigin` for the whole reasoning.
  const [origin, setOrigin] = useState(() => pendingPairOrigin());
  const [token, setToken] = useState("");
  const [phase, setPhase] = useState<Phase>({ k: "idle" });

  const pair = useCallback(async () => {
    // A whole pairing link pasted into the token field wins over the address field — it names
    // its own origin, and splitting it here keeps the one-mechanism rule (the parser is the
    // same one the scanner trusts, query-refusal included).
    const pasted = parsePairLink(token);
    const target = pasted ?? { origin, token };
    setPhase({ k: "pairing" });
    const outcome = await conn.pair(target.origin, target.token);
    if (outcome.ok) {
      router.replace("/servers");
      return;
    }
    setPhase({ k: "failed", reason: outcome.reason });
  }, [conn, origin, token]);

  return (
    <Screen>
      <DetailBar title={Copy.connectTitle} />
      <Scroller>
        <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 14 }}>
          <Txt variant="h1">{Copy.connectTitle}</Txt>
          <Txt variant="caption" tone="ink3" style={{ marginTop: 6, lineHeight: 16 }}>
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
              label={phase.k === "pairing" ? Copy.pairingBusy : Copy.connectGo}
              variant="solid"
              onPress={phase.k === "pairing" || !token.trim() ? undefined : () => void pair()}
            />
          </View>
        </Panel>

        {phase.k === "failed" ? (
          <Panel style={{ marginTop: 14, paddingVertical: 16 }}>
            <View style={{ paddingHorizontal: 20, gap: 6 }}>
              <Txt variant="settingsLabel" tone="accent">
                {Copy.connectRefusedTitle}
              </Txt>
              <Txt variant="caption" tone="ink2" style={{ lineHeight: 16 }}>
                {phase.reason}
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
