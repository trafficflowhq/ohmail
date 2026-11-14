/**
 * THE CARD A SERVER'S UPDATE ANSWER PUTS OVER THE MAIL — "this ohmail is too old for its server", or "ohmail
 * is being updated and will be back shortly" (`net/update-answer.ts`, `state/gate.ts`'s `update` verdict).
 * One whole sentence and the verbs that go with it, nothing about the act that was under way: a queued act
 * stays queued and leaves once the server takes it. It DECIDES nothing: `net/update-verbs.ts` answers which
 * verbs this build may offer, and a verb with nowhere to go is not drawn at all.
 *
 * "Too old" offers the way to the update for this build (the store, or the download page), and the way into
 * the browser, because the web is there from the first day. "Being updated" offers no verb: there is
 * nothing to press, and the card clears on the next answer from the server.
 */
import { useCallback } from "react";
import { Linking, Platform, View } from "react-native";
import { Copy } from "../copy";
import { DISTRIBUTION } from "../distribution";
import { updateVerbs, type PairedServer, type UpdateVerbId } from "../net/update-verbs";
import type { UpdateAnswerFacts } from "../net/update-answer";
import { Button, Screen, Scroller, Txt } from "./base";

const LABEL: Record<UpdateVerbId, () => string> = {
  store: () => Copy.updateOpenStore,
  download: () => Copy.updateOpenDownload,
  browser: () => Copy.updateOpenBrowser,
};

export function UpdateCard({ answer, server }: {
  answer: UpdateAnswerFacts["answer"];
  /** The server this session is paired with: which page the browser verb opens is decided from it. */
  server: PairedServer | null;
}) {
  const verbs = answer === "tooOld" ? updateVerbs({ os: Platform.OS, distribution: DISTRIBUTION, server }) : [];
  /* The SYSTEM's own handler: a store page or a browser. A refusal to open is silent by the platform's own
     contract, and nothing here can say more than the platform did. */
  const open = useCallback((url: string) => { void Linking.openURL(url).catch(() => undefined); }, []);
  return (
    <Screen>
      <Scroller bounded contentStyle={{ paddingTop: 48, gap: 12 }}>
        <Txt variant="h1" accessibilityRole="header">
          {answer === "tooOld" ? Copy.updateTooOld : Copy.updateServerUpdating}
        </Txt>
        {verbs.length > 0 ? (
          <View style={{ gap: 10, marginTop: 20 }}>
            {verbs.map((verb, i) => (
              <Button
                key={verb.id}
                label={LABEL[verb.id]()}
                variant={i === 0 ? "solid" : "plain"}
                onPress={() => open(verb.url)}
              />
            ))}
          </View>
        ) : null}
      </Scroller>
    </Screen>
  );
}
