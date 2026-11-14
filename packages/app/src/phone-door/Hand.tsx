/**
 * A PAIRING BY HAND: the server's address and the pairing token that stands beside its code. The token's blank is a
 * password's: what is typed stands in the blank alone, goes into the one `hand` of its press, and is gone from the
 * blank in the same handler. A whole link pasted into it wins over the address: it goes as the token with the
 * address as it stands, and native reads it. A whole link pasted into the address goes as the token too, with no
 * address, and leaves that blank in the same handler. What answered is confirmed on the next step, never here.
 */
import { useRef, useState, type ReactNode } from "react";
import { Button, Page } from "@ohmail/ui/base";
import { DoorForm } from "../doors/stage/DoorForm.js";
import { SaidWith } from "../doors/stage/Said.js";
import { SentenceBlank } from "../doors/stage/SentenceBlank.js";
import { sendCode, useLive } from "./answers.js";
import type { SaidRefusal } from "./contract.js";
import { useDoorWords } from "./namespace.js";
import type { StepProps } from "./states.js";

export function Hand({ door, seed, to, back }: StepProps): ReactNode {
  const { t, say } = useDoorWords();
  const [address, setAddress] = useState(seed.address ?? "");
  const [refused, setRefused] = useState<SaidRefusal | null | undefined>(seed.said);
  const [busy, setBusy] = useState(false);
  const token = useRef<HTMLInputElement>(null);
  const live = useLive();
  const press = (): void => {
    if (busy) return;
    setBusy(true);
    const typed = address.trim();
    /* A whole link in the address blank is no address: it goes as the token and leaves the blank now. */
    const link = typed.includes("#") ? typed : undefined;
    if (link !== undefined) setAddress("");
    void sendCode(door, link !== undefined || typed === "" ? null : typed, token, link).then((handed) => {
      if (!live.current) {
        if (handed.k === "offers") door.dismiss(handed.offer.ticket);
        return;
      }
      setBusy(false);
      if (handed.k === "offers") to({ step: "confirm", offer: handed.offer });
      else setRefused(handed.said);
    });
  };
  const addressRefused = refused?.code === "pairBadAddress";
  return (
    <DoorForm onSubmit={press}>
      <Page
        smaller
        back={<Button kind="quiet" icon="back" label={t("back")} onPress={back} />}
        refusal={refused === undefined ? undefined : [say(refused)]}
        line={[{ heavy: t("hand.line") }, { note: t("hand.note") }]}
        acts={
          <Button type="submit" size="l" keyHint="↵" disabled={busy}>
            {t("hand.pair")}
          </Button>
        }
      >
        <SaidWith
          parts={t.rich("hand.say", {
            address: () => (
              <SentenceBlank
                label={t("hand.addressLabel")}
                placeholder={t("hand.addressBlank")}
                size={t("hand.addressBlank").length}
                inputMode="url"
                value={address}
                refused={addressRefused}
                onChange={setAddress}
              />
            ),
            token: () => (
              <SentenceBlank
                ref={token}
                type="password"
                label={t("hand.tokenLabel")}
                placeholder={t("hand.tokenBlank")}
                size={t("hand.tokenBlank").length}
                refused={refused !== undefined && !addressRefused}
              />
            ),
          })}
        />
      </Page>
    </DoorForm>
  );
}
