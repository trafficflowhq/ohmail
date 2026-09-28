/**
 * THE WALL — what an account the service has refused sees instead of its mail, on the phone.
 *
 * Three things, in the browser wall's order: say WHAT HAPPENED AND WHEN; say that the MAILBOX IS
 * UNTOUCHED, because a screen that only says no reads as data loss; and leave every door open,
 * because a lock with no way out is a trap. It deletes nothing and wipes nothing of its own.
 *
 * It DECIDES nothing — `wall-says.ts` answers the lines and actions, `wall-lift.ts` when to ask
 * whether it may lift; this renders them. The way back MINTS ITS LINK AT THE PRESS.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Linking, View } from "react-native";
import { useRouter } from "expo-router";
import { Copy } from "../copy";
import { useLocale } from "../i18n/LocaleProvider";
import { Button, Screen, Scroller, Txt } from "./base";
import { dayStamp } from "./day-stamp";
import { wallSays, type WallAction, type WallLine } from "./wall-says";
import { WALL_READ_MS, wallLift, type WallCheck, type WallLift } from "./wall-lift";
import { useTheme } from "../theme";
import {
  exportFilename, mintManageLink, opensTheWall, readAccess, readExport, SELF_HOST_GUIDE,
} from "../net/account";
import { shareAttachmentBytes } from "../mail/open-attachment-native";
import { Buffer } from "buffer";
import type { AccessRefusedFacts } from "../net/access-lock";
import type { AppLifecycle } from "../net/drain-cadence";
import type { ConnectedSession } from "../net/pairing";

/** React Native's `AppState`, as the wall's and the strip's schedules read it — the drain cadence's own shape. */
export const appLifecycle: AppLifecycle = {
  now: () => AppState.currentState,
  subscribe: (listener) => {
    const sub = AppState.addEventListener("change", listener);
    return () => { sub.remove(); };
  },
};

/** Which press is minting, and why the last one did not leave. */
type Minting = "manage" | "delete";
type MintRefusal = { on: Minting; why: "unverified" | "failed" };

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
  const t = useTheme();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [check, setCheck] = useState<WallCheck>("idle");
  const [minting, setMinting] = useState<Minting | null>(null);
  const [mintRefusal, setMintRefusal] = useState<MintRefusal | null>(null);
  const lift = useRef<WallLift | null>(null);
  const plan = wallSays(facts);

  /* THE READ SCHEDULE. The read itself takes the wall down on `access: "open"` (`net/account.ts`),
     which unmounts this screen; nothing here clears the slot. */
  useEffect(() => {
    if (session === null || session.standalone) return;
    const machine = wallLift({
      opens: async () => {
        const a = await readAccess(session);
        return a !== null && opensTheWall(a);
      },
      lifecycle: appLifecycle,
      onCheck: setCheck,
      minute: WALL_READ_MS,
    });
    lift.current = machine;
    return () => {
      machine.stop();
      if (lift.current === machine) lift.current = null;
    };
  }, [session]);

  /* The date is stamped HERE, where the language is subscribed — the plan carries the server's
     ISO instant and never a formatted string, so a language switch redraws the dates with it. */
  const stamp = useCallback(
    (line: WallLine): WallLine =>
      line.date === undefined ? line : { ...line, date: dayStamp(line.date, locale) },
    [locale],
  );

  const leave = useCallback((url: string) => {
    /* The SYSTEM browser, always: a page where a subscription is bought may not open inside this
       app at all, and the minted link carries its own one-time token there. A refusal to open is
       silent by the platform's own contract — nothing here can say more than the platform did. */
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

  /* THE LINK IS MINTED HERE, at the press, and only its answer is opened. Only the way back arms
     the poll: a deletion is no payment, so its return asks once like any other. */
  const mintAndLeave = useCallback(
    async (on: Minting) => {
      if (minting !== null || session === null) return;
      setMintRefusal(null);
      setMinting(on);
      try {
        const link = await mintManageLink(session, locale);
        if (link.kind === "url") {
          if (on === "manage") lift.current?.armPoll();
          leave(link.url);
          return;
        }
        setMintRefusal({ on, why: link.kind });
      } finally {
        setMinting(null);
      }
    },
    [leave, locale, minting, session],
  );

  const press = useCallback(
    (action: WallAction) => {
      if (action.id === "manage" || action.id === "delete") { void mintAndLeave(action.id); return; }
      if (action.id === "export") { void moveOut(action.path); return; }
      /* The way off the screen: Servers holds disconnect and forget, and this wall stands where
         the tabs those were reachable behind used to be. */
      router.push("/servers");
    },
    [mintAndLeave, moveOut, router],
  );

  /* While a poll is in flight nothing else is true to offer; the way off the screen stays. */
  const shown = check === "checking" ? plan.actions.filter((a) => a.id === "servers") : plan.actions;

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
          {check === "checking" ? (
            <View
              style={{ flexDirection: "row", alignItems: "center", gap: 10 }}
              accessibilityRole="progressbar"
              accessibilityLiveRegion="polite"
            >
              <ActivityIndicator size="small" color={t.c.accent} />
              <Txt variant="body" tone="ink2">{Copy.wallChecking}</Txt>
            </View>
          ) : null}
          {check === "pending" ? (
            <View style={{ gap: 10 }}>
              <Txt variant="body" tone="ink2" accessibilityLiveRegion="polite">{Copy.wallPending}</Txt>
              <Button label={Copy.wallCheckAgain} variant="plain" onPress={() => lift.current?.checkAgain()} />
            </View>
          ) : null}
          {shown.map((action, i) => (
            <View key={action.id} style={{ gap: 6 }}>
              <View>
                <Button
                  label={action.id === "export" && busy ? Copy.wallMoveOutBusy : action.label}
                  /* The browser wall's three-level emphasis, mirrored: the way back solid, the way
                     out plain, the end and the way off the screen quiet — the end-of-account verb
                     may not outweigh the way out (the tab draws it as its quietest control too). */
                  variant={i === 0 && check !== "checking" ? "solid" : action.id === "export" ? "plain" : "quiet"}
                  onPress={() => press(action)}
                />
                {/* MINTING: the same label with a spinner on it — the label never turns into a
                    progress word, and the other actions stay pressable. */}
                {minting === action.id ? (
                  <ActivityIndicator
                    size="small"
                    color={i === 0 && check !== "checking" ? t.c.onAccent : t.c.ink2}
                    style={{ position: "absolute", right: 16, top: 0, bottom: 0 }}
                  />
                ) : null}
              </View>
              {mintRefusal !== null && mintRefusal.on === action.id ? (
                <Txt variant="note" tone="ink2" accessibilityRole="alert">
                  {mintRefusal.why === "unverified" ? Copy.wallMintUnverified : Copy.wallMintFailed}
                </Txt>
              ) : null}
              {action.id === "manage" && action.hint ? (
                <Txt variant="note" tone="ink3">{action.hint}</Txt>
              ) : null}
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
