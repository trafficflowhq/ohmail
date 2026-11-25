/** The first screen shows the app’s mark, its welcome line, and the three ways in. */
import "./welcome.css";
import { useEffect, useState, type ReactNode } from "react";
import { Button, Mark, Page } from "@ohmail/ui/base";
import { Said } from "../text/Said.js";
import type { PhoneDoorConfig } from "./contract.js";
import { useDoorWords } from "./namespace.js";
import type { StepProps } from "./states.js";

const LINE = {
  ohmail: "welcome.line.ohmail",
  ohcal: "welcome.line.ohcal",
} as const satisfies { readonly [A in PhoneDoorConfig["app"]]: string };

/** The doorbell rings by itself once, a moment after the first screen arrived, as the design rings it. */
const RINGS_AFTER_MS = 1100;

export function Welcome({ door, to }: StepProps): ReactNode {
  const { t } = useDoorWords();
  const { app } = door.config;
  const [rang, setRang] = useState(false);
  useEffect(() => {
    const ring = setTimeout(() => setRang(true), RINGS_AFTER_MS);
    return () => clearTimeout(ring);
  }, []);
  return (
    <Page
      centerLead
      acts={
        <>
          <Button size="l" onPress={() => to({ step: "scan" })}>
            {t("welcome.scan")}
          </Button>
          <Button size="l" kind="two" onPress={() => to({ step: "signIn" })}>
            {t("welcome.signIn")}
          </Button>
          <div className="phone-welcome-self-hosted">
            <Button kind="quiet" onPress={() => to({ step: "signIn", address: "" })}>
              {t("welcome.signInSelfHosted")}
            </Button>
          </div>
        </>
      }
    >
      <Mark hot ringing={rang} bell={{ label: t("welcome.ring") }}>
        oh
      </Mark>
      <Said text={t(LINE[app])} dot="ink" />
    </Page>
  );
}
