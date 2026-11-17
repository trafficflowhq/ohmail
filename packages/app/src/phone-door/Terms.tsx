/**
 * ORGANIZE ON THIS PHONE: what it means, said before a password is asked for. Where this build cannot organize on
 * the phone it says so and offers only the way back. What differs by system is a table over native's word.
 */
import type { ReactNode } from "react";
import { Button, Page } from "@ohmail/ui/base";
import { Facts } from "../doors/stage/DoorSheet.js";
import { Said } from "../doors/stage/Said.js";
import type { PhoneDoorConfig } from "./contract.js";
import { useDoorWords } from "./namespace.js";
import type { StepProps } from "./states.js";

const WHILE = {
  android: "terms.while.android",
  ios: "terms.while.ios",
} as const satisfies { readonly [O in PhoneDoorConfig["os"]]: string };

const NO_ENGINE = { code: "standaloneNoEngine", args: [] } as const;

export function Terms({ door, to, back }: StepProps): ReactNode {
  const { t, say } = useDoorWords();
  const backButton = <Button kind="quiet" icon="back" label={t("back")} onPress={back} />;
  if (door.config.organizes !== "offered")
    return (
      <Page
        back={backButton}
        refusal={[say(NO_ENGINE)]}
        acts={
          <Button size="l" keyHint="↵" onPress={back}>
            {t("terms.chooseOther")}
          </Button>
        }
      >
        <Said text={t("terms.say")} />
      </Page>
    );
  return (
    <Page
      back={backButton}
      columns={2}
      material={
        <Facts
          items={[
            t(WHILE[door.config.os]),
            t("terms.oneMailbox"),
            t("terms.serverKeeps"),
            t("terms.screener"),
          ]}
        />
      }
      acts={
        <>
          <Button size="l" keyHint="↵" onPress={() => to({ step: "mailbox" })}>
            {t("terms.continue")}
          </Button>
          <Button size="l" kind="quiet" onPress={back}>
            {t("terms.chooseOther")}
          </Button>
        </>
      }
    >
      <Said text={t("terms.say")} />
    </Page>
  );
}
