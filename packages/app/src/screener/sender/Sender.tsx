/**
 * ONE SENDER OPEN: the sentence with the place to press, what this install may do with a decision said whole, the
 * held letters (the column opens on the newest), and the decision in the panel at the column's foot. Opening a sender
 * reads nothing and marks nothing read; the panel's press is the view's `decide`, the one way a decision leaves.
 */
import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  isSharedDomain,
  refused,
  useHeldBodies,
  viewSender,
  type ScreenerView,
} from "@ohmail/app-logic/screener";
import { Sheet } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";
import { useScreener, useScreenerBeside } from "../contract.js";
import { HeldLetter } from "../held/HeldLetter.js";
import { Card, type CardActions } from "./Card.js";
import { KeptPanel } from "./Kept.js";
import { useNewestFirst } from "./newest.js";
import { Panel } from "./Panel.js";
import { PlaceMenu } from "./PlaceMenu.js";
import { DecisionLines, Sentence, whoOf } from "./Sentence.js";

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

export interface SenderWindow {
  key: string;
  from: number;
}

function useSenderWindow(view: ScreenerView, phoneWindow: RefObject<SenderWindow | null> | undefined) {
  const open = view.open;
  const held = open === null ? [] : viewSender(open).held;
  const enteredAt = held.findIndex((letter) => letter.id === view.enteredLetter);
  const entered = held[enteredAt]?.id;
  const key = `${view.segment}:${view.openId ?? ""}:${entered ?? ""}`;
  const [restored] = useState(() =>
    phoneWindow?.current?.key === key ? phoneWindow.current.from : undefined,
  );
  const { scroller, ready, from, busy } = useNewestFirst(
    key,
    entered ?? (held.length > 1 ? (held[held.length - 1]?.id ?? null) : null),
    held.length,
    enteredAt < 0 ? restored : enteredAt,
    restored !== undefined && enteredAt < 0,
  );
  useLayoutEffect(() => {
    if (phoneWindow) phoneWindow.current = { key, from };
  }, [phoneWindow, key, from]);
  const shown = held.slice(from);
  useHeldBodies(ready ? shown.map((letter) => letter.id) : []);
  return { open, entered, held, scroller, ready, from, busy, shown };
}

export function Sender({
  view,
  phoneWindow,
}: {
  view: ScreenerView;
  phoneWindow?: RefObject<SenderWindow | null>;
}) {
  const t = useText("screener");
  const model = useScreener();
  const { subjectRule: SubjectRule } = useScreenerBeside();
  const [unsubscribedLetters, setUnsubscribedLetters] = useState<ReadonlyMap<string, string | null>>(
    new Map(),
  );
  const [cardLetter, setCardLetter] = useState<{ row: string; id: string } | null>(null);
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
  const { open, entered, held, scroller, ready, from, busy, shown } = useSenderWindow(view, phoneWindow);
  if (open === null) return null;
  const sender = viewSender(open);
  const account = model.accountScope ?? null;
  const decided = view.decided.some((d) => d.sender.id === sender.id);
  const waiting = view.segment === "waiting";
  const choosing = waiting && !decided && !refused(model.role);
  const shared = isSharedDomain(sender.from.address);
  const scope = shared ? "sender" : view.scopeOf(sender);
  const messageId = cardLetter?.row === sender.id ? cardLetter.id : (entered ?? sender.id);
  const domainScope = choosing && scope === "domain";
  const card = (actions?: CardActions) => (
    <Card view={view} sender={sender} anchor={cardAnchor} choosing={choosing} actions={actions} />
  );
  return (
    <Sheet
      kind="reading"
      label={whoOf(sender)}
      back={{ word: t("title"), onPress: view.close }}
      scroller={scroller}
      manualScrollAnchor
      fixedHead={
        <Sentence
          view={view}
          sender={sender}
          choosing={choosing}
          shared={shared}
          scope={scope}
          slotAt={slotAt}
          cardAt={cardAt}
          onCard={() => {
            cardFrom.current = null;
            setCardLetter(null);
            view.show("card");
          }}
          scopeAt={scopeAt}
          unsubscribed={!waiting && held.some((letter) => unsubscribedLetters.get(letter.id) === account)}
        />
      }
      head={waiting ? <DecisionLines sender={sender} /> : undefined}
      foot={waiting ? <Panel view={view} /> : <KeptPanel view={view} />}
    >
      <Sheet kind="plain">
        <DeliveredTo mailboxId={sender.mailboxId} />
      </Sheet>
      <div className="sc-held-letters" role="feed" aria-label={whoOf(sender)} aria-busy={busy}>
        {shown.map((letter, index) => (
          <HeldLetter
            key={letter.id}
            letter={letter}
            position={{ at: from + index + 1, total: held.length }}
            showBody={ready}
            from={sender.from}
            checked={sender.checked}
            segment={view.segment}
            invites
            onPerson={(at) => {
              cardFrom.current = at;
              setCardLetter({ row: sender.id, id: letter.id });
              view.show("card");
            }}
            onRetry={view.retryBody}
            onUnsubscribed={() =>
              setUnsubscribedLetters((letters) => new Map(letters).set(letter.id, account))
            }
          />
        ))}
      </div>
      <PlaceMenu view={view} sender={sender} open={view.shown === "place"} anchor={slotAt} card={false} />
      {SubjectRule && held.some((letter) => letter.id === messageId) ? (
        <SubjectRule
          key={`${sender.id}:${messageId}`}
          messageId={messageId}
          senderAddress={sender.from.address}
          anchor={cardAnchor}
          eligible={choosing && !domainScope}
          cardOpen={view.shown === "card"}
          domainScope={domainScope}
          auditOpen={view.shown === "audit"}
          onAudit={() => view.show("audit")}
          open={view.shown === "subject"}
          onOpen={() => view.show("subject")}
          onBack={() => view.show("card")}
          onClose={() => view.show(null)}
        >
          {card}
        </SubjectRule>
      ) : (
        card()
      )}
    </Sheet>
  );
}
