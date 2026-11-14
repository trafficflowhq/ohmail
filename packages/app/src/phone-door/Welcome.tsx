/**
 * THE FIRST SCREEN. The mark with its doorbell, the app's one sentence, and the ways in: "Connect a mailbox" (ink;
 * the mailbox app only, and only where this build can organize on the phone), "Scan a code", and a quiet "Servers"
 * that opens the door's list. What differs by app is a table over native's word, never a branch in markup.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Button, Mark, Page } from "@ohmail/ui/base";
import { Said } from "../doors/stage/Said.js";
import type { PhoneDoorConfig } from "./contract.js";
import { useDoorWords } from "./namespace.js";
import type { StepProps } from "./states.js";

const LINE = {
  ohmail: "welcome.line.ohmail",
  ohcal: "welcome.line.ohcal",
} as const satisfies { readonly [A in PhoneDoorConfig["app"]]: string };

/** The calendar app never offers a mailbox of its own. */
const OFFERS_A_MAILBOX = { ohmail: true, ohcal: false } as const satisfies {
  readonly [A in PhoneDoorConfig["app"]]: boolean;
};

/** The doorbell rings by itself once, a moment after the first screen arrived, as the design rings it. */
const RINGS_AFTER_MS = 1100;

export function Welcome({ door, to }: StepProps): ReactNode {
  const { t } = useDoorWords();
  const { app, organizes } = door.config;
  /* Anything but a word that offers it withholds the way. */
  const mailbox = OFFERS_A_MAILBOX[app] && organizes === "offered";
  const [rang, setRang] = useState(false);
  useEffect(() => {
    const ring = setTimeout(() => setRang(true), RINGS_AFTER_MS);
    return () => clearTimeout(ring);
  }, []);
  return (
    <Page
      acts={
        <>
          {mailbox ? (
            <Button size="l" keyHint="↵" onPress={() => to({ step: "terms" })}>
              {t("welcome.connect")}
            </Button>
          ) : null}
          <Button size="l" kind={mailbox ? "quiet" : "ink"} onPress={() => to({ step: "scan" })}>
            {t("welcome.scan")}
          </Button>
          <Button size="l" kind="quiet" onPress={() => door.go("servers")}>
            {t("welcome.servers")}
          </Button>
        </>
      }
    >
      <Mark hot ringing={rang} bell={{ label: t("welcome.ring") }}>
        oh
      </Mark>
      <Said text={t(LINE[app])} />
    </Page>
  );
}
