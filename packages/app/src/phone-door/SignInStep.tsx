import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button, Page } from "@ohmail/ui/base";
import { DoorForm } from "../doors/stage/DoorForm.js";
import { Said, SaidWith } from "../text/Said.js";
import { SentenceBlank } from "../text/SentenceBlank.js";
import type { SaidRefusal } from "./contract.js";
import { useDoorWords } from "./namespace.js";
import type { StepProps } from "./states.js";

export function SignInStep({ door, seed, back }: StepProps) {
  const { t, say } = useDoorWords();
  const selfHosted = seed.address !== undefined;
  const [address, setAddress] = useState(seed.address ?? "");
  const [waiting, setWaiting] = useState(!selfHosted);
  const state = useSyncExternalStore(door.state.subscribe, door.state.read, door.state.read);
  const finishing = waiting && state.session === "opening";
  const [reason, setReason] = useState<{ said: SaidRefusal | null } | null>(null);
  const active = useRef<AbortController | null>(null);
  const begin = useCallback(
    async (target: string | null) => {
      if (active.current !== null) return;
      const attempt = new AbortController();
      active.current = attempt;
      setWaiting(true);
      setReason(null);
      if (target?.includes("#") || target?.includes("@")) setAddress("");
      try {
        const answer = await door.signIn(target, attempt.signal);
        if (!attempt.signal.aborted && answer?.ok !== true) setReason({ said: answer?.said ?? null });
      } catch {
        if (!attempt.signal.aborted) setReason({ said: null });
      } finally {
        if (active.current === attempt) {
          active.current = null;
          setWaiting(false);
        }
      }
    },
    [door],
  );
  useEffect(() => {
    if (!selfHosted) void begin(null);
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [begin, selfHosted]);

  return (
    <DoorForm
      onSubmit={() => {
        if (selfHosted) void begin(address);
      }}
    >
      <Page
        smaller
        back={finishing ? undefined : <Button kind="quiet" icon="back" label={t("back")} onPress={back} />}
        refusal={reason ? [say(reason.said)] : undefined}
        line={waiting ? t(finishing ? "signIn.finishing" : "signIn.waiting") : undefined}
        acts={
          selfHosted && !waiting ? (
            <Button type="submit" size="l">
              {t("server.continue")}
            </Button>
          ) : null
        }
      >
        {selfHosted && !waiting ? (
          <SaidWith
            parts={t.rich("server.say", {
              blank: () => (
                <SentenceBlank
                  label={t("server.label")}
                  placeholder={t("server.blank")}
                  size={t("server.blank").length}
                  inputMode="url"
                  value={address}
                  onChange={setAddress}
                />
              ),
            })}
          />
        ) : (
          <Said text={t(selfHosted ? "welcome.signInSelfHosted" : "welcome.signIn")} />
        )}
      </Page>
    </DoorForm>
  );
}
