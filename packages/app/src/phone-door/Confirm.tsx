/**
 * PAIR THIS PHONE: what answered, before the code is spent. It draws what native MEASURED under the ticket (what
 * answered, at which address, with which key) and nothing else: never the address the person typed, never a field
 * of the link, never the ticket. The press sends `pair`; every other way out (Do not pair, back, a new scan, the step
 * going away) sends `dismiss` for the ticket, once, and nothing after `pair`. A press reads as accepted only where
 * the answer says `ok: true`.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Page } from "@ohmail/ui/base";
import { SettingLine, SettingNote } from "@ohmail/ui/mail";
import { DoorSheet } from "../doors/stage/DoorSheet.js";
import { Said } from "../doors/stage/Said.js";
import { useLive } from "./answers.js";
import type { PhonePairAnswer, PhonePairFacts, SaidRefusal } from "./contract.js";
import { useDoorWords, type DoorWords } from "./namespace.js";
import type { StepProps } from "./states.js";

const WHAT = {
  computer: "confirm.what.computer",
  local: "confirm.what.local",
  server: "confirm.what.server",
  hosted: "confirm.what.hosted",
} as const satisfies { readonly [W in PhonePairFacts["what"]]: string };

/** The press's answer read by its shape: only `ok === true` is a yes; a refusal without its words says no word. */
function pairedOf(answer: PhonePairAnswer | null | undefined): true | SaidRefusal | null {
  if (answer?.ok === true) return true;
  if (answer?.ok === false && typeof answer.said?.code === "string") return answer.said;
  return null;
}

/** What answered, by name: the kit's lines on the doors' sheet. The named-facts part is asked for (D-PS-2). */
function Measured({ facts, t }: { facts: PhonePairFacts; t: DoorWords["t"] }): ReactNode {
  return (
    <DoorSheet kind="facts">
      <SettingLine label={t("confirm.whatAnswered")} value={t(WHAT[facts.what])} />
      <SettingLine label={t("confirm.address")} value={facts.address} />
      {facts.key === null ? null : <SettingLine label={t("confirm.key")} value={facts.key} />}
      <SettingNote>{facts.key === null ? t("confirm.noKeyFine") : t("confirm.keyFine")}</SettingNote>
    </DoorSheet>
  );
}

export function Confirm({ door, seed, to, back }: StepProps): ReactNode {
  const { t, say } = useDoorWords();
  const offer = seed.offer;
  /* The ticket is spent by the first `pair`, or given back by the first `dismiss`: never both, never twice. */
  const spent = useRef(false);
  const [pairing, setPairing] = useState(seed.phase === "pairing");
  const [refused, setRefused] = useState<SaidRefusal | null | undefined>(undefined);
  const live = useLive();
  useEffect(
    () => () => {
      if (spent.current || !offer) return;
      spent.current = true;
      door.dismiss(offer.ticket);
    },
    [door, offer],
  );
  const dontPair = (): void => {
    if (offer && !spent.current) {
      spent.current = true;
      door.dismiss(offer.ticket);
    }
    back();
  };
  const press = (): void => {
    if (!offer || spent.current) return;
    spent.current = true;
    setPairing(true);
    door.pair(offer.ticket).then(
      (answer) => {
        if (!live.current) return;
        const paired = pairedOf(answer);
        if (paired === true) return to({ step: "mirror" }, { replace: true });
        setPairing(false);
        setRefused(paired);
      },
      () => {
        if (!live.current) return;
        setPairing(false);
        setRefused(null);
      },
    );
  };
  const acts =
    refused !== undefined ? (
      <Button size="l" keyHint="↵" onPress={() => to({ step: "scan" }, { replace: true })}>
        {t("welcome.scan")}
      </Button>
    ) : (
      <>
        <Button size="l" keyHint="↵" disabled={pairing || !offer} onPress={press}>
          {pairing ? t("confirm.pairing") : t("confirm.pair")}
        </Button>
        {pairing ? null : (
          <Button size="l" kind="quiet" onPress={dontPair}>
            {t("confirm.dontPair")}
          </Button>
        )}
      </>
    );
  return (
    <Page
      columns={2}
      back={<Button kind="quiet" icon="back" label={t("back")} onPress={dontPair} />}
      refusal={refused === undefined ? undefined : [say(refused)]}
      material={offer ? <Measured facts={offer.facts} t={t} /> : undefined}
      line={t("confirm.line")}
      acts={acts}
    >
      <Said text={t("confirm.say")} />
    </Page>
  );
}
