/**
 * THE MAILBOX ON THIS PHONE: the one connect form, opened for the purpose `standalone`, and nothing of the step's own
 * around its fields. The form takes the address, the provider, the servers on the manual entry (the incoming and the
 * outgoing one, as on every purpose), the one password and the name the letters carry; its wire sends the door's
 * `open`. The password is the form's: no state, prop, route, storage or line of this step ever holds it. Opened, the
 * step goes to the copy opening and reads nothing of the answer; native shows the mailbox by itself.
 */
import { useMemo, type ReactNode } from "react";
import { Button, Dot, Page, Sentence } from "@ohmail/ui/base";
import type { ConnectAsk, ConnectResult } from "../mailboxes/connect/contract.js";
import { useDoorWords } from "./namespace.js";
import type { StepProps } from "./states.js";
import { useUpgradeLine } from "./upgrade.js";

export function MailboxStep({ door, to, back }: StepProps): ReactNode {
  const { t } = useDoorWords();
  const upgrade = useUpgradeLine(door);
  const ask = useMemo<ConnectAsk>(
    () => ({
      purpose: { kind: "standalone" },
      onDone: (result: ConnectResult) => {
        if (result.kind === "connected") to({ step: "mirror" }, { replace: true });
      },
    }),
    [to],
  );
  return door.connect(ask, (material, backToProviders, providerBlank) => (
    <Page
      stack
      back={<Button kind="quiet" icon="back" label={t("back")} onPress={backToProviders ?? back} />}
      material={material}
      line={upgrade.length > 0 ? upgrade : undefined}
      acts={
        providerBlank === undefined ? null : (
          <Button kind="quiet" size="l" onPress={() => door.go("servers")}>
            {t("form.later")}
          </Button>
        )
      }
    >
      {providerBlank === undefined ? null : (
        <Sentence size="xl" level={1}>
          {t("form.provider")}{" "}
          <span className="oh-nowrap">
            {providerBlank}
            <Dot kind="hot" />
          </span>
        </Sentence>
      )}
    </Page>
  ));
}
