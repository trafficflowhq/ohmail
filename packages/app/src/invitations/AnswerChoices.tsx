import { AnswerSwitch, type AnswerSwitchProps } from "@ohmail/ui/calendar";
import type { InvitationAnswer, InvitationRow } from "@ohmail/app-logic/calendar/invitations";
import { useText } from "../text/index.js";

export const ANSWERS: readonly InvitationAnswer[] = ["accepted", "tentative", "declined"];
export const isAnswer = (value: string): value is InvitationAnswer =>
  (ANSWERS as readonly string[]).includes(value);

export function AnswerChoices({
  answer,
  onAnswer,
  on,
  propose,
}: {
  readonly answer: InvitationRow["answer"];
  readonly onAnswer: (value: InvitationAnswer, anchor: HTMLButtonElement) => void;
  readonly propose?: AnswerSwitchProps["propose"];
  readonly on?: "sheet";
}) {
  const t = useText("invitations");
  return (
    <AnswerSwitch
      label={t("answer.label")}
      {...(on ? { on } : {})}
      propose={propose}
      answers={{
        options: ANSWERS.map((value) => ({ value, label: t(`answer.${value}`) })),
        value: isAnswer(answer) ? answer : null,
        onChange: (value, anchor) => isAnswer(value) && value !== answer && onAnswer(value, anchor),
      }}
    />
  );
}
