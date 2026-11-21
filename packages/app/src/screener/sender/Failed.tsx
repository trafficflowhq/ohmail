/**
 * A LETTER ITS PROVIDER FAILED, OPEN: what the check found, the letter itself (held, so shown and never read), and its
 * own two answers in the panel. It is decided alone, never by a rule: Not from them files it to Spam, It's from them
 * to the Ohbox. Filing it moves mail, so an install that does not organize this mailbox draws no answer: what this
 * computer may not do, or who decides, and the way to Mailboxes.
 */
import { useState } from "react";
import type { FailedAtGateDTO } from "@ohmail/wire";
import { senderCheckSentence, useHeldBodies, type ScreenerView } from "@ohmail/app-logic/screener";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { Dot, Sentence } from "@ohmail/ui/base";
import { ActionPanel, ContactCard, Sheet, type PanelNote, type PanelVerb } from "@ohmail/ui/mail";
import { useFrame } from "../../frame/commands.js";
import { useText } from "../../text/index.js";
import { useScreener } from "../contract.js";
import { HeldLetter } from "../held/HeldLetter.js";
import { IdentityNotice } from "./IdentityNotice.js";
import { decidesNote } from "./holder.js";

export function Failed({ view, letter }: { view: ScreenerView; letter: FailedAtGateDTO }) {
  useHeldBodies([letter.id]);
  const t = useText("screener");
  const screening = useText("screening");
  const model = useScreener();
  const { commands } = useFrame();
  const address = displayAddress(letter.from.address);
  const caution = senderCheckSentence(t, { reason: "failed", address: letter.from.address });
  const [card, setCard] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const file = (to: "spam" | "ohbox") => {
    model.fileFailed(letter.id, to);
    view.close();
  };
  const { role } = model;
  const items: (PanelNote | PanelVerb)[] =
    role.mode === "organizer"
      ? [
          {
            id: "spam",
            label: letter.own ? t("failedNotFromYou") : t("failedNotFromThem"),
            kind: "soft",
            rank: 0,
            onPress: () => file("spam"),
          },
          {
            id: "ohbox",
            label: letter.own ? t("failedFromYou") : t("failedFromThem"),
            kind: "soft",
            rank: 0,
            onPress: () => file("ohbox"),
          },
        ]
      : [
          { note: role.mode === "pending" ? t("moveBarTitle") : decidesNote(t, role), keep: true },
          {
            id: "mailboxes",
            label: t("readerBarOpenMailboxes"),
            rank: 0,
            onPress: () => commands.go({ place: "settings", sub: "mailboxes" }),
          },
        ];
  return (
    <Sheet
      kind="reading"
      label={t("place.checkFailedTitle")}
      back={{ word: t("title"), onPress: view.close }}
      head={
        <div>
          <Sentence level={2}>
            {t("place.checkFailedTitle")}
            <Dot kind="ink" />
          </Sentence>
          <p className="oh-text">{address}</p>
          <p className="oh-text">{caution}</p>
        </div>
      }
      foot={<ActionPanel label={t("failedAria")} items={items} />}
    >
      <HeldLetter
        letter={letter}
        from={letter.from}
        checked={{ reason: "failed" }}
        segment="waiting"
        invites={false}
        onPerson={(anchor) => setCard({ id: letter.id, anchor })}
        onRetry={view.retryBody}
      />
      <ContactCard
        open={card?.id === letter.id}
        anchor={card?.anchor}
        onClose={() => setCard(null)}
        label={t("place.keyCard")}
        closeWhenFull={screening("auditClose")}
        person={{ name: letter.from.name?.trim() || address, address }}
        notice={<IdentityNotice>{caution}</IdentityNotice>}
      />
    </Sheet>
  );
}
