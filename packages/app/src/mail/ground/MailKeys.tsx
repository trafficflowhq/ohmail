"use client";

/**
 * THE MAIL'S OWN KEYS, bound for the frame's life from every place: `c` writes a new letter, `/` goes to Search.
 * Each is bound only where this host hands the place it leads to: a place that is not handed has no rail entry, no
 * dock tab and no key, and a key that led there would throw the person to the Ohbox instead.
 *
 * And Mod+Shift+Enter, SEND + DONE for the open reply, from its editor too: the one composer's own press, bound for
 * the frame's life and resting wherever no reply is open or its letter has nothing to finish (the offer is asked of
 * the letters as the Ohbox shows them, at every render). It stands under the one composer's mount, which it reads.
 *
 * NOT HERE, and whose: `z`, which takes back the armed Undo, is the room's own (`frame/room.tsx`: it presses the
 * one seam's `runArmedUndo`); `?` and the palette's key are declared by their own overs; a `g` chord
 * is the frame's, from each place's registration; a place's keys are its own seat's. A second binding of any of
 * these would answer one press twice.
 */
import {
  DRAFT_REPLY_KEY,
  LEAVE_KEY,
  SEND_AND_DONE_KEY,
  SEND_KEY,
  teachWritingKey,
} from "../../write/keys.js";
import { editorHelp } from "../../write/editor/shortcuts.js";
import { useEnabledBinding, useKeyBindings, useKeyPress, type KeyBinding } from "@ohmail/app-logic/keys";
import { listWalkHelp } from "@ohmail/app-logic/place-list";
import { useOptionalTheme } from "@ohmail/ui/theme";
import { useFrame, usePaletteOffers, useSignal } from "../../frame/index.js";
import { canCycleMailLayout } from "../../frame/layout-plan.js";
import { productOf } from "../../frame/product.js";
import { NONE } from "../../host/index.js";
import { letterKeys } from "../../reader/keys.js";
import { useText } from "../../text/index.js";
import { useWriting } from "../../write/index.js";

export function MailKeys(): null {
  const { host, commands, route } = useFrame();
  const t = useText("shortcuts");
  const palette = useText("palette");
  const lists = useText("ohbox");
  const reader = useText("reader");
  const writeWords = useText("write");
  const theme = useOptionalTheme();
  const facts = useSignal(host.device.window);
  const inMail = productOf(route.place) === "mail";
  const hasLayout = theme?.layoutEnabled === true && inMail;
  const canCycle = hasLayout && canCycleMailLayout(facts);
  const cycleLayout = {
    id: "mail.layout",
    label: palette("cycleLayout"),
    icon: "move",
    chord: "w",
    run: () => theme?.setLayout(theme.layout === "zero" ? "classic" : "zero"),
  } as const;
  const { search, write } = host.features.places;
  const compose = {
    id: "mail.compose",
    label: palette("newMessage"),
    icon: "write",
    chord: "c",
    run: () => commands.write(),
  } as const;
  const pressKey = useKeyPress();
  const resurface = {
    id: "mail.resurface",
    label: palette("resurfaceSel"),
    icon: "resurface",
    chord: "b",
    disabled: useEnabledBinding("b") === null || productOf(route.place) !== "mail",
    run: () => pressKey("b"),
  } as const;
  const move = {
    id: "mail.move",
    label: t("move"),
    icon: "move",
    chord: "m",
    disabled: useEnabledBinding("m") === null,
    run: () => pressKey("m"),
  } as const;
  usePaletteOffers(
    "mail",
    !inMail || route.stage !== null
      ? []
      : [...(write === NONE ? [] : [compose]), resurface, move, ...(canCycle ? [cycleLayout] : [])],
    productOf(route.place) === "mail",
  );
  const writing = useWriting();
  const replyTo = writing.replyTo;
  const sendAndDone = replyTo === null ? null : writing.sendReplyAndDone(replyTo);
  const keys: KeyBinding[] = [];
  if (hasLayout)
    keys.push({
      chord: cycleLayout.chord,
      group: "app",
      label: t("layout"),
      disabled: !canCycle,
      disabledReason: canCycle ? undefined : "layout_same",
      run: cycleLayout.run,
    });
  if (search !== NONE)
    keys.push({
      chord: "/",
      group: "navigate",
      place: "lists",
      label: t("search"),
      run: () => commands.go({ place: "search" }),
    });
  if (write !== NONE) {
    keys.push({ chord: compose.chord, group: "app", place: "lists", label: t("compose"), run: compose.run });
    keys.push(...editorHelp(writeWords));
    if (writing.draftReplyChrome.control.offered && replyTo === null)
      keys.push(teachWritingKey(DRAFT_REPLY_KEY, writeWords("draft.verb")));
    if (route.place !== "write" && replyTo === null)
      keys.push(teachWritingKey(LEAVE_KEY, writeWords("keys.leave")));
    // Write owns the live shortcut whenever an editor stands.
    if (route.place !== "write" && replyTo === null)
      keys.push({
        chord: SEND_KEY,
        group: "message",
        place: "composer",
        label: t("sendReply"),
        disabled: true,
        run: () => {},
      });
  }
  // The Reader owns the live shortcut. The compact Ohbox has no reading column while it rests.
  if (host.features.reader !== NONE && route.place === "ohbox" && route.open === null)
    keys.push({
      chord: "s",
      group: "message",
      label: t("screen"),
      disabled: true,
      disabledReason: "no_cursor",
      run: () => {},
    });
  keys.push({
    chord: SEND_AND_DONE_KEY,
    group: "message",
    place: "composer",
    label: t("sendReplyAndDone"),
    inInput: true,
    disabled: sendAndDone === null,
    run: () => sendAndDone?.(),
  });
  if (!inMail || route.place === "write") {
    if (host.features.places.ohbox !== NONE)
      keys.push(...listWalkHelp({ next: lists("keyNext"), prev: lists("keyPrev"), open: lists("keyOpen") }));
    if (host.features.reader !== NONE)
      keys.push(...letterKeys(reader, null).map((binding) => ({ ...binding, helpOnly: true })));
  }
  useKeyBindings(inMail ? keys : keys.map((binding) => ({ ...binding, helpOnly: true })), "global");
  return null;
}
