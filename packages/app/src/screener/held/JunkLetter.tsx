/**
 * ONE LETTER OF JUNK, OPEN: who filed it, its text read from the mail server as text only (Junk is the one pile whose
 * letters are hostile by definition, so never its html), and its presses in the panel. Not junk is one move back to
 * the inbox, where it arrives again as new mail; Not junk, always allow also lets the sender in from now on. A move
 * that stands is said where the presses were; one the mail server refused is said, and can be asked again or left.
 */
import { useRef, useState } from "react";
import { junkLabelOf } from "@ohmail/app-logic/screener";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { Dot, Menu, MenuItem, RefusalLine, Sentence } from "@ohmail/ui/base";
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

/** Who wrote it, who filed it (or that the move was refused), and what the two presses do. */
function JunkHead({ item, who }: { item: ScreenerJunkItem; who: string }) {
  const t = useText("screener");
  return (
    <div>
      <Sentence level={2}>
        {who}
        <Dot kind="ink" />
      </Sentence>
      {item.rescue === "refused" ? (
        <RefusalLine>{t("junkRescueRefused")}</RefusalLine>
      ) : (
        <p className="oh-text">{t(junkLabelOf(item))}</p>
      )}
      {item.rescue === "queued" ? null : (
        <>
          <p className="oh-text">{t("junkNotJunkNote")}</p>
          <p className="oh-text">{t("junkAllowNote")}</p>
        </>
      )}
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
  const items: (PanelNote | PanelVerb)[] =
    item.rescue === "queued"
      ? [{ note: t("junkRescueQueued"), keep: true }]
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
      head={<JunkHead item={item} who={who} />}
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
