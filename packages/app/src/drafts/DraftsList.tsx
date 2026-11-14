/**
 * DRAFTS' LIST: the sends set for later first, each with Cancel send and when it sends; then the drafts, each with
 * Discard (one press, with Undo). A row that holds a send nobody could confirm says so on its row; its two answers
 * stand in the reading column when it is open. Opening a row is the door's: a reply as that reply, else the composer.
 */
import type { EngineDraft } from "@ohmail/client-engine";
import { heldSentence, isHeld, useDraftsModel, type DraftsModel } from "@ohmail/app-logic/drafts";
import { Empty, RefusalLine } from "@ohmail/ui/base";
import { GroupHeading, ListHead, Row, Rows } from "@ohmail/ui/mail";
import type { PaneProps } from "../frame/contract.js";
import { ListColumn, ListMenu } from "../place-list/index.js";
import { useText, type Text } from "../text/index.js";
import { recipientsOf, refusalKey } from "./words.js";

export function DraftsList({ route, plan }: PaneProps) {
  const model = useDraftsModel();
  const t = useText("drafts");
  const count = model.drafts.length + model.scheduled.length;
  const rows = (
    <>
      {model.scheduled.length > 0 ? (
        <section aria-label={t("scheduledTitle")}>
          <GroupHeading count={String(model.scheduled.length)}>{t("scheduledTitle")}</GroupHeading>
          <Rows label={t("scheduledTitle")}>
            {model.scheduled.map((d) => (
              <ScheduledRow key={d.id} d={d} model={model} t={t} open={route.open === d.id} />
            ))}
          </Rows>
        </section>
      ) : null}
      {model.drafts.length > 0 ? (
        <section aria-label={t("title")}>
          {model.scheduled.length > 0 ? (
            <GroupHeading count={String(model.drafts.length)}>{t("title")}</GroupHeading>
          ) : null}
          <Rows label={t("title")}>
            {model.drafts.map((d) => (
              <DraftRow key={d.id} d={d} model={model} t={t} open={route.open === d.id} />
            ))}
          </Rows>
        </section>
      ) : null}
      {model.empty ? <Empty label={t("emptyTitle")} /> : null}
      {model.loading ? <Empty label={t("listLoading")} /> : null}
    </>
  );
  return (
    <ListColumn
      plan={plan}
      head={
        <ListHead
          title={t("title")}
          count={count > 0 ? t("metaCount", { count }) : undefined}
          aside={<ListMenu label={t("listMenu")} items={[]} />}
        />
      }
    >
      {rows}
    </ListColumn>
  );
}

/** A scheduled send speaks for whom it goes to, with their circle, and says it is a reply. */
function ScheduledRow({ d, model, t, open }: { d: EngineDraft; model: DraftsModel; t: Text; open: boolean }) {
  const to = recipientsOf(d);
  const first = [...d.to, ...d.cc, ...d.bcc][0];
  const subject = d.subject.trim() || t("noSubject");
  const sends = d.sendAt ? t("scheduledWhen", { when: model.appointment(d.sendAt) }) : "";
  return (
    <Row
      who={to ? t("rowTo", { name: to }) : t("noRecipient")}
      address={first?.address}
      people={first ? [{ name: first.name || first.address, address: first.address }] : []}
      sign="clock"
      labels={model.door.repliesHere(d) ? [t("isReply")] : undefined}
      subject={sends ? `${sends} · ${subject}` : subject}
      preview={d.body ?? undefined}
      open={open}
      own={{ label: t("scheduledCancel"), onPress: () => model.door.cancelSchedule(d.id) }}
      onOpen={() => model.door.editScheduled(d)}
      listing={{ name: `${to || t("noRecipient")}: ${subject}`, spoken: sends, selected: open }}
      mark={{ id: d.id }}
    />
  );
}

function DraftRow({ d, model, t, open }: { d: EngineDraft; model: DraftsModel; t: Text; open: boolean }) {
  const to = recipientsOf(d);
  const subject = d.subject.trim() || t("noSubject");
  const waits = model.door.waiting.has(d.id);
  const held = isHeld(model.door, d);
  const state = waits
    ? t("waitingToSend")
    : held
      ? t(heldSentence(d, model.now))
      : (model.door.notSent.get(d.id) ??
        (d.sendError
          ? t("scheduleFailedNote", { reason: d.sendError })
          : d.sendFiles
            ? t("filesNotKeptNote", { count: d.sendFiles })
            : null));
  const refused = model.refusal?.draftId === d.id ? model.refusal : null;
  return (
    <div className="dr-row" data-id={d.id}>
      <Row
        who={to || t("noRecipient")}
        people={[]}
        sign={model.door.repliesHere(d) ? "reply" : "drafts"}
        subject={subject}
        preview={state ?? d.body ?? undefined}
        when={model.stamp(d.updatedAt)}
        open={open}
        own={{ label: t("discard"), onPress: () => model.discard(d.id) }}
        onOpen={() => model.door.open(d)}
        listing={{
          name: `${to || t("noRecipient")}: ${subject}`,
          spoken: [model.door.repliesHere(d) ? t("isReply") : null, state].filter(Boolean).join(", "),
          selected: open,
        }}
        mark={{ id: d.id }}
      />
      {refused ? <RefusalLine key={refused.at}>{t(refusalKey(refused.why))}</RefusalLine> : null}
    </div>
  );
}
