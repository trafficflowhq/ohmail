/**
 * The account group's door: its contract, the one machine of a gated act, which body each host asks for, the types
 * of the eight doors and their models, and every state the panes build. It draws no pane: a shell takes types from
 * here and each pane by its own entry, so a build that may show no price never loads Subscription.
 */
import type { AccountPaneId, CLOSED_ACCOUNT_REACH, ClosedReach } from "./contract.js";
import type { AccountDoor } from "./account/model.js";
import type { PasswordDoor } from "./account/password.js";
import { PASSWORD_STATES, accountPaneStates } from "./account/states.js";
import type { DevicesDoor } from "./devices/model.js";
import { devicesStates } from "./devices/states.js";
import type { InvitesDoor } from "./invites/model.js";
import { invitesStates } from "./invites/states.js";
import type { SecurityDoor } from "./security/model.js";
import { securityStates } from "./security/states.js";
import type { StorageDoor } from "./storage/model.js";
import { storageFactsStates, storageStates } from "./storage/states.js";
import type { SubscriptionDoor } from "./subscription/model.js";
import { subscriptionStates } from "./subscription/states.js";
import type { WayOutDoor } from "./way-out/model.js";
import { WAY_OUT_STATES } from "./way-out/states.js";

export * from "./contract.js";
export {
  GATED_IDLE,
  gatedAsk,
  gatedStep,
  type GatedAnswer,
  type GatedDialogEvent,
  type GatedEvent,
  type GatedRefusal,
  type GatedRun,
  type GatedState,
  type GatedStepped,
} from "./gated.js";
export { accountBodies, type AccountBodies } from "./bodies.js";
export type { AccountDoor, AccountModel } from "./account/model.js";
export type { PasswordCheck, PasswordDoor, PasswordModel, PasswordTyped } from "./account/password.js";
export type {
  DeviceKind,
  DeviceName,
  DeviceSession,
  DevicesAct,
  DevicesDoor,
  DevicesModel,
  MadeLink,
  PairingCode,
  WebGroup,
} from "./devices/model.js";
export type { InvitesAct, InvitesDoor, InvitesModel, MadeInvite, OpenInvite } from "./invites/model.js";
export type { Enrolled, SecurityAct, SecurityDoor, SecurityModel } from "./security/model.js";
export type {
  BarSpan,
  StorageBar,
  StorageDoor,
  StorageFigures,
  StorageModel,
  StorageNeeds,
  StoragePlan,
  StoragePlanLine,
  StoragePlanName,
  StorageRoom,
  StorageRow,
} from "./storage/model.js";
export type {
  AddonLine,
  PlanInterval,
  PlanLine,
  PlanName,
  PlanPick,
  PlansAnswer,
  Standing,
  SubscriptionDoor,
  SubscriptionModel,
  SubscriptionStatus,
} from "./subscription/model.js";
export type { WayOutDoor, WayOutModel, WayOutSection } from "./way-out/model.js";

/**
 * EVERY STATE OF THE SIX PANES AND THE CARD, by pane id: each with its address in the comparison's registry, or `null`
 * where no picture draws it (a read that failed, a refused write, the factor discarded). A pane whose states hold what
 * only a page may hold (a link, an address, a key, an amount) answers them from the page's fixtures; no source file
 * holds one. Beside the six: Storage where the build may not link out, the password form as the wall draws it alone,
 * and the "handled in your browser" card.
 */
export const ACCOUNT_STATES = {
  devices: devicesStates,
  billing: subscriptionStates,
  storage: storageStates,
  invites: invitesStates,
  security: securityStates,
  account: accountPaneStates,
  storageFacts: storageFactsStates,
  password: PASSWORD_STATES,
  wayOut: WAY_OUT_STATES,
} as const satisfies Readonly<Record<AccountPaneId | "storageFacts" | "password" | "wayOut", unknown>>;

/** The eight doors, by the names the contract's lists are keyed with. */
export interface AccountDoors {
  readonly devices: DevicesDoor;
  readonly invites: InvitesDoor;
  readonly security: SecurityDoor;
  readonly password: PasswordDoor;
  readonly account: AccountDoor;
  readonly subscription: SubscriptionDoor;
  readonly storage: StorageDoor;
  readonly wayOut: WayOutDoor;
}

/*
 * WHAT THE COMPILER REFUSES. Every member of every door has its row of what a closed account still reaches, and no
 * row names a member a door does not have: a member added without its row, or a row left behind, does not compile.
 */
type RowForEveryMember = {
  readonly [D in keyof AccountDoors]: Readonly<Record<keyof AccountDoors[D], ClosedReach>>;
};
type NoRowWithoutItsMember = {
  readonly [D in keyof AccountDoors]: Exclude<keyof (typeof CLOSED_ACCOUNT_REACH)[D], keyof AccountDoors[D]>;
}[keyof AccountDoors];
type Holds<T extends true> = T;
export type ClosedReachIsWhole = [
  Holds<typeof CLOSED_ACCOUNT_REACH extends RowForEveryMember ? true : false>,
  Holds<[NoRowWithoutItsMember] extends [never] ? true : false>,
];
