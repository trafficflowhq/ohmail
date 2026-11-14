/**
 * DRAFTS' READING COLUMN. With nothing open it says what the list holds. A row that holds a send nobody could
 * confirm, open, stands its sentence and its two answers (Send again, It was sent) beside Discard. Any other open
 * draft is the composer's, which its seat stands here.
 */
import { heldSentence, isHeld, useDraftsModel } from "@ohmail/app-logic/drafts";
import { ActionPanel, BlankColumn, ReadingHead, Sheet } from "@ohmail/ui/mail";
import { recipientsOf } from "./words.js";
import type { PaneProps } from "../frame/contract.js";
import { useText } from "../text/index.js";
import { HeldSendAnswers } from "../write/HeldSendAnswers.js";

export function DraftsReading({ route }: PaneProps) {
  const model = useDraftsModel();
  const t = useText("drafts");
  const open = route.open === null ? null : (model.drafts.find((d) => d.id === route.open) ?? null);
  if (open !== null && isHeld(model.door, open)) {
    const subject = open.subject.trim() || t("noSubject");
    return (
      <Sheet
        kind="reading"
        label={subject}
        foot={
          <HeldSendAnswers
            draftId={open.id}
            onResolve={model.door.resolve}
            onSendAgain={() => model.door.sendAgain(open)}
          >
            {(again, sent) => (
              <ActionPanel
                label={t("heldActs")}
                items={[
                  { note: t(heldSentence(open, model.now)), keep: true },
                  { ...again, kind: "ink", rank: 0 },
                  sent,
                  {
                    id: "discard",
                    label: t("discard"),
                    icon: "trash",
                    onPress: () => model.discard(open.id),
                  },
                ]}
              />
            )}
          </HeldSendAnswers>
        }
      >
        <ReadingHead subject={subject} people={[]} names={recipientsOf(open) || t("noRecipient")} />
      </Sheet>
    );
  }
  const count = model.drafts.length + model.scheduled.length;
  if (model.loading) return null;
  return <BlankColumn>{count > 0 ? t("metaCount", { count }) : t("emptyTitle")}</BlankColumn>;
}
