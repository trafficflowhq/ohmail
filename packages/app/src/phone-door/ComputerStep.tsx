/**
 * A COMPUTER OF YOURS: its code is scanned under Settings › Devices there. Where this build cannot hold a computer's
 * key (an iPhone today) the step says so, and that the pane's Tailscale address is the way. What differs by system
 * is a table over native's word.
 */
import type { ReactNode } from "react";
import { Button, Page, type PageLinePart } from "@ohmail/ui/base";
import { Said } from "../doors/stage/Said.js";
import type { PhoneDoorConfig } from "./contract.js";
import { useDoorWords } from "./namespace.js";
import type { StepProps } from "./states.js";

const LINE = {
  android: "computer.line.android",
  ios: "computer.line.ios",
} as const satisfies { readonly [O in PhoneDoorConfig["os"]]: string };

/** Without a key this phone can hold, a computer on your own network cannot be verified here. */
const NO_PIN_NOTE = { true: null, false: "computer.iosNote" } as const satisfies {
  readonly [C in `${PhoneDoorConfig["canPin"]}`]: string | null;
};

export function ComputerStep({ door, to, back }: StepProps): ReactNode {
  const { t } = useDoorWords();
  const { os, canPin } = door.config;
  const note = NO_PIN_NOTE[`${canPin}`];
  const line: PageLinePart[] = [{ tag: t("computer.where") }, { break: true }, { heavy: t(LINE[os]) }];
  if (note !== null) line.push({ note: t(note) });
  return (
    <Page
      back={<Button kind="quiet" icon="back" label={t("back")} onPress={back} />}
      line={line}
      acts={
        <Button size="l" keyHint="↵" onPress={() => to({ step: "scan" })}>
          {t("computer.scan")}
        </Button>
      }
    >
      <Said text={t("computer.say")} />
    </Page>
  );
}
