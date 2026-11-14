/**
 * TRASH'S LIST: what ohmail deleted, each row with when and where Restore puts it; under it, the mail server's own
 * Trash, read-only, in each of its states (a failure is said with a way to ask again, never drawn as empty; an empty
 * one says its count of nothing in its heading, with no sentence under it).
 */
import { trashLiveKeyOf, useTrashModel, type TrashModel } from "@ohmail/app-logic/trash";
import { Button, Empty, RefusalLine } from "@ohmail/ui/base";
import { GroupHeading, ListHead, Row, Rows } from "@ohmail/ui/mail";
import type { PaneProps } from "../frame/contract.js";
import { ListColumn } from "../place-list/index.js";
import { useText, type Text } from "../text/index.js";

export function TrashList({ plan }: PaneProps) {
  const model = useTrashModel();
  const t = useText("trash");
  const { page } = model;
  const head = <ListHead title={t("title")} />;
  return (
    <ListColumn head={head} plan={plan}>
      {!page.available ? <Empty label={t("unavailable")} /> : null}
      {page.items.length > 0 ? (
        <Rows label={t("title")}>
          {page.items.map((r) => {
            const open = model.openId === r.id;
            const who = r.from.name ?? r.from.address;
            const deleted = r.trashedAt ? t("deletedAt", { when: model.stamp(r.trashedAt) }) : undefined;
            const to = r.restoreTo ? model.placeOf(r.restoreTo) : undefined;
            /* Where Restore puts it, as the design writes it: the arrow back, then the place (a sign, the same in
               every language; the place is the person's own word for it). */
            const back = to === undefined ? undefined : `← ${to}`;
            return (
              <Row
                key={r.id}
                who={who}
                address={r.from.address}
                people={[{ name: who, address: r.from.address }]}
                subject={r.subject}
                preview={r.snippet ?? undefined}
                when={deleted}
                where={back}
                open={open}
                onOpen={() => model.open(r.id)}
                listing={{
                  name: `${who}: ${r.subject}`,
                  spoken: [deleted, to].filter(Boolean).join(", "),
                  selected: open,
                  stop: open,
                }}
                mark={{ id: r.id }}
              />
            );
          })}
        </Rows>
      ) : null}
      {/* A failed read with the server's own sentence says it; with none, the way to ask again stands alone. */}
      {page.available && page.error !== null && page.error !== "" ? (
        <RefusalLine way={{ label: t("liveRetry"), onPress: page.loadMore }}>{page.error}</RefusalLine>
      ) : null}
      {page.available && page.error === "" ? (
        <Button kind="quiet" onPress={page.loadMore}>
          {t("liveRetry")}
        </Button>
      ) : null}
      {page.available && page.items.length === 0 && page.exhausted && page.error === null ? (
        <Empty label={t("emptyTitle")} />
      ) : null}
      {page.available && page.loading && page.items.length === 0 ? (
        <div role="status" aria-busy="true" />
      ) : null}
      {page.available && !page.exhausted && page.items.length > 0 && page.error === null ? (
        <Button kind="quiet" disabled={page.loading} onPress={page.loadMore}>
          {page.loading ? t("liveOlderLoading") : t("liveOlder")}
        </Button>
      ) : null}
      {model.live.shown ? <LiveSection model={model} t={t} /> : null}
    </ListColumn>
  );
}

/** The mail server's own Trash: rows with no verb, or the one sentence its state is. */
function LiveSection({ model, t }: { model: TrashModel; t: Text }) {
  const { live } = model;
  const said: Record<Exclude<typeof live.state.state, "rows">, string> = {
    loading: t("liveLoading"),
    failed: t("liveFailed"),
    unavailable: t("liveUnavailable"),
    read_limited: t("liveReadLimited"),
    more_to_read: t("liveOlder"),
    empty: t("liveEmpty"),
  };
  const state = live.state.state;
  return (
    <section aria-label={t("liveHead")}>
      {/* A count only once the last page is read: with older rows to read, the heading says no number. */}
      <GroupHeading
        count={
          (state === "rows" || state === "empty") && live.nextCursor === null
            ? String(live.items.length)
            : undefined
        }
      >
        {t("liveHead")}
      </GroupHeading>
      {state === "rows" ? (
        <Rows label={t("liveHead")}>
          {live.items.map((i) => {
            const key = trashLiveKeyOf(i);
            const who = i.from.name ?? i.from.address;
            const open = model.openId === key;
            return (
              <Row
                key={key}
                who={who}
                address={i.from.address}
                people={[{ name: who, address: i.from.address }]}
                subject={i.subject}
                when={i.date ? model.stamp(i.date) : undefined}
                where={t("liveOrigin")}
                open={open}
                onOpen={() => model.open(key)}
                listing={{
                  name: `${who}: ${i.subject}`,
                  spoken: t("liveOrigin"),
                  selected: open,
                  stop: open,
                }}
                mark={{ id: key }}
              />
            );
          })}
        </Rows>
      ) : state === "failed" ? (
        <RefusalLine way={{ label: t("liveRetry"), onPress: live.reload }}>{said.failed}</RefusalLine>
      ) : state === "empty" ? null : (
        <Empty label={said[state]} />
      )}
      {live.nextCursor !== null && (state === "rows" || state === "more_to_read") ? (
        <Button kind="quiet" disabled={live.olderLoading} onPress={live.loadOlder}>
          {live.olderLoading ? t("liveOlderLoading") : t("liveOlder")}
        </Button>
      ) : null}
    </section>
  );
}
