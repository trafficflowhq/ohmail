/**
 * THE WALL — what an account the service has refused sees instead of its mail, on the phone.
 *
 * Three things it has to do, and the browser's wall does the same three in the same order: say
 * WHAT HAPPENED AND WHEN; say that the MAILBOX IS UNTOUCHED, because a screen that only says no
 * reads as data loss; and leave every door open, because a lock with no way out is a trap. It
 * deletes nothing and wipes nothing of its own.
 *
 * It DECIDES nothing: `wall-says.ts` answers the lines and the actions, this renders them. There
 * is no React Native renderer in this workspace, so a screen that chose its own sentences would be
 * a screen nothing measures.
 */

import { useCallback, useState } from "react";
import { Linking, View } from "react-native";
import { useRouter } from "expo-router";
import { Copy } from "../copy";
import { useLocale } from "../i18n/LocaleProvider";
import { Button, Screen, Scroller, Txt } from "./base";
import { dayStamp } from "./day-stamp";
import { wallSays, type WallAction, type WallLine } from "./wall-says";
import { readExport, exportFilename, SELF_HOST_GUIDE } from "../net/account";
import { shareAttachmentBytes } from "../mail/open-attachment-native";
import { Buffer } from "buffer";
import type { AccessRefusedFacts } from "../net/access-lock";
import type { ConnectedSession } from "../net/pairing";

/** Every sentence the wall can draw, resolved against the live deck at RENDER time. */
function say(line: WallLine): string {
  switch (line.key) {
    case "wallTitle": return Copy.wallTitle;
    case "wallSuspendedTitle": return Copy.wallSuspendedTitle;
    case "wallTrialEnded": return Copy.wallTrialEnded(line.date ?? "");
    case "wallCanceled": return Copy.wallCanceled(line.date ?? "");
    case "wallUnpaid": return Copy.wallUnpaid(line.date ?? "");
    case "wallStopped": return Copy.wallStopped;
    case "wallMailboxUntouched": return Copy.wallMailboxUntouched;
    case "wallKept": return Copy.wallKept;
    case "wallErasure": return Copy.wallErasure(line.date ?? "");
    case "wallErasureHeld": return Copy.wallErasureHeld;
    case "wallErasureUnknown": return Copy.wallErasureUnknown;
    case "wallOpenInBrowser": return Copy.wallOpenInBrowser;
  }
}

export function AccountWall(
  { facts, session }: { facts: AccessRefusedFacts; session: ConnectedSession | null },
) {
  const locale = useLocale();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const plan = wallSays(facts);

  /* The date is stamped HERE, where the language is subscribed — the plan carries the server's
     ISO instant and never a formatted string, so a language switch redraws the dates with it. */
  const stamp = useCallback(
    (line: WallLine): WallLine =>
      line.date === undefined ? line : { ...line, date: dayStamp(line.date, locale) },
    [locale],
  );

  const leave = useCallback((url: string) => {
    /* The SYSTEM browser, always: the person is already signed in there, and a page where a
       subscription is bought may not open inside this app at all. A refusal to open is silent
       by the platform's own contract — nothing here can say more than the platform did. */
    void Linking.openURL(url).catch(() => undefined);
  }, []);

  const moveOut = useCallback(
    async (path: string) => {
      if (busy || session === null) return;
      setFailed(false);
      setBusy(true);
      try {
        const document_ = await readExport(session, path);
        /* SAID rather than swallowed: a press that appears to do nothing is the state this screen
           can least afford, and the remedy is to try again. */
        if (document_ === null) { setFailed(true); return; }
        const shared = await shareAttachmentBytes(
          Buffer.from(document_, "utf8").toString("base64"),
          "application/json",
          exportFilename(new Date()),
        );
        if (!shared) setFailed(true);
      } finally {
        setBusy(false);
      }
    },
    [busy, session],
  );

  const press = useCallback(
    (action: WallAction) => {
      if (action.id === "manage" || action.id === "delete") { leave(action.url); return; }
      if (action.id === "export") { void moveOut(action.path); return; }
      /* The way off the screen: Servers holds disconnect and forget, and this wall stands where
         the tabs those were reachable behind used to be. */
      router.push("/servers");
    },
    [leave, moveOut, router],
  );

  return (
    <Screen>
      <Scroller bounded contentStyle={{ paddingTop: 48, gap: 12 }}>
        <Txt variant="h1">{say(stamp(plan.headline))}</Txt>
        {plan.body.map((line) => (
          <Txt
            key={line.key}
            variant="body"
            /* THE ONE SENTENCE AT FULL INK is the one a person needs to believe, and it is the
               product's oldest promise. The rest of the body is quiet. */
            tone={line.key === "wallMailboxUntouched" ? "ink" : "ink2"}
          >
            {say(stamp(line))}
          </Txt>
        ))}
        {plan.erasure ? (
          <Txt variant="note" tone="ink3">{say(stamp(plan.erasure))}</Txt>
        ) : null}
        {plan.openElsewhere ? (
          <Txt variant="body" tone="ink2">{say({ key: plan.openElsewhere })}</Txt>
        ) : null}

        {/* THE ACTIONS ARE THE SCREEN'S ONLY EMPHASIS — one column, in the order a person meets
            them: the way back first, the way out second, the end third, and the way off the
            screen last. Each says what it does underneath where pressing again cannot undo it. */}
        <View style={{ gap: 10, marginTop: 20 }}>
          {plan.actions.map((action, i) => (
            <View key={action.id} style={{ gap: 6 }}>
              <Button
                label={action.id === "export" && busy ? Copy.signInAgainSaving : action.label}
                variant={i === 0 ? "solid" : action.id === "servers" ? "quiet" : "plain"}
                onPress={() => press(action)}
              />
              {action.id === "export" || action.id === "delete" ? (
                <Txt variant="note" tone="ink3">{action.hint}</Txt>
              ) : null}
              {action.id === "export" ? (
                <>
                  <Txt
                    variant="note"
                    tone="accent"
                    accessibilityRole="link"
                    onPress={() => leave(SELF_HOST_GUIDE)}
                  >
                    {Copy.wallMoveOutGuide}
                  </Txt>
                  {/* The app's own grammar for a refusal sentence (`ui/Field.tsx`): quiet ink and
                      the alert role, not a colour this palette does not have. */}
                  {failed ? (
                    <Txt variant="caption" tone="ink2" accessibilityRole="alert">
                      {Copy.wallMoveOutFailed}
                    </Txt>
                  ) : null}
                </>
              ) : null}
            </View>
          ))}
        </View>
      </Scroller>
    </Screen>
  );
}
