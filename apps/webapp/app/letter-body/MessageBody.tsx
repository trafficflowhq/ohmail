"use client";

/**
 * THE LETTER'S BODY AS TODAY'S VIEWS MOUNT IT: the body package's renderer, handed the scope of the shell it is drawn
 * in for the one choice it keeps (a letter shown in its original look). The package looks nobody up; drawn in no
 * shell, this mount hands none and the choice holds for the mount alone. The reader hands its host's scope itself.
 * It leaves with the last of today's views.
 */
import { MessageBody as LetterBody, type MessageBodyProps } from "@ohmail/letter-body";
import { useScopeHere } from "@ohmail/app/frame/scope";

export { MAIL_BODY_COPY as COPY } from "@ohmail/letter-body";

export function MessageBody(props: Omit<MessageBodyProps, "owner">) {
  return <LetterBody {...props} owner={useScopeHere()} />;
}
