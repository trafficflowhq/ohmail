/**
 * The namespaces the connect form reads: the Mailboxes place's own three, the join's (its form's words stay the
 * join's own where the join mounts it), the devices' two sentences about the second factor's window, and the
 * phone's two where a phone opens its own mailbox (its form's words, and the sentences of what its native side
 * refused).
 */
export const CONNECT_NAMESPACES = [
  "mailboxes",
  "providerPicker",
  "onboarding",
  "join",
  "devices",
  "phoneDoor",
  "phoneRefusal",
] as const;
export type ConnectNamespace = (typeof CONNECT_NAMESPACES)[number];
