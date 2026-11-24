import type { ReactNode } from "react";
import { Dot, Slot } from "../../../../src/base/index.js";
import {
  Attach,
  AttachRoom,
  Composer,
  DraftControl,
  DraftTabs,
  Recipients,
  SendStatus,
  type ComposerMark,
  type ComposerProps,
  type DraftControlProps,
  type RecipientsProps,
} from "../../../../src/mail/index.js";
import type { KitSubject, Look } from "../../harness.js";
import * as W from "./world.js";

const shut = () => {};
const person = (p: { name: string; address: string }) => ({
  ...p,
  id: p.address,
  remove: `Remove ${p.name}`,
});

const MARKS: readonly (readonly ComposerMark[])[] = [
  [
    { id: "bold", label: "Bold", glyph: { letter: "B", as: "bold" } },
    { id: "italic", label: "Italic", glyph: { letter: "I", as: "italic" } },
    { id: "underline", label: "Underline", glyph: { letter: "U", as: "underline" } },
    { id: "strike", label: "Strikethrough", glyph: { letter: "S", as: "strike" } },
  ],
  [{ id: "link", label: "Link", icon: "link" }],
  [
    { id: "ol", label: "Ordered list", icon: "mol" },
    { id: "ul", label: "Bulleted list", icon: "mul" },
  ],
  [{ id: "quote", label: "Blockquote", icon: "mquote" }],
  [
    { id: "code", label: "Code", icon: "mcode" },
    { id: "pre", label: "Code block", icon: "mpre" },
  ],
];

const from = (state: string): RecipientsProps["from"] => ({
  label: "From",
  value: <Slot>{W.ME.address}</Slot>,
  tag: "Studio",
  state,
});
const subject = (value: string): RecipientsProps["subject"] => ({
  label: "Subject",
  placeholder: "Subject",
  value,
});
const MORE = { label: "Cc Bcc" };
const GLAZE = "Re: Would you teach the December glaze evening?";
const NADJA = [{ id: "to", label: "To", people: [person(W.NADJA)], typed: "" }];

/**
 * The app's editor, handed in: the kit draws its frame. An empty one shows its hint as the sheet's does
 * (the studio's compose.css: `.cw-body:empty::before`, the hint in the second ink).
 */
const HINT = "[data-hint]:empty::before{content:attr(data-hint);color:var(--ink2)}";
const text = (words = "", hint?: string) => (
  <>
    {hint ? <style>{HINT}</style> : null}
    <div role="textbox" aria-label="Message" aria-multiline="true" data-hint={hint}>
      {words}
    </div>
  </>
);

const draft = (props: Partial<DraftControlProps> & { label: string }) => (
  <DraftControl title={props.label} {...props} />
);
const IDLE = draft({
  label: "Draft from your text",
  short: "Draft from text",
  title: "Draft from your text · a few words first",
  idle: true,
});
const FROM_TEXT = draft({ label: "Draft from your text", short: "Draft from text", cost: "15 credits" });

/** A letter as the desktop has it: the marks over the text; under a finger they wait behind "Aa". */
const letter = (look: Look, more: Partial<ComposerProps> & { head: ReactNode }): ComposerProps => {
  const desk = look.device === "desktop";
  return {
    label: "New message",
    ...(desk ? { marks: { label: "Formatting", groups: MARKS } } : {}),
    children: text(),
    signature: {
      label: "Signature",
      text: "Mila Brunner\nLichtgrat · Winterthur",
      remove: { label: "Remove signature" },
    },
    foot: {
      label: "Add to the message",
      attach: <Attach label="Attach" onFiles={shut} />,
      format: { label: desk ? "Hide formatting" : "Show formatting", word: "Aa", pressed: desk },
      emoji: { label: "Emoji" },
      draft: IDLE,
    },
    ...more,
  };
};

/** How tall the reading column stands in ohmarchy beside the phone, where a new message's text fills it. */
const COLUMN: Partial<Record<Look["device"], number>> = { desktop: 772, fold: 653, foldl: 545 };
/** A new message alone in its column: the column lays its sheets out as a column. */
const column = (look: Look, node: ReactNode) => {
  const tall = look.face === "ohmarchy" ? COLUMN[look.device] : undefined;
  return tall ? <div style={{ display: "flex", flexDirection: "column", height: tall }}>{node}</div> : node;
};

const sheet = (key: string, target: string, render: (look: Look) => ReactNode): KitSubject => ({
  key,
  place: "block",
  target,
  render,
});
/** A part inside the letter stands on its sheet. */
const inside = (key: string, target: string, render: (look: Look) => ReactNode): KitSubject => ({
  ...sheet(key, target, render),
  on: "sheet",
});

const BODY =
  "Yes, gladly. The 17th suits me better. I would bring the matte white and two test tiles per person, and";
const CAME =
  "Buongiorno Giulia\n\nThursday before noon is fine; Ben will be at the atelier to take the carton. The delivery address is unchanged.\n\nCould you send me the tracking number once it has left Milan?\n\nThank you,\nMila";

export const editor: KitSubject[] = [
  sheet("Composer/blank", ".oh-composer", (look) =>
    column(
      look,
      <Composer
        fill
        {...letter(look, {
          children: text("", "Write, or a few words to draft from"),
          head: (
            <Recipients
              from={from("Draft")}
              lines={[{ id: "to", label: "To", people: [], typed: "" }]}
              more={MORE}
              subject={subject("")}
            />
          ),
        })}
      />,
    ),
  ),
  /* The same new message with a rich editor in it: the kit draws the words for a text not yet written. */
  sheet("Composer/placeholder", ".oh-composer", (look) =>
    column(
      look,
      <Composer
        fill
        placeholder="Write, or a few words to draft from"
        {...letter(look, {
          children: text(""),
          head: (
            <Recipients
              from={from("Draft")}
              lines={[{ id: "to", label: "To", people: [], typed: "" }]}
              more={MORE}
              subject={subject("")}
            />
          ),
        })}
      />,
    ),
  ),
  sheet("Composer/reply", ".oh-composer", (look) => (
    <Composer
      {...letter(look, {
        label: "Reply to Giulia Ferrari",
        reply: true,
        children: text("", "Reply"),
        head: (
          <Recipients
            reply
            from={from("Draft")}
            lines={[]}
            folded={{ label: "To", names: W.GIULIA.name, change: { label: "Change recipients" } }}
            subject={subject("Re: Glaze order #2291")}
          />
        ),
        foot: {
          label: "Add to the message",
          attach: <Attach label="Attach" onFiles={shut} />,
          format: { label: "Hide formatting", word: "Aa", pressed: true },
          emoji: { label: "Emoji" },
        },
      })}
    />
  )),
  sheet("Composer/drafted", ".oh-composer", (look) => (
    <Composer
      {...letter(look, {
        label: "Reply to Giulia Ferrari",
        reply: true,
        head: (
          <Recipients
            reply
            from={from("AI draft")}
            lines={[]}
            folded={{ label: "To", names: W.GIULIA.name, change: { label: "Change recipients" } }}
            subject={subject("Re: Glaze order #2291")}
          />
        ),
        tabs: (
          <DraftTabs
            label="The text"
            options={[
              { value: "mine", label: "Your text" },
              { value: "draft", label: "Draft" },
            ]}
            value="draft"
          />
        ),
        children: text(CAME),
        foot: {
          label: "Add to the message",
          attach: <Attach label="Attach" onFiles={shut} />,
          format: { label: "Hide formatting", word: "Aa", pressed: true },
          emoji: { label: "Emoji" },
          draft: draft({ label: "Draft again", cost: "15 credits" }),
        },
      })}
    />
  )),
  inside("Recipients/refused", ".oh-recipients", () => (
    <Recipients
      from={from("Draft")}
      lines={[
        {
          id: "to",
          label: "To",
          people: [
            person(W.NADJA),
            { id: "x", name: "petra@makersfest", refused: true, remove: "Remove petra@makersfest" },
          ],
          typed: "",
        },
      ]}
      more={MORE}
      refusal="Not an address: petra@makersfest"
      subject={subject(GLAZE)}
    />
  )),
  inside("Recipients/lines", ".oh-recipients", () => (
    <Recipients
      reply
      from={from("Draft")}
      lines={[
        { id: "to", label: "To", people: [person(W.GIULIA)], typed: "" },
        { id: "cc", label: "Cc", people: [], typed: "" },
        { id: "bcc", label: "Bcc", people: [], typed: "" },
      ]}
      subject={subject("Re: Glaze order #2291")}
    />
  )),
  /* At a foot's end: the foot is the container that lets the price show. */
  inside("DraftControl/ready", ".oh-draft", () => (
    <div style={{ containerType: "inline-size", display: "flex", width: 636 }}>
      {draft({ label: "Draft reply", cost: "15 credits" })}
    </div>
  )),
  inside("SendStatus/foot", ".oh-sendstatus", () => (
    <SendStatus place="foot" verdict="Not sent.">
      Sending did not work, but your draft is kept, so try again.
    </SendStatus>
  )),
  inside("SendStatus/top", ".oh-sendstatus", () => (
    <SendStatus place="top">
      This draft was sent from another device. Anything you type now is kept as a new draft.
    </SendStatus>
  )),
  sheet("AttachRoom/quality", ".oh-attachroom", () => (
    <AttachRoom weight="7.3 → 2.1 MB" used="2.1 of 19.1 MB">
      Pictures go at <Slot>Medium</Slot>
      <Dot kind="ink" />
    </AttachRoom>
  )),
  sheet("Composer/failed", ".oh-composer", (look) =>
    column(
      look,
      <Composer
        fill
        {...letter(look, {
          head: <Recipients from={from("Draft")} lines={NADJA} more={MORE} subject={subject(GLAZE)} />,
          children: text(BODY),
          note: (
            <SendStatus place="foot" verdict="Not sent.">
              Sending did not work, but your draft is kept, so try again.
            </SendStatus>
          ),
        })}
        foot={{ ...letter(look, { head: null }).foot, draft: FROM_TEXT }}
      />,
    ),
  ),
];
