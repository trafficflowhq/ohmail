/**
 * ONE SENDER OPEN: the sentence with the place to press, what this install may do with a decision said whole, the
 * held letters (the column opens on the newest), and the decision in the panel at the column's foot. Opening a sender
 * reads nothing and marks nothing read; the panel's press is the view's `decide`, the one way a decision leaves.
 */
import { useMemo, useRef, type RefObject } from "react";
import { viewSender, type ScreenerView } from "@ohmail/app-logic/screener";
import { Sheet } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";
import { useScreener, useScreenerBeside } from "../contract.js";
import { HeldLetter } from "../held/HeldLetter.js";
import { Card } from "./Card.js";
import { KeptLines, KeptPanel } from "./Kept.js";
import { useNewestFirst } from "./newest.js";
import { Panel } from "./Panel.js";
import { PlaceMenu } from "./PlaceMenu.js";
import { Sentence, whoOf } from "./Sentence.js";

/**
 * What this install may do, said whole under the sentence where it names no holder: when an organizer elsewhere files
 * what is decided here, that nothing organizes the mailbox, and that a mailbox signed in with OAuth is decided where it
 * is organized. Who decides stands in the panel, by the one decider.
 */
function RoleLines() {
  const t = useText("screener");
  const { role } = useScreener();
  if (role.mode === "pending") return <p className="oh-text">{t("pendingBarWhy")}</p>;
  if (role.mode !== "blocked") return null;
  return (
    <>
      {role.reason === "no_organizer" ? <p className="oh-text">{t("readerBarNoneWhy")}</p> : null}
      {role.oauthOnly ? <p className="oh-text">{t("oauthDecideElsewhere")}</p> : null}
    </>
  );
}

/**
 * Which of the account's addresses this sender wrote to, where it has several: a decision writes a rule over the whole
 * account, and this is the evidence for it. Nothing where there is one mailbox.
 */
function DeliveredTo({ mailboxId }: { mailboxId: string | undefined }) {
  const t = useText("screener");
  const { mailboxWord } = useScreenerBeside();
  const label = mailboxId ? mailboxWord(mailboxId) : null;
  return label ? <p className="oh-text">{t("place.deliveredTo", { label })}</p> : null;
}

export function Sender({ view }: { view: ScreenerView }) {
  const t = useText("screener");
  const slotAt = useRef<HTMLButtonElement | null>(null);
  const cardAt = useRef<HTMLButtonElement | null>(null);
  const scopeAt = useRef<HTMLButtonElement | null>(null);
  /* The card stands at the name that was pressed: the address under the sentence, or a letter's sender. */
  const cardFrom = useRef<Element | null>(null);
  const cardAnchor = useMemo(
    (): RefObject<Element | null> => ({
      get current() {
        return cardFrom.current ?? cardAt.current;
      },
    }),
    [],
  );
  const open = view.open;
  const held = open === null ? [] : viewSender(open).held;
  const entered = held.find((letter) => letter.id === view.enteredLetter)?.id;
  const scroller = useNewestFirst(
    `${view.segment}:${view.openId ?? ""}:${entered ?? ""}`,
    entered ?? (held.length > 1 ? (held[held.length - 1]?.id ?? null) : null),
  );
  if (open === null) return null;
  const sender = viewSender(open);
  const decided = view.decided.some((d) => d.sender.id === sender.id);
  const waiting = view.segment === "waiting";
  return (
    <Sheet
      kind="reading"
      label={whoOf(sender)}
      back={{ word: t("title"), onPress: view.close }}
      scroller={scroller}
      head={
        <Sentence
          view={view}
          sender={sender}
          decided={decided}
          slotAt={slotAt}
          cardAt={cardAt}
          onCard={() => {
            cardFrom.current = null;
            view.show("card");
          }}
          scopeAt={scopeAt}
        />
      }
      foot={waiting ? <Panel view={view} /> : <KeptPanel view={view} />}
    >
      <Sheet kind="plain">
        {waiting ? <RoleLines /> : <KeptLines view={view} />}
        <DeliveredTo mailboxId={sender.mailboxId} />
        {sender.held.length > 1 ? (
          <p className="oh-text">{t("place.held", { count: sender.held.length })}</p>
        ) : null}
      </Sheet>
      {sender.held.map((letter) => (
        <HeldLetter
          key={letter.id}
          letter={letter}
          from={sender.from}
          checked={sender.checked}
          segment={view.segment}
          invites
          onPerson={(at) => {
            cardFrom.current = at;
            view.show("card");
          }}
          onRetry={view.retryBody}
        />
      ))}
      <PlaceMenu view={view} sender={sender} open={view.shown === "place"} anchor={slotAt} card={false} />
      <Card view={view} sender={sender} anchor={cardAnchor} choosing={waiting && !decided} />
    </Sheet>
  );
}
