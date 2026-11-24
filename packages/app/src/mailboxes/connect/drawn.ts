import type { ConnectForm } from "@ohmail/app-logic/mailboxes/connect/use-connect-form";
import type { Text } from "../../text/index.js";
import type { ConnectAsk, ConnectDoor, ConnectSubject } from "./contract.js";
import type { ConnectNamespace } from "./namespace.js";
import type { FormWords, Word } from "./words.js";

/** What every part of the form is handed: the hook's value, the mount's ask, the words of this purpose and the reader. */
export interface Drawn {
  readonly form: ConnectForm;
  readonly ask: ConnectAsk;
  readonly door: ConnectDoor;
  /** The mailbox an edit or a reconnect is about. */
  readonly subject: ConnectSubject | null;
  readonly words: FormWords;
  say(word: Word, values?: Record<string, string | number>): string;
  text(namespace: ConnectNamespace): Text;
}
