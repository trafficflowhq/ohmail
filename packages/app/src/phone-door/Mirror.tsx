/**
 * PAIRED: the copy opens. Native shows the mailbox by itself once it is open; until then the page says so, and, where
 * a store's upgrade runs under the connect, how far it is (a second line joins after a while, never at once).
 */
import type { ReactNode } from "react";
import { Button, Page } from "@ohmail/ui/base";
import { Said } from "../doors/stage/Said.js";
import { useDoorWords } from "./namespace.js";
import type { StepProps } from "./states.js";
import { useUpgradeLine } from "./upgrade.js";

export function Mirror({ door }: StepProps): ReactNode {
  const { t } = useDoorWords();
  const upgrade = useUpgradeLine(door);
  return (
    <Page
      line={upgrade.length > 0 ? upgrade : [{ heavy: t("paired.line") }]}
      acts={
        <Button size="l" disabled>
          {t("paired.syncing")}
        </Button>
      }
    >
      <Said text={t("paired.say")} />
    </Page>
  );
}
