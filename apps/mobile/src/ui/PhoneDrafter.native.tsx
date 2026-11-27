import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { NEW_LETTER, useDraftReply } from "@ohmail/app-logic/writing/draft-reply";
import type { Run } from "../compose/formatting";
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
  const { body, bodyRuns, messageId, mailboxId, subject, allowed, blocked: disabled, offerDraftReply } = props;
  const theme = useTheme();
  const session = useLiveSession();
  const wire = useMemo(() => phoneDraftWire(session, allowed), [session, allowed]);
  const [replyOffer, setReplyOffer] = useState(() =>
    offerDraftReply && allowed === true && messageId !== null && wire !== "none" ? { messageId, session } : null);
  const [confirmation, setConfirmation] = useState<{
    full: boolean; messageId: string | null; owner?: string;
  } | null>(null);
  const [needsText, setNeedsText] = useState(false);
  const [kept, setPair] = useState<{
    source: string; sourceRuns: Run[] | null; draft: string; messageId: string | null; owner?: string;
  } | null>(null);
  const pending = useRef<{
    text: string; runs: Run[] | null; original: string; originalRuns: Run[] | null;
    messageId: string | null; session: typeof session; contextOnly?: true;
  } | null>(null);
  const active = useRef({ props, session });
  const alive = useRef(true);
  active.current = { props, session };
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const control = useDraftReply({
    wire, t: translate,
    onDraft: (draft, target) => {
      const started = pending.current;
      const field = active.current.props;
      if (!alive.current || started === null || started.session !== active.current.session
        || started.messageId !== field.messageId || target !== (started.messageId ?? NEW_LETTER)
        || field.allowed === false || (started.contextOnly && field.allowed !== true)) return;
      if (started.contextOnly) setReplyOffer(null);
      const fieldRuns = field.bodyRuns ?? null;
      const unchanged = field.body === started.text && fieldRuns === started.runs;
      setPair({
        source: unchanged ? started.original : field.body,
        sourceRuns: unchanged ? started.originalRuns : fieldRuns,
        draft: draft.text, messageId: started.messageId, owner: started.session?.ownerKey,
      });
      if (unchanged && !field.blocked && (!started.contextOnly || started.text.trim() === "")) {
        field.onChange(draft.text);
      }
    },
  });
  if (control === null) return props.children(null, null, null, false);

  const pair = kept?.messageId === messageId && kept.owner === session?.ownerKey ? kept : null;
  const untouched = pair !== null && pair.draft === body;
  const source = untouched ? pair.source : body;
  const runs = bodyRuns ?? null;
  const sourceRuns = untouched ? pair.sourceRuns : runs;
  const busy = control.phase === "running";
  const metered = session?.profile.flavor === "managed";
  const confirming = confirmation?.messageId === messageId && confirmation.owner === session?.ownerKey ? confirmation : null;
  const reply = replyOffer?.messageId === messageId && replyOffer.session === session ? replyOffer : null;
  const label = busy ? Copy.draftAiRunning : untouched ? Copy.draftAiAgain : Copy.draftAiFromText;
  const buyReply = () => {
    const field = active.current.props;
    if (reply === null || busy || field.blocked || field.allowed !== true
      || reply.session !== active.current.session || reply.messageId !== field.messageId) return;
    if (!control.press(reply.messageId, { text: field.body, html: "" })) return;
    const fieldRuns = field.bodyRuns ?? null;
    pending.current = {
      text: field.body, runs: fieldRuns, original: field.body, originalRuns: fieldRuns,
      messageId: reply.messageId, session, contextOnly: true,
    };
  };
  const buy = (fullConversation = false) => {
    const field = active.current.props;
    if (field.blocked || busy || source.trim() === "" || field.allowed === false
      || active.current.session !== session || field.messageId !== messageId) return;
    const typed = { text: source, html: "" };
    const admitted = messageId === null
      ? control.letter !== "none" && control.letter({ text: source, mailboxId, subject }, typed)
      : control.fromText !== "none" && control.fromText(messageId, source, typed, fullConversation);
    if (!admitted) return;
    pending.current = { text: body, runs, original: source, originalRuns: sourceRuns, messageId, session };
    setReplyOffer(null);
    setConfirmation(null);
    setNeedsText(false);
  };
  const offer = (full: boolean) => {
    if (source.trim() && !full && !metered) {
      buy();
      return;
    }
    setReplyOffer(null);
    if (!source.trim()) setNeedsText(true);
    else setConfirmation({ full, messageId, owner: session?.ownerKey });
  };
  const tool = <Button label={label} icon="spark" variant="quiet" disabled={disabled || busy}
    style={{ backgroundColor: theme.c.tint2, paddingHorizontal: 8 }} onPress={() => offer(false)} />;
  const fullTool = messageId === null ? null : <Button label={Copy.draftAiFullTitle} variant="quiet"
    disabled={disabled || busy} onPress={() => offer(true)} />;
  const confirmReply = reply !== null && !busy;
  const requestNotice = pending.current?.session === session && pending.current?.messageId === messageId
    ? control.notice : null;
  const notice = (needsText && !source.trim()) || confirming || confirmReply || requestNotice ? (
    <>
      {needsText && !source.trim() ? <Txt variant="caption" tone="ink2">{Copy.draftAiNeedWords}</Txt> : null}
      {confirmReply ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          <Button label={metered ? Copy.draftAiReplyPriced : Copy.draftAiReply}
            icon="spark" variant="solid" disabled={disabled} onPress={buyReply} />
          <Button label={Copy.moveCancel} onPress={() => { setReplyOffer(null); control.cancel(); }} />
        </View>
      ) : null}
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
      {requestNotice ? <Txt variant="note" accessibilityLiveRegion="polite">{requestNotice}</Txt> : null}
    </>
  ) : null;
  const switcher = pair === null || busy ? null : (
    <View style={{ alignSelf: "flex-start", flexDirection: "row", gap: 2, borderRadius: theme.radius.pill, backgroundColor: theme.c.tint2 }}>
      <Button label={Copy.draftAiYourText} variant={untouched ? "quiet" : "plain"} disabled={disabled}
        onPress={() => { if (untouched) props.onChange(pair.source, pair.sourceRuns); }} />
      <Button label={Copy.draftAiGenerated} variant={untouched ? "plain" : "quiet"} disabled={disabled}
        onPress={() => {
          if (untouched) return;
          if (body !== pair.source || runs !== pair.sourceRuns) setPair({ ...pair, source: body, sourceRuns: runs });
          props.onChange(pair.draft);
        }} />
    </View>
  );
  return props.children(switcher, tool, notice, untouched, fullTool);
}
