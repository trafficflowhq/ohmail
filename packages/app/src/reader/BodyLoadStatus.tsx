import { useState } from "react";
import { useEngineOrNull } from "@ohmail/app-logic/engine";
import { useBodyStalled } from "@ohmail/app-logic/reader";
import { useSessionDead } from "@ohmail/app-logic/session/session-truth";
import { TextNotKept } from "@ohmail/ui/mail";
import { useFrame } from "../frame/commands.js";
import { NONE } from "../host/index.js";
import { useText } from "../text/index.js";

export function BodyLoadStatus({
  state,
  messageId,
  preview = false,
  retry,
}: {
  state: "loading" | "failed";
  messageId: string;
  preview?: boolean;
  retry?: () => void;
}) {
  const tb = useText("body");
  const engine = useEngineOrNull();
  const { host } = useFrame();
  const dead = useSessionDead();
  const [attempt, setAttempt] = useState(0);
  const stalled = useBodyStalled(messageId, state === "loading", attempt);
  if (state === "loading" && !stalled) return <TextNotKept kind="fine" line={tb("loading")} live />;
  const recover = host.session.recover;
  return dead ? (
    <TextNotKept
      kind="refused"
      warn={tb("sessionEnded")}
      way={
        !preview && recover !== NONE ? { label: tb("signIn"), onPress: () => recover("signIn") } : undefined
      }
    />
  ) : (
    <TextNotKept
      kind="refused"
      warn={tb("kept.failed")}
      way={
        preview
          ? undefined
          : {
              label: tb("kept.tryAgain"),
              onPress: () => {
                setAttempt((previous) => previous + 1);
                if (retry) retry();
                else void engine?.hydrateBody(messageId, { retry: true });
              },
            }
      }
    />
  );
}
