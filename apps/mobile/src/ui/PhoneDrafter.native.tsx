import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { useDraftReply } from "@ohmail/app-logic/writing/draft-reply";
import { Copy } from "../copy";
import { phoneDraftWire } from "../net/consent";
import { useLiveSession } from "../state/world";
import { useTheme } from "../theme";
import { Button, Txt } from "./base";
import type { PhoneDrafterProps } from "./PhoneDrafter";

const WORDS = {
  "draftReply.running": "draftAiRunning",
  "draftReply.failed": "draftAiFailed",
  "draftReply.unavailable": "draftAiUnavailable",
  "draftReply.letterLeft": "draftAiLetterLeft",
  "draftReply.failedOpaque": "draftAiFailedOpaque",
  "draftReply.failedOpaqueEarly": "draftAiFailedOpaqueEarly",
  "draftReply.creditsUsed": "draftAiCreditsUsed",
  "draftReply.creditsReturned": "draftAiCreditsReturned",
  "draftReply.creditsOwed": "draftAiCreditsOwed",
  "draftReply.declined": "draftAiDeclined",
  "draftReply.declinedCreditsReturned": "draftAiDeclinedCreditsReturned",
  "draftReply.declinedCreditsOwed": "draftAiDeclinedCreditsOwed",
  "aiRefusal.insufficientCredits": "draftAiInsufficientCredits",
  "aiRefusal.aiDisabled": "draftAiAiDisabled",
  "aiRefusal.aiUnavailable": "draftAiAiUnavailable",
  "aiRefusal.noModel": "draftAiNoModel",
} as const;

function translate(key: string): string {
  return Copy[WORDS[key as keyof typeof WORDS] ?? "draftAiFailed"];
}

export function PhoneDrafter(props: PhoneDrafterProps) {
  const { body, messageId, mailboxId, subject, allowed, blocked: disabled } = props;
  const theme = useTheme();
  const session = useLiveSession();
  const wire = useMemo(() => phoneDraftWire(session, allowed), [session, allowed]);
  const [confirmation, setConfirmation] = useState<{
    full: boolean; messageId: string | null; owner?: string;
  } | null>(null);
  const [needsText, setNeedsText] = useState(false);
  const [kept, setPair] = useState<{ source: string; draft: string; messageId: string | null; owner?: string } | null>(null);
  const pending = useRef<{ text: string; original: string; messageId: string | null; owner?: string } | null>(null);
  const active = useRef({ props, owner: session?.ownerKey });
  const alive = useRef(true);
  active.current = { props, owner: session?.ownerKey };
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const control = useDraftReply({
    wire, t: translate,
    onDraft: (draft) => {
      const started = pending.current;
      const field = active.current.props;
      if (!alive.current || started === null || started.owner !== active.current.owner || started.messageId !== field.messageId) return;
      setPair({
        source: field.body === started.text ? started.original : field.body,
        draft: draft.text, messageId: started.messageId, owner: started.owner,
      });
      if (field.body === started.text && !field.blocked) field.onChange(draft.text);
    },
  });
  if (control === null) return props.children(null, null, null, false);

  const pair = kept?.messageId === messageId && kept.owner === session?.ownerKey ? kept : null;
  const untouched = pair !== null && pair.draft === body;
  const source = untouched ? pair.source : body;
  const busy = control.phase === "running";
  const metered = session?.profile.flavor === "managed";
  const confirming = confirmation?.messageId === messageId && confirmation.owner === session?.ownerKey ? confirmation : null;
  const label = busy ? Copy.draftAiRunning : untouched ? Copy.draftAiAgain : Copy.draftAiFromText;
  const buy = (fullConversation = false) => {
    if (disabled || busy || source.trim() === "") return;
    setConfirmation(null);
    setNeedsText(false);
    pending.current = { text: body, original: source, messageId, owner: session?.ownerKey };
    const typed = { text: source, html: "" };
    if (messageId === null && control.letter !== "none") control.letter({ text: source, mailboxId, subject }, typed);
    else if (messageId !== null && control.fromText !== "none") control.fromText(messageId, source, typed, fullConversation);
  };
  const offer = (full: boolean) => {
    if (!source.trim()) setNeedsText(true);
    else if (full || metered) setConfirmation({ full, messageId, owner: session?.ownerKey });
    else buy();
  };
  const tool = (
    <>
      <Button label={label} icon="spark" variant="quiet" disabled={disabled || busy}
        style={{ backgroundColor: theme.c.tint2 }} onPress={() => offer(false)} />
      {messageId !== null ? <Button label={Copy.draftAiFullTitle} variant="quiet" disabled={disabled || busy}
        onPress={() => offer(true)} /> : null}
    </>
  );
  const notice = (
    <>
      {needsText && !source.trim() ? <Txt variant="caption" tone="ink2">{Copy.draftAiNeedWords}</Txt> : null}
      {confirming ? (
        <>
          {confirming.full ? <Txt variant="note">{Copy.draftAiFullDisclosure}</Txt> : null}
          {metered ? <Txt variant="note">{Copy.draftAiOffer}</Txt> : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <Button label={confirming.full ? Copy.draftAiFullConfirm : Copy.draftAiConfirm} variant="solid"
              disabled={disabled || busy} onPress={() => buy(confirming.full)} />
            <Button label={Copy.moveCancel} onPress={() => setConfirmation(null)} />
          </View>
        </>
      ) : null}
      {control.notice ? <Txt variant="note" accessibilityLiveRegion="polite">{control.notice}</Txt> : null}
    </>
  );
  const switcher = pair === null || busy ? null : (
    <View style={{ alignSelf: "flex-start", flexDirection: "row", gap: 2, borderRadius: theme.radius.pill, backgroundColor: theme.c.tint2 }}>
      <Button label={Copy.draftAiYourText} variant={untouched ? "quiet" : "plain"} disabled={disabled}
        onPress={() => { if (untouched) props.onChange(pair.source); }} />
      <Button label={Copy.draftAiGenerated} variant={untouched ? "plain" : "quiet"} disabled={disabled}
        onPress={() => {
          if (untouched) return;
          if (body !== pair.source) setPair({ ...pair, source: body });
          props.onChange(pair.draft);
        }} />
    </View>
  );
  return props.children(switcher, tool, notice, untouched);
}
