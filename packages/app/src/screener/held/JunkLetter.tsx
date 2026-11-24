/**
 * ONE LETTER OF JUNK, OPEN: who filed it, its text read from the mail server as text only (Junk is the one pile whose
 * letters are hostile by definition, so never its html), and its presses in the panel. Not junk is one move back to
 * the inbox, where it arrives again as new mail; Not junk, always allow also lets the sender in from now on. A move
 * that stands is said where the presses were; one the mail server refused is said, and can be asked again or left.
 */
import { useRef, useState } from "react";
import { junkKey, junkLabelOf } from "@ohmail/app-logic/screener";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { Dot, Menu, MenuItem, RefusalLine, Sentence, Slot, Tag } from "@ohmail/ui/base";
import { ActionPanel, Message, MessageHead, Sheet, type PanelNote, type PanelVerb } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";
import { junkWho, useJunkStamp } from "../list/Junk.js";
import type { ScreenerJunk, ScreenerJunkItem } from "../ports.js";

function Body({ junk, item }: { junk: ScreenerJunk; item: ScreenerJunkItem }) {
  const t = useText("screener");
  const body = junk.bodyFor(item);
  if (body.phase === "ready") return <>{body.text}</>;
  if (body.phase === "failed")
    return (
      <RefusalLine way={{ label: t("junkRetry"), onPress: () => junk.openBody(item, { retry: true }) }}>
        {t("junkBodyFailed")}
      </RefusalLine>
    );
  /* Idle is no request at all: nothing is said to be reading. */
  if (body.phase === "idle") return null;
  return (
    <p className="oh-text" role="status" aria-busy="true">
      {t("junkBodyLoading")}
    </p>
  );
}

/** The Junk slot uses the same rescue actions as the panel. */
function JunkHead({ item, rescue }: { item: ScreenerJunkItem; rescue: readonly PanelVerb[] }) {
  const t = useText("screener");
  const at = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const label = t("junkActions");
  const place = t("segJunk");
  const address = displayAddress(item.from.address);
  const canAsk = rescue.length > 0;
  return (
    <div>
      <Sentence level={2}>
        {t.rich("place.goes", {
          who: address,
          place,
          slot: () =>
            canAsk ? (
              <Slot ref={at} label={label} expanded={open} onPress={() => setOpen((was) => !was)}>
                {place}
              </Slot>
            ) : (
              <b>{place}</b>
            ),
        })}
        <Dot kind="ink" />
      </Sentence>
      <p className="oh-text sc-sentence-tools">
        <span>{address}</span>
        <Tag>{t(junkLabelOf({ origin: item.origin }))}</Tag>
      </p>
      {item.rescue === "refused" ? <RefusalLine>{t("junkRescueRefused")}</RefusalLine> : null}
      <Menu open={canAsk && open} onClose={() => setOpen(false)} anchor={at} label={label}>
        {rescue.map((verb) => (
          <MenuItem
            key={verb.id}
            disabled={verb.disabled}
            onPress={() => {
              setOpen(false);
              if (at.current !== null) verb.onPress?.(at.current);
            }}
          >
            {verb.label}
          </MenuItem>
        ))}
      </Menu>
    </div>
  );
}

export function JunkLetter({
  junk,
  item,
  onBack,
}: {
  junk: ScreenerJunk;
  item: ScreenerJunkItem;
  /** On one column, the way back to the list (the kit draws it on a phone). */
  onBack?: () => void;
}) {
  const t = useText("screener");
  const stamp = useJunkStamp()(item);
  const who = junkWho(item);
  const busy = junk.rescuing(item);
  /* What did not fit the panel (Leave it in Junk, on a phone) stands behind More, as the reader's panel offers it. */
  const [folded, setFolded] = useState<readonly string[]>([]);
  const [more, setMore] = useState(false);
  const moreAt = useRef<HTMLElement | null>(null);
  const rescue: PanelVerb[] =
    item.rescue === "queued"
      ? []
      : [
          {
            id: "notjunk",
            label: t("junkNotJunk"),
            kind: "soft",
            rank: 0,
            disabled: busy,
            onPress: () => junk.rescue(item),
          },
          {
            id: "allow",
            label: t("junkAllow"),
            kind: "soft",
            rank: 0,
            disabled: busy,
            onPress: () => junk.rescue(item, { allow: true }),
          },
        ];
  const items: (PanelNote | PanelVerb)[] =
    item.rescue === "queued"
      ? [{ note: t("junkRescueQueued"), keep: true }]
      : [
          ...rescue,
          ...(item.rescue === "refused" && item.rescueId !== undefined
            ? [
                {
                  id: "leave",
                  label: t("junkRescueDismiss"),
                  kind: "soft" as const,
                  rank: 1,
                  disabled: busy,
                  onPress: () => junk.dismissRescue(item),
                },
              ]
            : []),
        ];
  return (
    <Sheet
      kind="reading"
      label={who}
      back={onBack ? { word: t("segJunk"), onPress: onBack } : undefined}
      head={<JunkHead key={junkKey(item)} item={item} rescue={rescue} />}
      foot={
        <>
          <ActionPanel
            label={t("place.panel")}
            items={items}
            folded={folded}
            onFold={setFolded}
            more={{
              label: t("place.more"),
              behind: false,
              expanded: more || undefined,
              onPress: (at) => {
                moreAt.current = at;
                setMore((m) => !m);
              },
            }}
          />
          <Menu open={more} onClose={() => setMore(false)} anchor={moreAt} label={t("place.more")} up right>
            {items
              .filter((v): v is PanelVerb => "id" in v && folded.includes(v.id))
              .map((v) => (
                <MenuItem
                  key={v.id}
                  disabled={v.disabled}
                  onPress={() => {
                    setMore(false);
                    if (moreAt.current !== null) v.onPress?.(moreAt.current);
                  }}
                >
                  {v.label}
                </MenuItem>
              ))}
          </Menu>
        </>
      }
    >
      <Message
        head={
          <MessageHead
            sender={{ name: who, address: displayAddress(item.from.address) }}
            stamp={{ when: stamp.when, full: false, title: stamp.when }}
          />
        }
        subject={item.subject}
      >
        <Body junk={junk} item={item} />
      </Message>
    </Sheet>
  );
}
