/**
 * THE FIRST STEP: which way the calendar is with. One capsule a way our server offers and this build has a step for;
 * with a plain heading above. With none offered it says so in one line.
 */
import { useRef, useState, type ReactNode } from "react";
import { Button, EndDot, Page, Sentence } from "@ohmail/ui/base";
import {
  isCalendarOAuthProvider,
  type CalendarOAuthProvider,
  type CalendarOAuthResult,
  type CalendarSetupPort,
  type CalendarWay,
} from "@ohmail/app-logic/calendar/setup";
import { MicrosoftApproval } from "../mailboxes/connect/MicrosoftApproval.js";
import { useText } from "../text/index.js";

export interface WayStepProps {
  /** The ways offered; null while our server has not answered. */
  readonly offered: readonly CalendarWay[] | null;
  readonly leave: ReactNode;
  readonly pick: (way: CalendarWay) => void;
  readonly startOAuth?: CalendarSetupPort["startOAuth"];
  readonly oauthInBrowser?: boolean;
  readonly via?: CalendarOAuthProvider;
  readonly status?: string;
  readonly microsoftApproval?: CalendarSetupPort["microsoftApproval"];
  readonly busy?: boolean;
}

export function WayStep({
  offered,
  leave,
  pick,
  startOAuth,
  oauthInBrowser,
  via,
  status,
  microsoftApproval,
  busy = false,
}: WayStepProps) {
  const t = useText("calsetup");
  const [startResult, setStartResult] = useState<CalendarOAuthResult | null>(null);
  const asking = useRef(false);
  const press = async (way: CalendarWay) => {
    if (busy || asking.current) return;
    if (!isCalendarOAuthProvider(way)) {
      pick(way);
      return;
    }
    if (!startOAuth) return;
    asking.current = true;
    setStartResult("connecting");
    try {
      setStartResult((await startOAuth(way)) ?? null);
    } catch {
      setStartResult("start_failed");
    } finally {
      asking.current = false;
    }
  };
  const result = startResult === null ? status : t(`oauth.${startResult}`);
  const outcome = result ? (
    <>
      <span role="status">{result}</span>
      {startResult === null && microsoftApproval ? <MicrosoftApproval read={microsoftApproval} /> : null}
    </>
  ) : undefined;
  // A browser handoff names the provider chosen on the previous device.
  const shown = via && offered?.includes(via) ? [via] : offered;
  if (offered !== null && offered.length === 0) {
    return (
      <Page acts={leave} afterLine={outcome}>
        <Sentence size="xl" level={1}>
          <EndDot kind="ink" product="cal">
            {t("way.none")}
          </EndDot>
        </Sentence>
      </Page>
    );
  }
  return (
    <Page
      acts={leave}
      afterLine={outcome}
      stack
      material={
        shown === null ? undefined : (
          <div role="group" aria-label={t("way.group")}>
            {shown.map((way) => (
              <Button
                key={way}
                kind="two"
                size="l"
                disabled={busy || startResult === "connecting"}
                onPress={() => void press(way)}
              >
                {oauthInBrowser && isCalendarOAuthProvider(way)
                  ? t("way.inBrowser", { provider: t(`way.${way}`) })
                  : t(`way.${way}`)}
              </Button>
            ))}
          </div>
        )
      }
    >
      <Sentence size="xl" level={1}>
        <EndDot kind="hot" product="cal">
          {t("way.sentence")}
        </EndDot>
      </Sentence>
    </Page>
  );
}
