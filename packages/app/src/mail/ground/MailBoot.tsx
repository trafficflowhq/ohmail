"use client";

/**
 * THE BOOT DUTIES, ONCE PER SIGN-IN: what the old shell did once for the whole app as it came up. They stand on the
 * ground, so each runs once per mounted frame, under the scope, and again only for another scope; no walk between
 * places runs one a second time. Each duty is ONE hook in a file of its own, called here in the order the old shell
 * ran them, under the conditions it ran them under (never on the demo; read off the browser's own answer and not
 * the server's first one).
 *
 * STANDING: the startup marks and the vitals (`boot-marks.ts`); setup's resume for an account with no mailbox
 * (`boot-setup.ts`), whose answer, where "connect a mailbox" goes, this mount provides to the connection's feeder;
 * the wake registration's two ends that are no press (`boot-wake.ts`); the account language's adoption
 * (`boot-locale.ts`); the account's look (`boot-face.ts`); what says the first run is owed (`first-run-owed.ts`),
 * whose offer of the review and its one read this mount provides to the stage and to every other reader; the Ohbox's visit mark,
 * moved when the person leaves it (`boot-visit.ts`).
 */
import type { ReactNode } from "react";
import { SeedOfferContext } from "@ohmail/app-logic/mailboxes/first-run/seed-offer";
import { SeedReviewContext } from "@ohmail/app-logic/mailboxes/first-run/use-seed-review";
import { FaceHoldContext, useFaceAtBoot } from "./boot-face.js";
import { useLocaleAtBoot } from "./boot-locale.js";
import { useStartupMarks } from "./boot-marks.js";
import { SetupHrefContext, useSetupAtBoot } from "./boot-setup.js";
import { useOhboxVisitAtBoot } from "./boot-visit.js";
import { useWakeAtBoot } from "./boot-wake.js";
import { useFirstRunOwed } from "./first-run-owed.js";

export function MailBoot({ children }: { readonly children: ReactNode }): ReactNode {
  useStartupMarks();
  const setupHref = useSetupAtBoot();
  useWakeAtBoot();
  useLocaleAtBoot();
  const holdFace = useFaceAtBoot();
  useOhboxVisitAtBoot();
  const { offer, review } = useFirstRunOwed();
  return (
    <SetupHrefContext.Provider value={setupHref}>
      <SeedOfferContext.Provider value={offer}>
        <SeedReviewContext.Provider value={review}>
          <FaceHoldContext.Provider value={holdFace}>{children}</FaceHoldContext.Provider>
        </SeedReviewContext.Provider>
      </SeedOfferContext.Provider>
    </SetupHrefContext.Provider>
  );
}
