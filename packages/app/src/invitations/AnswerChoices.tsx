import { AnswerSwitch } from "@ohmail/ui/calendar";
import type { InvitationAnswer, InvitationRow } from "@ohmail/app-logic/calendar/invitations";
import { useText } from "../text/index.js";

const ANSWERS: readonly InvitationAnswer[] = ["accepted", "tentative", "declined"];
export const isAnswer = (value: string): value is InvitationAnswer =>
  (ANSWERS as readonly string[]).includes(value);

export function AnswerChoices({
  answer,
  onAnswer,
  on,
}: {
  readonly answer: InvitationRow["answer"];
  readonly onAnswer: (value: InvitationAnswer) => void;
  readonly on?: "sheet";
}) {
  const t = useText("invitations");
  return (
    <AnswerSwitch
      label={t("answer.label")}
      {...(on ? { on } : {})}
      answers={{
        options: ANSWERS.map((value) => ({ value, label: t(`answer.${value}`) })),
        value: isAnswer(answer) ? answer : null,
        onChange: (value) => isAnswer(value) && value !== answer && onAnswer(value),
      }}
    />
  );
}
