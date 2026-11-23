import { onboardingType } from "../theme/type";
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
import { Tap, Txt } from "./base";
import { Icon } from "./Icon";
import { OnboardingButton, OnboardingPage, OnboardingTitle, useOnboardingLook } from "./OnboardingPage";
import { dayStamp } from "./day-stamp";
import { wallSays, type WallAction, type WallLine } from "./wall-says";
import { WALL_READ_MS, wallLift, type WallCheck, type WallLift } from "./wall-lift";
import {
  DELETE_ACCOUNT_URL, exportFilename, mintManageLink, opensTheWall, readAccess, readExport, SELF_HOST_GUIDE,
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
  }
}

export function AccountWall(
  { facts, session }: { facts: AccessRefusedFacts; session: ConnectedSession | null },
) {
  const locale = useLocale();
  const router = useRouter();
  const { palette } = useOnboardingLook();
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
      line.date === undefined ? line : { ...line, date: dayStamp(line.date, locale, undefined, "weekday") },
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
      if (action.id === "deletePage") { leave(DELETE_ACCOUNT_URL); return; }
      /* The way off the screen: Servers holds disconnect and forget, and this wall stands where
         the tabs those were reachable behind used to be. */
      router.push("/servers");
    },
    [mintAndLeave, moveOut, router],
  );

  /* While a poll is in flight nothing else is true to offer; the way off the screen stays. */
  const shown = check === "checking" ? plan.actions.filter((a) => a.id === "servers") : plan.actions;

  const manage = shown.find((action) => action.id === "manage");
  const servers = shown.find((action) => action.id === "servers");
  const waysOut = shown.filter((action) => action.id !== "manage" && action.id !== "servers");

  return (
    <OnboardingPage
      actions={
        <>
          {check === "pending" ? (
            <OnboardingButton label={Copy.wallCheckAgain} kind="soft" onPress={() => lift.current?.checkAgain()} />
          ) : null}
          {manage !== undefined ? (
            <>
              <View>
                <OnboardingButton label={manage.label} onPress={() => press(manage)} />
                {minting === "manage" ? (
                  <ActivityIndicator
                    size="small"
                    color={palette["on-solid"]}
                    style={{ position: "absolute", right: 16, top: 0, bottom: 0 }}
                  />
                ) : null}
              </View>
              {manage.hint ? <Txt variant="note" style={{ color: palette.ink2 }}>{manage.hint}</Txt> : null}
            </>
          ) : null}
          {servers !== undefined ? <OnboardingButton label={servers.label} kind={manage ? "quiet" : "soft"} onPress={() => press(servers)} /> : null}
        </>
      }
    >
      <View style={{ gap: 8 }}>
        <View style={{ maxWidth: 280 }}>
          <OnboardingTitle text={say(stamp(plan.headline))} />
        </View>
        {mintRefusal !== null ? (
          <Txt variant="body" accessibilityRole="alert" style={{ color: palette.ink }}>
            {mintRefusal.why === "unverified" ? Copy.wallMintUnverified : Copy.wallMintFailed}
          </Txt>
        ) : null}
        {plan.body[0]?.key === "wallStopped" ? (
          <Txt variant="body" style={{ color: palette.ink, ...onboardingType.wallBody, fontWeight: "700" }}>
            {Copy.phoneWallStopped}
          </Txt>
        ) : plan.body.map((line) => (
          <Txt key={line.key} variant="body" style={{ color: palette.ink2, ...onboardingType.wallBody }}>
            {say(stamp(line))}
          </Txt>
        ))}
        {plan.erasure ? (
          <Txt variant="body" style={{ color: palette.ink2, ...onboardingType.wallBody }}>{say(stamp(plan.erasure))}</Txt>
        ) : null}
        {check === "checking" ? (
          <View accessibilityRole="progressbar" accessibilityLiveRegion="polite" style={{ flexDirection: "row", gap: 8 }}>
            <ActivityIndicator size="small" color={palette.hot} />
            <Txt variant="body" style={{ color: palette.ink2 }}>{Copy.wallChecking}</Txt>
          </View>
        ) : null}
        {check === "pending" ? (
          <Txt variant="body" accessibilityLiveRegion="polite" style={{ color: palette.ink2 }}>{Copy.wallPending}</Txt>
        ) : null}
      </View>
      {waysOut.length > 0 ? (
        <View style={{ backgroundColor: palette.sheet, borderRadius: 20, padding: 16, marginTop: 16, gap: 16 }}>
          {waysOut.map((action) => (
            <View key={action.id} style={{ gap: 6 }}>
              <Tap
                accessibilityRole="button"
                accessibilityLabel={action.id === "export" && busy ? Copy.wallMoveOutBusy : action.label}
                onPress={() => press(action)}
                style={({ pressed }) => ({ flexDirection: "row", gap: 12, opacity: pressed ? 0.86 : 1 })}
              >
                <Icon name={action.id === "export" ? "download" : "trash"} size={18} color={palette.ink2} />
                <View style={{ flex: 1, gap: 4 }}>
                  <Txt style={{ color: palette.ink, ...onboardingType.label, fontWeight: "700" }}>
                    {action.id === "export" && busy ? Copy.wallMoveOutBusy : action.label}
                  </Txt>
                  <Txt style={{ color: palette.ink2, ...onboardingType.label }}>{action.hint}</Txt>
                </View>
                {action.id === "delete" && minting === "delete" ? (
                  <ActivityIndicator size="small" color={palette.ink2} />
                ) : null}
              </Tap>
              {action.id === "export" ? (
                <>
                  <Txt variant="note" tone="accent" accessibilityRole="link" onPress={() => leave(SELF_HOST_GUIDE)}>
                    {Copy.wallMoveOutGuide}
                  </Txt>
                  {failed ? (
                    <Txt variant="caption" accessibilityRole="alert" style={{ color: palette.ink }}>
                      {Copy.wallMoveOutFailed}
                    </Txt>
                  ) : null}
                </>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
    </OnboardingPage>
  );
}
