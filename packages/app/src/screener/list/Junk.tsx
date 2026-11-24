import { useFrame } from "../../frame/commands.js";
import { MailRow } from "../../place-list/MailRowMenu.js";
/**
 * JUNK, the third section where the shell hands its window: the mail server's own Junk folder, read when the section
 * opens and never mirrored. A read that failed says so and offers Try again (never "empty"); "Junk is empty" is said
 * only when every mailbox's folder was read. Each row says who filed it, or the "not junk" that stands on it. Search
 * Junk filters what is loaded as you type; the server is asked when that finds nothing, or on a press, and its hits
 * stand under their own name. Show older pages back on a press. Nothing here moves a letter: Not junk is the open
 * letter's own press.
 */
import { headStamp, readerZone } from "@ohmail/app-logic/reader";
import { junkKey, junkLabelOf, type JunkView } from "@ohmail/app-logic/screener";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { Empty, Field } from "@ohmail/ui/base";
import { GroupHeading, ListLine, Rows } from "@ohmail/ui/mail";
import { useLocale, useText, type Text } from "../../text/index.js";
import type { ScreenerJunk, ScreenerJunkItem } from "../ports.js";

/** Who wrote it: the name, else the address as a person reads it. */
export const junkWho = (i: ScreenerJunkItem): string => i.from.name?.trim() || displayAddress(i.from.address);

/** The stamp of a Junk letter: its own date, read where the person is. */
export function useJunkStamp(): (i: ScreenerJunkItem) => { when: string; short: string } {
  const t = useText("screener");
  const locale = useLocale();
  const now = new Date();
  return (i) =>
    headStamp(i.date, now, readerZone(), locale, {
      yesterday: (time) => t("place.yesterday", { time }),
    });
}

function JunkRow({
  item,
  view,
  t,
  stamp,
}: {
  item: ScreenerJunkItem;
  view: JunkView<ScreenerJunkItem>;
  t: Text;
  stamp: ReturnType<typeof useJunkStamp>;
}) {
  const key = junkKey(item);
  const who = junkWho(item);
  const open = view.openKey === key;
  const { plan } = useFrame();
  return (
    <MailRow
      who={who}
      address={item.from.name ? displayAddress(item.from.address) : undefined}
      people={[{ name: who, address: item.from.address }]}
      subject={item.subject}
      when={stamp(item).short}
      where={t(junkLabelOf(item))}
      open={open && plan.device !== "phone"}
      cursor={open}
      listing={{ name: item.subject ? `${who}: ${item.subject}` : who, selected: open, stop: open }}
      mark={{ id: key }}
      onOpen={() => view.select(key)}
    />
  );
}

/** The search's own line under the rows: one per state, none of them a silent wait. */
function SearchLines({ junk, localCount }: { junk: ScreenerJunk; localCount: number }) {
  const t = useText("screener");
  const { search } = junk;
  const q = search.query.trim();
  return (
    <>
      {search.phase === "local" && localCount === 0 ? (
        <ListLine>{t("junkSearchLocalNone", { q })}</ListLine>
      ) : null}
      {search.phase === "local" ? (
        <ListLine act={{ label: t("junkSearchServer"), quiet: true, onPress: search.searchServer }} />
      ) : null}
      {search.phase === "searching" ? <ListLine busy>{t("junkSearching", { q })}</ListLine> : null}
      {search.phase === "done" && search.hits.length === 0 && localCount === 0 ? (
        <ListLine>{t("junkSearchNone", { q })}</ListLine>
      ) : null}
      {search.phase === "done" && search.truncated ? <ListLine>{t("junkSearchTruncated")}</ListLine> : null}
      {search.phase === "done"
        ? search.mailboxes
            .filter((m) => m.window === "unreachable")
            .map((m) => (
              <ListLine key={m.id}>
                {t("junkSearchUnreachable", { address: displayAddress(m.address) })}
              </ListLine>
            ))
        : null}
      {search.phase === "failed" ? (
        <ListLine warn act={{ label: t("junkSearchRetry"), onPress: search.searchServer }}>
          {t("junkSearchFailed")}
        </ListLine>
      ) : null}
    </>
  );
}

export function Junk({ junk, view }: { junk: ScreenerJunk; view: JunkView<ScreenerJunkItem> }) {
  const t = useText("screener");
  const stamp = useJunkStamp();
  if (junk.phase === "loading") return <ListLine busy>{t("junkLoading")}</ListLine>;
  if (junk.phase === "failed")
    /* Failed, never empty: a folder nobody read is not clean. The way on is a press, not a loop. */
    return (
      <ListLine warn act={{ label: t("junkRetry"), onPress: junk.reload }}>
        {t("junkFailed")}
      </ListLine>
    );
  const { search } = junk;
  const query = search.query.trim();
  const localCount = query.length > 0 ? search.localCount : junk.visible.length;
  const kept = junk.visible.slice(0, localCount);
  const found = junk.visible.slice(localCount);
  const absent = junk.mailboxes.filter((m) => m.window !== "ok");
  const row = (i: ScreenerJunkItem) => <JunkRow key={junkKey(i)} item={i} view={view} t={t} stamp={stamp} />;
  return (
    <>
      <Field
        type="search"
        label={t("junkSearchLabel")}
        placeholder={t("junkSearchPlaceholder")}
        value={search.query}
        onChange={search.setQuery}
      />
      {kept.length > 0 ? <Rows label={t("segJunk")}>{kept.map(row)}</Rows> : null}
      {found.length > 0 ? (
        <>
          <GroupHeading count={String(found.length)}>{t("junkSearchAppended")}</GroupHeading>
          <Rows label={t("junkSearchAppended")}>{found.map(row)}</Rows>
        </>
      ) : null}
      {query.length > 0 ? <SearchLines junk={junk} localCount={localCount} /> : null}
      {query.length === 0 &&
      junk.items.length === 0 &&
      junk.mailboxes.length > 0 &&
      junk.mailboxes.every((m) => m.window === "ok") ? (
        <Empty label={t("place.empty.junk")} />
      ) : null}
      {/* A mailbox whose folder was not read, or that has none, is named under whatever did load. */}
      {absent.map((m) => (
        <ListLine key={m.id}>
          {t(m.window === "no_junk_folder" ? "quarantineMove.mailbox" : "junkUnreachable", {
            address: displayAddress(m.address),
          })}
        </ListLine>
      ))}
      {junk.nextCursor !== null && query.length === 0 ? (
        junk.olderLoading ? (
          <ListLine busy>{t("junkOlderLoading")}</ListLine>
        ) : (
          <ListLine act={{ label: t("junkOlder"), quiet: true, onPress: junk.loadOlder }} />
        )
      ) : null}
      <ListLine fine>{t("junkRetention")}</ListLine>
    </>
  );
}
