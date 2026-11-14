import type { CSSProperties, ReactNode } from "react";
import { Dot, MenuItem, SentencePart, Slot, Tag } from "../../../../src/base/index.js";
import {
  ActionPanel,
  BlankColumn,
  BlockedImages,
  ContactCard,
  Files,
  FileTile,
  Message,
  MessageHead,
  QuickLook,
  ReadingHead,
  ReadingLine,
  ReadSquares,
  Sheet,
  type MessageHeadProps,
  type PanelNote,
  type PanelVerb,
} from "../../../../src/mail/index.js";
import * as W from "./world.js";
import { force, type KitSubject, type Look } from "../../harness.js";

const sentenceHead = (
  <ReadingHead
    under
    sentence={
      <>
        <SentencePart>Lena Kaufmann</SentencePart>{" "}
        <SentencePart
          end={
            <>
              <Slot>Ohbox</Slot>
              <Dot kind="hot" />
            </>
          }
        >
          goes to{" "}
        </SentencePart>
      </>
    }
    lines={
      <>
        <ReadingLine
          sign="ok"
          person={{ label: "lena@atelier-eichspan.example", onPress: () => undefined }}
          word={{ text: "Confirmed" }}
        >
          <Slot>this sender</Slot>
        </ReadingLine>
        <ReadingLine sign="spark" figure={{ text: "92%", title: "Confidence" }} why>
          A personal note from a real address
        </ReadingLine>
      </>
    }
  />
);

const more = { label: "More", behind: true };
const panel = (state: string, items: (PanelVerb | PanelNote)[], withMore = false): KitSubject => ({
  key: `ActionPanel/${state}`,
  target: ".oh-actionpanel-bar",
  render: () => <ActionPanel label="Actions" items={items} more={withMore ? more : undefined} />,
});

const you = { name: "you" };
const stamp = (when: string) => ({ when, full: false, title: "Full dates" });
const details = (
  lines: MessageHeadProps["details"] extends infer D | undefined
    ? D extends { lines: infer L }
      ? L
      : never
    : never = [],
) => ({
  label: "details",
  open: lines.length > 0,
  lines,
});
const fromBen: MessageHeadProps = {
  sender: W.BEN,
  menu: { label: "Message" },
  stamp: stamp("Mon 17:30"),
  to: [{ word: "to", people: [you, { name: "Giulia Ferrari" }] }],
  details: details(),
};
const courier =
  "One thing for the courier: the studio is closed on Wednesday morning, the kiln technician needs the room. Thursday or Friday before noon works.\n\nBen";
/** A message stands alone on the ground, as wide as the reference draws it. */
const letter = (state: string, node: ReactNode, component = "Message"): KitSubject => ({
  key: `${component}/${state}`,
  place: "block",
  width: 496,
  render: () => node,
});
const blank = (state: string, label: string, hot = false): KitSubject => ({
  key: `BlankColumn/${state}`,
  place: "block",
  width: 260,
  render: () => (
    <div style={{ display: "flex", height: 150 }}>
      <BlankColumn hot={hot}>{label}</BlankColumn>
    </div>
  ),
});
const photo = (n: number, size: string) => (
  <FileTile
    key={n}
    kind="JPG"
    name={`grat-0${n}.jpg`}
    size={size}
    main={{ label: `Preview grat-0${n}.jpg` }}
    save={{ label: `Download grat-0${n}.jpg` }}
  />
);

export const reading: KitSubject[] = [
  {
    ...letter("unread", null),
    render: (look: Look) => (
      <Message
        unread
        head={<MessageHead {...fromBen} unread stamp={stamp(look.device === "fold" ? "Mon" : "Mon 17:30")} />}
      >
        {courier}
      </Message>
    ),
  },
  letter("read", <Message head={<MessageHead {...fromBen} />}>{courier}</Message>),
  letter(
    "own",
    <Message
      head={
        <MessageHead
          sender={{ ...W.ME, printed: "You" }}
          menu={{ label: "Message" }}
          stamp={stamp("Fri 11:40")}
          to={[
            { word: "to", people: [{ name: "Giulia Ferrari" }] },
            { word: "cc", people: [{ name: "Ben Arnold" }] },
          ]}
          details={details()}
        />
      }
    >
      {
        "Send what you have now, please. We need the green for test tiles next week.\n\nBen (in copy) takes deliveries at the studio, mornings are best.\n\nMila"
      }
    </Message>,
  ),
  /* A stream's letter, cut until it is pressed: what follows the text waits, and one word opens it. */
  {
    key: "Message/clip",
    place: "block",
    width: 740,
    render: () => (
      <Message
        head={
          <MessageHead
            sender={{ name: "Skylark Notes", address: "mara@skylarknotes.example" }}
            note={
              <BlockedImages
                caption="Images blocked"
                sentence="Images in this message are blocked."
                open={false}
                onOpen={() => {}}
                onClose={() => {}}
              />
            }
            menu={{ label: "Message" }}
            stamp={stamp("07:02")}
            to={[{ word: "to", people: [you] }]}
            details={details()}
          />
        }
        subject="#131: the joy of small tools"
        clip={{ open: false, word: "Expand" }}
      >
        {
          "Hi there. This issue is about tools that do one thing well.\n\nSmall tools are not lesser tools. They are the ones that fit your hand on the first try: the ladle that pours without dripping, the pencil that starts every list, the app with exactly one screen. This week's essay visits three workshops and asks each maker which object they would save from a fire. Nobody picked the expensive one.\n\nAlso inside: a lamp you can repair with a coin, and a short list of things that got better when someone removed a feature.\n\nUntil next week,\nMara"
        }
      </Message>
    ),
  },
  {
    key: "MessageHead/details",
    place: "block",
    render: () => (
      <div style={{ background: "var(--sheet-new)", ["--oh-under" as string]: "var(--sheet-new)" }}>
        <MessageHead
          sender={W.GIULIA}
          unread
          menu={{ label: "Message" }}
          stamp={stamp("09:12")}
          to={[
            { word: "to", people: [you] },
            { word: "cc", people: [{ name: "Ben Arnold" }] },
          ]}
          details={details([
            { term: "Sent", value: "Tuesday 10 November 2026, 09:12" },
            { term: "From", value: "Giulia Ferrari", note: W.GIULIA.address },
            { term: "To", value: "Mila Brunner", note: W.ME.address },
            { term: "Cc", value: "Ben Arnold", note: W.BEN.address },
            { term: "In", value: "Ohbox · Studio", note: W.ME.address },
          ])}
        />
      </div>
    ),
  },
  letter(
    "set",
    <Message
      head={
        <MessageHead
          sender={W.RETO}
          menu={{ label: "Message" }}
          stamp={stamp("yesterday 14:10")}
          to={[{ word: "to", people: [you] }]}
          details={details()}
        />
      }
      files={
        <Files summary="3 attachments · 7.3 MB" all={{ label: "Download all" }}>
          {photo(1, "2.4 MB")}
          {photo(2, "2.1 MB")}
          {photo(3, "2.8 MB")}
        </Files>
      }
    >
      The promised photos from the ridge. The sunrise was worth every minute of the four o'clock start. Next
      time you come along.
    </Message>,
    "FileTile",
  ),
  {
    key: "ReadingHead/rest",
    place: "block",
    target: ".oh-readinghead",
    render: (look) => (
      <div style={{ margin: "0 var(--ringw)" }}>
        <ReadingHead
          subject="Glaze order #2291"
          people={[W.GIULIA, W.BEN]}
          names="Giulia Ferrari, Ben Arnold"
          tags={<Tag hue={150}>Pottery Project</Tag>}
          mailbox="Studio"
          under={look.device !== "phone"}
          squares={
            look.device === "desktop" ? undefined : (
              <ReadSquares squares={W.GLAZE} here={4} axis="head" label="5 messages, 2 unread" />
            )
          }
        />
      </div>
    ),
  },
  /* A sender who waits, as the column's head: the sentence with its place, the address and what its check found,
     whom the decision is for, and why the place is advised. The reference's column has the keys: where a face rings
     such a column (ohmarchy), the head stands in its column, whose ring runs along the head's own edges. */
  {
    key: "ReadingHead/sentence",
    place: "block",
    target: ".oh-readinghead",
    render: (look) =>
      look.face === "ohmarchy" ? (
        <div style={{ display: "flex", height: 240 }}>
          <Sheet kind="reading" focused head={sentenceHead} />
        </div>
      ) : (
        <div style={{ margin: "0 var(--ringw)" }}>{sentenceHead}</div>
      ),
  },
  {
    key: "ReadingHead/letter",
    place: "window",
    target: ".oh-readinghead",
    render: (look) => (
      <div
        style={{
          position: "fixed",
          left: "calc(8px + var(--ringw))",
          top: look.face === "paper" ? 56 : 58,
          width: "calc(374px - 2 * var(--ringw))",
        }}
      >
        <ReadingHead subject="Your talk is on the programme" people={[]} mailbox="Studio" />
        {/* On paper the letter's sheet follows the head at once, and its top shows under the head's last line. */}
        {look.face === "paper" ? (
          <div
            style={{
              height: 24,
              background: "var(--sheet)",
              borderRadius: "var(--r-sheet) var(--r-sheet) 0 0",
            }}
          />
        ) : null}
      </div>
    ),
  },
  blank("unread", "5 unread", true),
  blank("read", "All read"),
  blank("none", "Nothing open"),
  {
    key: "BlankColumn/tile",
    place: "block",
    target: ".oh-blankcolumn",
    render: (look) => {
      const [width, height] =
        look.device === "desktop" ? [744, 876] : look.device === "fold" ? [307, 757] : [402, 649];
      return (
        <div
          style={{
            display: "flex",
            width: `calc(${width}px + 2 * var(--ringw))`,
            height: `calc(${height}px + var(--ringw))`,
          }}
        >
          <BlankColumn hot>5 unread</BlankColumn>
        </div>
      );
    },
  },

  panel(
    "held",
    [
      { id: "reply", label: "Reply", kind: "ink", icon: "reply" },
      { id: "later", label: "Later", icon: "later", segment: "defer", pressed: true },
      { id: "park", label: "Park", icon: "parked", segment: "defer", pressed: false },
    ],
    true,
  ),
  panel("reply", [
    { id: "send", label: "Send", kind: "ink", icon: "send" },
    { id: "send-done", label: "Send + Done", icon: "check" },
    { id: "cancel", label: "Cancel", icon: "x" },
  ]),
  panel(
    "decision",
    [
      { id: "ohbox", label: "Ohbox", kind: "ink", icon: "ohbox", keyHint: "↵" },
      { id: "out", label: "Screen out", icon: "screenout", keyHint: "n" },
    ],
    true,
  ),
  panel("note", [
    { note: "2 of 5" },
    { id: "send", label: "Send", kind: "ink", icon: "send" },
    { id: "skip", label: "Skip", icon: "forward" },
  ]),
  {
    key: "ContactCard/card",
    place: "window",
    target: ".oh-menu",
    act: force('[role="radio"]', "focus", "focus-visible"),
    render: () => (
      <ContactCard
        open
        onClose={shut}
        anchor={NOWHERE}
        label="Giulia Ferrari"
        person={W.GIULIA}
        copy={{ label: "Copy address" }}
        scope={{
          label: "Whose mail",
          value: "address",
          options: [
            { value: "address", label: "This address", note: "2 messages" },
            {
              value: "domain",
              label: "Everyone at terracotta-milano.example",
              note: "2 messages · 1 sender",
            },
          ],
        }}
        now={{ line: "Now in Ohbox", place: "Ohbox", all: { label: "See all" } }}
        goes={{
          label: "Goes to",
          value: "ohbox",
          places: [
            { value: "ohbox", label: "Ohbox" },
            { value: "news", label: "News" },
            { value: "receipts", label: "Receipts" },
            { value: "out", label: "Screen out" },
            { value: "spam", label: "Spam" },
          ],
        }}
        rules={[{ place: "Ohbox", note: "this address · your decision" }]}
        switches={[
          { label: "Rule for future mail", on: true },
          { label: "Move mail already here", on: true },
        ]}
      >
        <MenuItem icon="write">Write</MenuItem>
        <MenuItem icon="go">All mail</MenuItem>
        <MenuItem icon="plus">Rule on a subject</MenuItem>
      </ContactCard>
    ),
  },
  {
    key: "QuickLook/page",
    place: "window",
    target: ".oh-quicklook",
    render: (look) => (
      <QuickLook
        open
        onClose={shut}
        label="Attachment preview"
        name="Invoice-2291"
        facts="PDF · 84 KB · 1 / 1"
        download={{ label: "Download" }}
        close={{ label: "Close" }}
        hints={[{ label: "Close", keys: ["Space", "Esc"] }]}
      >
        <span
          role="img"
          aria-label="Page 1"
          style={{
            alignSelf: "flex-start",
            boxSizing: "border-box",
            width: look.face === "paper" ? 485.4 : 490.8,
            height: look.face === "paper" ? 686.4 : 694,
            padding: "56px 52px",
            borderRadius: look.face === "paper" ? 4 : 0,
            background: "#fff",
            color: "#12100E",
            boxShadow: "var(--lift)",
            position: "relative",
            display: "flex",
            flexDirection: "column",
            gap: 13,
          }}
        >
          {/* The app's page, as the sheet draws its example: the file's name, its lines, the page's number. */}
          <b style={PAGE_NAME}>Invoice-2291</b>
          {[85, 88, 91, 94, 97].map((w, i) => (
            <i key={i} style={{ ...PAGE_LINE, width: `${w}%` }} />
          ))}
          <em style={PAGE_RULE} />
          {[96, 49, 52, 55].map((w, i) => (
            <i key={`b${i}`} style={{ ...PAGE_LINE, width: `${w}%` }} />
          ))}
          <small style={PAGE_NUMBER}>1</small>
        </span>
      </QuickLook>
    ),
  },
];
/* A page of a file, drawn by the app: the sheet's example of one, in the paper's own colours. */
const PAGE_INK = "#DDD5C9";
const PAGE_NAME: CSSProperties = {
  fontSize: 20,
  fontWeight: 700,
  marginBottom: 14,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const PAGE_LINE: CSSProperties = {
  display: "block",
  flex: "none",
  height: 7,
  borderRadius: 4,
  background: PAGE_INK,
};
const PAGE_RULE: CSSProperties = {
  display: "block",
  flex: "none",
  height: 1,
  margin: "14px 0",
  background: PAGE_INK,
};
const PAGE_NUMBER: CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: 22,
  textAlign: "center",
  fontSize: 12,
  color: "#6B645B",
  fontVariantNumeric: "tabular-nums",
};
const NOWHERE = { x: 0, y: 0 };
const shut = () => {};
