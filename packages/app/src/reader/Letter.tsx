/**
 * ONE LETTER OF THE COLUMN: the kit's message sheet around the body the shell hands in. The wrapper carries the read
 * rule's facts; the text stands in its own block; the body's own controls stand in the head and above the text.
 */
import { useCallback, useState } from "react";
import {
  BlockedImages,
  LetterHistory,
  LetterViews,
  Message,
  MessageHead,
  TextNotKept,
} from "@ohmail/ui/mail";
import {
  emptiedForSpace,
  isProtected,
  letterPictures,
  letterReady,
  useLetterBody,
  withheldKeyOf,
} from "@ohmail/app-logic/reader";
import { headStamp, placeOfFolder, readerZone } from "@ohmail/app-logic/reader";
import { useLiveBody } from "@ohmail/app-logic/reading";
import { useSessionDead } from "@ohmail/app-logic/session/session-truth";
import { useEngineOrNull } from "@ohmail/app-logic/engine";
import type { EngineMessage, MessageBody } from "@ohmail/client-engine";
import { useFrame } from "../frame/commands.js";
import { useSignal } from "../frame/feeds.js";
import { useMailboxStatus, useMailboxWord, useOwnAddresses } from "../frame/room.js";
import { NONE } from "../host/index.js";
import { useLocale, useText } from "../text/index.js";
import type { ContactOf } from "./contact/Contact.js";
import { LetterFiles } from "./files/Files.js";
import { LetterMenu } from "./actions/LetterMenu.js";
import { useParts } from "./parts.js";
import type { LetterControl, LetterNotice } from "./ports.js";

/** A load the mail server refused: its own sentence. */
const REFUSED = {
  gone: "liveGone",
  too_large: "liveTooLarge",
  busy: "liveBusy",
  unreachable: "liveUnreachable",
  failed: "liveFailed",
} as const;

/** The words of each reason the text is kept elsewhere: a short title, its sentence, its fine line (`body.kept.*`). */
const KEPT = {
  withheld: "emptied",
  withheldJunk: "junk",
  withheldExpunged: "expunged",
  withheldTooLarge: "tooLarge",
} as const;

const nameOf = (p: { name: string | null; address: string }): string => p.name?.trim() || p.address;

const stampOf = (m: EngineMessage): string | null => m.date || m.arrivedAt || null;
/** A person as the details print them: the name and the whole address, or the address alone. */
const whole = (p: { name: string | null; address: string }): string =>
  p.name?.trim() ? `${p.name.trim()} ${p.address}` : p.address;

export interface LetterViewProps {
  readonly message: EngineMessage;
  /** Unread as the column presents it. */
  readonly unread: boolean;
  /** `tint`: the sheet is washed and a hidden word says unread; `dot`: the head's dot. */
  readonly look: "tint" | "dot";
  /** Read, not only peeked at: its embedded pictures may be asked for. */
  readonly reading: boolean;
  /** The row is the presented mirror's; false: the hold is unknown and no picture loads by itself. */
  readonly presented: boolean;
  /** The head is narrow: its stamp prints the day and the month, the full form on a press. */
  readonly narrow?: boolean;
  readonly onPerson: (person: ContactOf) => void;
}

export function Letter({ message, unread, look, reading, presented, narrow, onPerson }: LetterViewProps) {
  const t = useText("reader");
  const tm = useText("message");
  const parts = useParts();
  const { host } = useFrame();
  const scheme = useSignal(host.device.appearance).scheme;
  const body = useLetterBody(message);
  const [notice, setNotice] = useState<LetterNotice | null>(null);
  const [controls, setControls] = useState<readonly LetterControl[]>([]);
  const liveWire = host.wires.liveBody;
  const live = useLiveBody(message.id, emptiedForSpace(body) && liveWire !== NONE ? liveWire : undefined);
  const loaded = "kind" in live.live && live.live.kind === "loaded" ? live.live : null;

  const kept = body.state === "withheld" && loaded === null;
  const views = controls.filter((c) => c.id !== "history");
  const history = controls.find((c) => c.id === "history");
  const Body = parts.body;
  const text = isProtected(message) ? (
    <p>{t("protected")}</p>
  ) : (
    <Body
      {...letterPictures(message, body.loadedRemoteContent, parts.pictures, parts.files, reading, presented)}
      messageId={message.id}
      text={loaded ? loaded.text : body.text}
      html={loaded ? loaded.html : body.html}
      subject={message.subject}
      scheme={scheme}
      owner={host.session.scope}
      onNotice={setNotice}
      onControls={setControls}
    />
  );

  return (
    <div
      className="rd-letter"
      data-conv-id={message.id}
      data-unseen={message.unread ? "" : undefined}
      data-body-ready={letterReady(message, body) ? "" : undefined}
    >
      {look === "tint" && unread ? <span className="oh-vh">{tm("rowUnread")}</span> : null}
      <Message
        head={
          <LetterHead
            message={message}
            unread={look === "dot" && unread}
            notice={notice}
            narrow={narrow ?? false}
            onPerson={onPerson}
          />
        }
        unread={look === "tint" && unread}
        lead={
          views.length > 0 ? (
            <LetterViews
              label={t("views")}
              views={views.map((c) => ({ id: c.id, label: c.label, onPress: c.onPress }))}
            />
          ) : undefined
        }
        after={
          history ? (
            <LetterHistory label={history.label} open={history.expanded} onPress={history.onPress} />
          ) : undefined
        }
        files={isProtected(message) ? undefined : <LetterFiles messageId={message.id} />}
      >
        <div data-read-body="">
          {/* What is kept elsewhere is said under the preview; a load on its way, over it. */}
          {kept ? null : <TextState message={message} body={body} live={live} />}
          {text}
          {kept ? <TextState message={message} body={body} live={live} /> : null}
        </div>
      </Message>
    </div>
  );
}

/** Who wrote it, to whom and when; every name opens the contact card; what the body kept out, as its chip. */
function LetterHead({
  message,
  unread,
  notice,
  narrow,
  onPerson,
}: {
  message: EngineMessage;
  unread: boolean;
  notice: LetterNotice | null;
  narrow: boolean;
  onPerson: (person: ContactOf) => void;
}) {
  const t = useText("reader");
  const tm = useText("message");
  const tp = useText("place");
  const locale = useLocale();
  const own = useOwnAddresses();
  const mailboxWord = useMailboxWord();
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [full, setFull] = useState(false);
  const [details, setDetails] = useState(false);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const person = useCallback(
    (p: { name: string | null; address: string }) => (anchor: HTMLElement) =>
      onPerson({ name: nameOf(p), address: p.address, anchor }),
    [onPerson],
  );
  const mine = (address: string): boolean => own.some((a) => a.toLowerCase() === address.toLowerCase());
  const groups = [
    { word: t("head.to"), people: message.to },
    { word: tm("ccLabel"), people: message.cc },
  ]
    .filter((g) => g.people.length > 0)
    .map((g) => ({
      word: g.word,
      people: g.people.map((p) => ({
        name: mine(p.address) ? t("head.you") : nameOf(p),
        onPress: person(p),
      })),
    }));
  const stamp = headStamp(stampOf(message), new Date(), readerZone(), locale, {
    yesterday: (time) => t("head.yesterday", { time }),
  });
  /* When, who, to whom with every address whole, and where it is: its place, and its mailbox where there are several. */
  function detailLines() {
    const view = placeOfFolder(message.folder);
    const place = view !== null && tp.has(view) ? tp(view) : message.folder;
    const mailbox = mailboxWord(message.mailboxId);
    return [
      { term: t("sent"), value: stamp.full },
      { term: t("from"), value: nameOf(message.from), note: message.from.address },
      ...(message.to.length > 0 ? [{ term: t("detail.to"), value: message.to.map(whole).join(", ") }] : []),
      ...(message.cc.length > 0 ? [{ term: t("detail.cc"), value: message.cc.map(whole).join(", ") }] : []),
      { term: t("detail.in"), value: mailbox ? t("detail.where", { place, mailbox }) : place },
    ];
  }
  return (
    <>
      <MessageHead
        sender={{ name: nameOf(message.from), address: message.from.address, onPress: person(message.from) }}
        unread={unread}
        note={
          notice ? (
            <BlockedImages
              caption={notice.caption}
              sentence={notice.text}
              open={noticeOpen}
              onOpen={() => setNoticeOpen(true)}
              onClose={() => setNoticeOpen(false)}
            />
          ) : undefined
        }
        menu={{ label: t("head.menu"), expanded: menu !== null || undefined, onPress: (at) => setMenu(at) }}
        stamp={{
          when: full ? stamp.full : narrow ? stamp.short : stamp.when,
          full,
          title: full ? stamp.when : stamp.full,
          onPress: () => setFull((f) => !f),
        }}
        to={groups}
        details={{
          label: tm("details"),
          open: details,
          onToggle: () => setDetails((d) => !d),
          lines: details ? detailLines() : [],
        }}
      />
      <LetterMenu message={message} anchor={menu} onClose={() => setMenu(null)} />
    </>
  );
}

/** What the column says of a letter's text that is not all here: on its way, not fetched, or not kept. */
function TextState({
  message,
  body,
  live,
}: {
  message: EngineMessage;
  body: MessageBody;
  live: ReturnType<typeof useLiveBody>;
}) {
  const tb = useText("body");
  const engine = useEngineOrNull();
  const { commands, host } = useFrame();
  const settings = host.features.places.settings;
  const dead = useSessionDead();
  const status = useMailboxStatus()(message.mailboxId);
  const { load } = live;
  const now = live.live;
  const loaded = "kind" in now && now.kind === "loaded";
  const busy = "state" in now && now.state === "loading";
  const refused = "kind" in now && now.kind === "refused" ? now.reason : null;
  if (body.state === "loading") return <TextNotKept kind="fine" line={tb("loading")} live />;
  if (body.state === "failed") {
    /* With the session ended, the way on is to sign in again; otherwise the person may ask again. */
    const recover = host.session.recover;
    return dead ? (
      <TextNotKept
        kind="refused"
        warn={tb("sessionEnded")}
        way={recover !== NONE ? { label: tb("signIn"), onPress: () => recover("signIn") } : undefined}
      />
    ) : (
      <TextNotKept
        kind="refused"
        warn={tb("kept.failed")}
        way={{
          label: tb("kept.tryAgain"),
          onPress: () => void engine?.hydrateBody(message.id, { retry: true }),
        }}
      />
    );
  }
  const storage =
    settings !== NONE && settings !== undefined
      ? { label: tb("kept.storage"), onPress: () => commands.go({ place: "settings", sub: "storage" }) }
      : undefined;
  if (loaded) return <TextNotKept kind="loaded" line={tb("keptLoaded")} more={storage} />;
  if (body.state !== "withheld") return null;
  const key = withheldKeyOf(body, message.folder);
  /* A Junk letter on its way back from the Junk folder is text on its way: one fine line. */
  if (key === "withheldJunkLoading") return <TextNotKept kind="fine" line={tb(key)} live />;
  const words = KEPT[key];
  const emptied = key === "withheld";
  /* Emptied in a mailbox ohmail no longer reads: its text does not come back, and nothing loads it. */
  const removed = emptied && status === "removed";
  return (
    <TextNotKept
      kind="kept"
      label={tb(`kept.${words}Title`)}
      line={tb(removed ? "kept.removedLine" : `kept.${words}Line`)}
      warn={refused !== null ? tb(REFUSED[refused]) : undefined}
      act={
        load && !removed
          ? { label: busy ? tb("keptLoading") : tb("liveLoad"), busy, onPress: load }
          : undefined
      }
      more={emptied ? storage : undefined}
      fine={removed || words === "tooLarge" ? undefined : tb(`kept.${words}Fine`)}
    />
  );
}
