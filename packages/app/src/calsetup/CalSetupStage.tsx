/**
 * THE CALENDAR'S SETUP: a stage of its own over the app, in the first run's grammar (one sentence, the one thing it
 * needs, one ink button). The step stands in the stage's words (`step`, `way`, `connection`, `again`, `from`), which
 * never hold anything a person typed. Our server's list of ways is read once a mount; a way it does not list, or one
 * this build has no step for, is never drawn and no address reaches its step.
 */
import { useEffect, useState } from "react";
import { Button, Dot, Page, Sentence } from "@ohmail/ui/base";
import {
  offeredWays,
  stepOf,
  waysSaid,
  type CalendarWay,
  type SteppedWay,
} from "@ohmail/app-logic/calendar/setup";
import { useFrame } from "../frame/commands.js";
import type { PaneProps } from "../frame/contract.js";
import { NONE } from "../host/index.js";
import { useText } from "../text/index.js";
import { CalendarsStep, DefaultStep, WaitStep } from "./AfterSteps.js";
import { useCalendarMirror } from "./mirror.js";
import { SignInStep } from "./SignInStep.js";
import { useSetupPort } from "./use-setup-port.js";
import { WayStep } from "./WayStep.js";

/** What our server lists, read once while the port stands; null until it answers. */
function useWays(port: ReturnType<typeof useSetupPort>): readonly CalendarWay[] | null {
  const [said, setSaid] = useState<readonly CalendarWay[] | null>(null);
  useEffect(() => {
    if (port === NONE) return;
    let live = true;
    void waysSaid(port).then((ways) => live && setSaid(ways));
    return () => {
      live = false;
    };
  }, [port]);
  return port === NONE ? [] : said;
}

export function CalSetupStage({ route }: PaneProps) {
  const { commands } = useFrame();
  const t = useText("calsetup");
  const port = useSetupPort();
  const mirror = useCalendarMirror();
  const said = useWays(port);
  const words = route.stage?.words ?? {};
  const fromSettings = words.from === "settings";
  const offered = port === NONE || said === null ? (port === NONE ? [] : null) : offeredWays(said, port);
  const at = stepOf(words, offered ?? []);

  const go = (next: Readonly<Record<string, string>>) =>
    commands.go({
      place: route.place,
      stage: { id: "calSetup", words: fromSettings ? { ...next, from: "settings" } : next },
    });
  const out = () =>
    commands.go(fromSettings ? { place: "calsettings", sub: "calaccounts" } : { place: "week" });
  const leave = (
    <Button kind="quiet" size="l" onPress={out}>
      {t("leave")}
    </Button>
  );
  const back = (to: Readonly<Record<string, string>>) => (
    <Button kind="quiet" icon="back" label={t("back")} onPress={() => go(to)} />
  );

  if (port === NONE || at.step === "way") {
    return (
      <WayStep offered={offered} leave={leave} pick={(way: SteppedWay) => go({ step: "signin", way })} />
    );
  }
  if (at.step === "signin") {
    return (
      <SignInStep
        key={`${at.way}:${at.again ?? ""}`}
        way={at.way}
        again={at.again}
        port={port}
        back={back({ step: "way" })}
        trail={t(`way.${at.way}`)}
        taken={(connection) => go({ step: "calendars", way: at.way, connection })}
      />
    );
  }
  if (mirror === null) {
    return (
      <Page acts={leave}>
        <Sentence size="xl" level={1}>
          {t("unread")}
          <Dot kind="ink" product="cal" />
        </Sentence>
      </Page>
    );
  }
  const step = { connection: at.connection, ...(at.way ? { way: at.way } : {}) };
  const done = () => commands.go({ place: "week" });
  if (at.step === "calendars") {
    return (
      <CalendarsStep
        way={at.way}
        mirror={mirror}
        connection={at.connection}
        port={port}
        leave={leave}
        again={() =>
          go(
            at.way
              ? {
                  step: "signin",
                  way: at.way,
                  ...(port.signInAgain === "none" ? {} : { again: at.connection }),
                }
              : { step: "way" },
          )
        }
        next={() => go({ ...step, step: port.saveSettings === "none" ? "wait" : "default" })}
      />
    );
  }
  if (at.step === "default" && port.saveSettings !== "none") {
    return (
      <DefaultStep
        mirror={mirror}
        connection={at.connection}
        port={port}
        next={() => go({ ...step, step: "wait" })}
      />
    );
  }
  return <WaitStep mirror={mirror} connection={at.connection} done={fromSettings ? out : done} />;
}
