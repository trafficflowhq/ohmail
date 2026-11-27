import { Fragment, useCallback, useState, type ReactNode } from "react";
import { Linking, Text } from "react-native";
import { router } from "expo-router";
import { Copy } from "../copy";
import { isMailto, linkHostname, openConfirmedLink } from "../mail/frame-nav";
import { textLinks } from "../mail/text-links";
import { useWorldToast } from "../state/world";
import type { Theme } from "../theme";
import { Sheet, SheetRow } from "./Sheet";
import { Txt } from "./base";

export function useMailLinks() {
  const [url, setUrl] = useState<string | null>(null);
  const open = useCallback((href: string) => {
    if (isMailto(href)) router.push({ pathname: "/compose", params: { mailto: href } });
    else setUrl(href);
  }, []);
  return { open, url, close: () => setUrl(null) };
}

/** Both HTML and native text name the destination before opening it outside ohmail. */
export function MailLinkSheet({ url, onClose }: { url: string; onClose: () => void }) {
  const toast = useWorldToast();
  const hostname = linkHostname(url);
  return (
    <Sheet open onClose={onClose} label={Copy.mailOpenLinkTitle}>
      <Txt variant="sectionLabel" tone="ink3" style={{ paddingHorizontal: 14, paddingBottom: 6 }}>
        {Copy.mailOpenLinkTitle}
      </Txt>
      {hostname ? (
        <Txt variant="note" style={{ paddingHorizontal: 14, paddingBottom: 6, writingDirection: "ltr" }}>
          {hostname}
        </Txt>
      ) : null}
      <Txt variant="note" tone="ink2" style={{ paddingHorizontal: 14, paddingBottom: 10 }} numberOfLines={3}>
        {url}
      </Txt>
      <SheetRow icon="open" label={Copy.mailOpenLinkOpen} onPress={() => {
        onClose();
        void openConfirmedLink(url, { openURL: (u) => Linking.openURL(u), say: toast.say });
      }} />
    </Sheet>
  );
}

/** A body may also highlight the first search or calendar match. */
export function linkedText(
  text: string,
  t: Theme,
  onLink: ((url: string) => void) | undefined,
  { highlight, signatureHtml, asWritten = false }: {
    highlight?: string;
    signatureHtml?: string | null;
    asWritten?: boolean;
  } = {},
): ReactNode {
  const start = highlight ? text.indexOf(highlight) : -1;
  const end = start + (highlight?.length ?? 0);
  const mark = (from: number, to: number) => {
    if (start < 0 || to <= start || end <= from) return text.slice(from, to);
    return <>
      {text.slice(from, Math.max(from, start))}
      <Text maxFontSizeMultiplier={t.textCap} minimumFontScale={t.textKey} style={{ backgroundColor: t.c.accentSoft }}>
        {text.slice(Math.max(from, start), Math.min(to, end))}
      </Text>
      {text.slice(Math.min(to, end), to)}
    </>;
  };
  if (!onLink) return mark(0, text.length);
  const links = textLinks(text, signatureHtml);
  if (links.length === 0) return mark(0, text.length);

  const out: ReactNode[] = [];
  let cursor = 0;
  for (const link of links) {
    const label = asWritten ? text.slice(link.start, link.end) : link.label;
    if (cursor < link.start) out.push(<Fragment key={cursor + "-text"}>{mark(cursor, link.start)}</Fragment>);
    out.push(
      <Text
        key={link.start}
        accessibilityRole="link"
        accessibilityLabel={label}
        onPress={() => onLink(link.href)}
        style={{
          color: t.c.accentInk,
          textDecorationLine: "underline",
          ...(start >= 0 && start < link.end && end > link.start ? { backgroundColor: t.c.accentSoft } : {}),
        }}
      >
        {label}
      </Text>,
    );
    cursor = link.end;
  }
  if (cursor < text.length) out.push(<Fragment key="tail">{mark(cursor, text.length)}</Fragment>);
  return out;
}
