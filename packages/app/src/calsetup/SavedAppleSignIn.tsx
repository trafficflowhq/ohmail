import { useEffect, useRef, useState } from "react";
import { useGated } from "@ohmail/app-logic/mailboxes/first-run/use-gated";
import type { CalendarSetupPort } from "@ohmail/app-logic/calendar/setup";
import { Button } from "@ohmail/ui/base";
import type { CalendarMailboxSource } from "@ohmail/wire";
import { useText } from "../text/index.js";
import { setupFaultKeyOf } from "./setup-fault.js";

function useICloudMailboxes(port: CalendarSetupPort, wanted: boolean): readonly CalendarMailboxSource[] {
  const read = wanted && port.connect !== "none" ? port.icloudMailboxes : undefined;
  const [sources, setSources] = useState<{
    port: CalendarSetupPort;
    mailboxes: readonly CalendarMailboxSource[];
  }>();
  useEffect(() => {
    if (!read) return;
    let live = true;
    void read().then(
      (mailboxes) => {
        if (live) setSources({ port, mailboxes });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [port, read]);
  return read && sources?.port === port ? sources.mailboxes : [];
}

interface Reuse {
  readonly verb: "reuse";
  readonly port: CalendarSetupPort;
  readonly connectionId: string;
  readonly fromMailbox: string;
}

/** Park only the source mailbox and the new connection's id during verification. */
export function useSavedAppleSignIn(
  port: CalendarSetupPort,
  wanted: boolean,
  taken: (connectionId: string) => void,
  disabled: boolean,
  beforePress: () => void,
) {
  const t = useText("calsetup");
  const mailboxes = useICloudMailboxes(port, wanted);
  const connect = port.connect;
  const factor = port.factor;
  const gate = useGated<Reuse>(async ({ act }) => {
    if (connect === "none" || act.port !== port) return { ok: false, word: "refused" };
    const { connectionId, fromMailbox } = act;
    const answer = await connect({ way: "icloud", connectionId, fromMailbox });
    if (answer.kind === "taken") return { ok: true };
    if (answer.kind === "step_up") return { ok: false, word: factor ? "factor" : "sign_in" };
    return { ok: false, word: "said", said: t(setupFaultKeyOf(answer.fault, "icloud")) };
  });

  const { state, ask } = gate;
  const [dismissed, setDismissed] = useState(false);
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (state.at !== "done" || sent.current === state.act.connectionId) return;
    sent.current = state.act.connectionId;
    taken(state.act.connectionId);
  }, [state, taken]);
  const busy = state.at === "trying" || state.at === "asking";
  const refusal = state.at === "refused" ? state.refusal : null;
  const message = state.nothingRan
    ? t("signin.factorDiscarded")
    : refusal === null
      ? null
      : refusal.word === "said"
        ? refusal.said
        : t(refusal.word === "sign_in" ? "signin.factorExpired" : "signin.notSent");
  const material =
    mailboxes.length > 0 || ask ? (
      <>
        {mailboxes.length > 0 ? (
          <div role="group" aria-label={t("signin.sameAppleId")}>
            {mailboxes.map(({ id, address }) => (
              <Button
                key={id}
                kind="two"
                size="l"
                disabled={busy || disabled}
                onPress={() => {
                  beforePress();
                  setDismissed(false);
                  gate.press({ verb: "reuse", port, connectionId: crypto.randomUUID(), fromMailbox: id });
                }}
              >
                {mailboxes.length === 1 ? t("signin.sameAppleId") : t("signin.appleIdFor", { address })}
              </Button>
            ))}
          </div>
        ) : null}
        {ask && factor ? factor({ ...ask, line: t("signin.factorBody") }) : null}
      </>
    ) : undefined;
  return { busy, material, refusal: dismissed ? null : message, dismiss: () => setDismissed(true) };
}
