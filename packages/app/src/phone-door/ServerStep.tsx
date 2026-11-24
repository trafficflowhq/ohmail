/**
 * A SERVER YOU RUN, BY ITS ADDRESS. The person types the address they open ohmail at; Continue asks native what
 * answers there (`server.ask`, which spends nothing). Reached: its address, where its mail API answers, and the two
 * ways on: scan its code, or type its pairing token. Refused: native's refusal, said by its code, and the blank
 * marked. The address is no secret; a pairing token is never asked here, and a whole link pasted into the blank
 * leaves it at the press.
 */
import { useState, type ReactNode } from "react";
import { Button, Page, Sentence, type PageLinePart } from "@ohmail/ui/base";
import { DoorForm } from "../doors/stage/DoorForm.js";
import { SaidWith } from "../text/Said.js";
import { SentenceBlank } from "../text/SentenceBlank.js";
import { useLive } from "./answers.js";
import type { PhoneDoorConfig, PhoneServerAnswer, SaidRefusal } from "./contract.js";
import { useDoorWords } from "./namespace.js";
import type { StepProps } from "./states.js";

const CERTIFICATE = {
  android: "server.certificate.android",
  ios: "server.certificate.ios",
} as const satisfies { readonly [O in PhoneDoorConfig["os"]]: string };

/** Where the step stands: typing, asking, an answer that reached a server, or a refusal (null: no sentence crossed). */
type At =
  | { readonly k: "typing" }
  | { readonly k: "checking" }
  | { readonly k: "reached"; readonly address: string; readonly apiUnder: string | null }
  | { readonly k: "refused"; readonly said: SaidRefusal | null };

function atOf(seed: StepProps["seed"]): At {
  if (seed.said) return { k: "refused", said: seed.said };
  if (seed.phase === "checking") return { k: "checking" };
  if (seed.phase === "reached" || seed.phase === "reachedApi")
    return { k: "reached", address: seed.address ?? "", apiUnder: seed.apiUnder ?? null };
  return { k: "typing" };
}

/** An answer read by its shape: anything that is not a reached server or a refusal with its words is no answer. */
function answered(answer: PhoneServerAnswer | null | undefined): At {
  if (answer?.k === "reached" && typeof answer.address === "string")
    return {
      k: "reached",
      address: answer.address,
      apiUnder: typeof answer.apiUnder === "string" ? answer.apiUnder : null,
    };
  if (answer?.k === "refused" && typeof answer.said?.code === "string")
    return { k: "refused", said: answer.said };
  return { k: "refused", said: null };
}

export function ServerStep({ door, seed, to, back }: StepProps): ReactNode {
  const { t, say } = useDoorWords();
  const [address, setAddress] = useState(seed.address ?? "");
  const [at, setAt] = useState<At>(() => atOf(seed));
  const live = useLive();
  const settled = at.k === "checking" || at.k === "reached";
  const ask = (): void => {
    if (settled) return;
    setAt({ k: "checking" });
    /* A whole link pasted here leaves the blank at the press: its token is drawn nowhere. */
    if (address.includes("#")) setAddress("");
    door.ask(address.trim()).then(
      (answer) => live.current && setAt(answered(answer)),
      () => live.current && setAt({ k: "refused", said: null }),
    );
  };
  if (at.k === "refused" && at.said?.code === "managedDeferred") {
    return (
      <Page
        smaller
        back={<Button kind="quiet" icon="back" label={t("back")} onPress={back} />}
        refusal={[say(at.said)]}
        acts={
          <Button size="l" onPress={back}>
            {t("terms.chooseOther")}
          </Button>
        }
      >
        <Sentence size="xl" level={1} end="hot">
          {t("server.cloud")}
        </Sentence>
      </Page>
    );
  }
  const line: PageLinePart[] | undefined =
    at.k === "reached"
      ? [
          { heavy: t("server.reached", { address: at.address }) },
          ...(at.apiUnder === null ? [] : [{ note: t("server.reachedApi", { apiUnder: at.apiUnder }) }]),
        ]
      : at.k === "refused"
        ? /* A refusal names its own fix: nothing stands beside it. */ undefined
        : [{ heavy: t("server.hint") }, { note: t(CERTIFICATE[door.config.os]) }];
  return (
    <DoorForm onSubmit={ask}>
      <Page
        smaller
        back={<Button kind="quiet" icon="back" label={t("back")} onPress={back} />}
        refusal={at.k === "refused" ? [say(at.said)] : undefined}
        line={line}
        acts={
          at.k === "reached" ? (
            <>
              <Button size="l" keyHint="↵" onPress={() => to({ step: "scan" })}>
                {t("server.scanCode")}
              </Button>
              <Button size="l" kind="two" onPress={() => to({ step: "hand", address: at.address })}>
                {t("server.token")}
              </Button>
            </>
          ) : (
            <Button type="submit" size="l" keyHint="↵" disabled={at.k === "checking"}>
              {at.k === "checking" ? t("server.checking") : t("server.continue")}
            </Button>
          )
        }
      >
        <SaidWith
          dot={at.k === "reached" ? "ink" : "hot"}
          parts={t.rich("server.say", {
            blank: () => (
              <SentenceBlank
                label={t("server.label")}
                placeholder={t("server.blank")}
                size={t("server.blank").length}
                inputMode="url"
                value={address}
                refused={at.k === "refused"}
                onChange={settled ? undefined : setAddress}
              />
            ),
          })}
        />
      </Page>
    </DoorForm>
  );
}
