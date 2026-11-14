/**
 * The namespaces the connect form reads: the Mailboxes place's own three, the join's (its form's words stay the
 * join's own where the join mounts it) and the devices' two sentences about the second factor's window.
 */
export const CONNECT_NAMESPACES = ["mailboxes", "providerPicker", "onboarding", "join", "devices"] as const;
export type ConnectNamespace = (typeof CONNECT_NAMESPACES)[number];
