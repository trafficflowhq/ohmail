/** The one connect form: the form, the words a caller may keep for it, its contract and the namespaces it reads. */
export { ConnectForm } from "./ConnectForm.js";
export { Consents } from "./Consents.js";
export { useConnectKept } from "@ohmail/app-logic/mailboxes/connect/kept";
export { CONNECT_NAMESPACES, type ConnectNamespace } from "./namespace.js";
export type {
  CalendarHalfSlot,
  ConnectAsk,
  ConnectDoor,
  ConnectFormProps,
  ConnectGuard,
  ConnectPurpose,
  ConnectResult,
  ConnectSlot,
  ConnectSubject,
  FactorAsk,
  FactorSlot,
} from "./contract.js";
