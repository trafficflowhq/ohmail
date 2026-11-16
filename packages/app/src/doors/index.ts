/**
 * The doors' door: what a shell and the doors' pages share, the types of each page's door and the namespaces the
 * doors read. No component stands here: each page is its own entry (`@ohmail/app/doors/<page>`), and the stage the
 * pages stand on is `@ohmail/app/doors/stage`.
 */
export * from "./sign-in/invite-posture.js";
export type {
  PendingSignOutDoor,
  SignInDoor,
  SignInFactor,
  SignInField,
  SignInRefusal,
  SignInState,
} from "./sign-in/door.js";
export type { DoorWay } from "./stage/way.js";
export { SIGN_IN_REFUSAL_SAID } from "./sign-in/door.js";
export type { SignedOutDoor, SignedOutReason, SignedOutState } from "./signed-out/door.js";
export { SIGNED_OUT_STATES, signedOutStateOf, type SignedOutStateId } from "./signed-out/states.js";
export { SIGNED_OUT_NAMESPACES } from "./signed-out/namespace.js";
export type { NoPageDoor } from "./no-page/door.js";
export { NO_PAGE_STATES, type NoPageStateId } from "./no-page/states.js";
export { NO_PAGE_NAMESPACES } from "./no-page/namespace.js";

export { SIGN_IN_NAMESPACES } from "./sign-in/namespace.js";
export type { VerifyDoor, VerifyField, VerifyState } from "./verify/door.js";
export { VERIFY_STATES, type VerifyStateId } from "./verify/states.js";
export { VERIFY_NAMESPACES } from "./verify/namespace.js";
export type { SetupDoor, SetupField, SetupState } from "./setup/door.js";
export { SETUP_STATES, type SetupStateId } from "./setup/states.js";
export { SETUP_NAMESPACES } from "./setup/namespace.js";
export type { InviteDoor, InviteField, InviteState } from "./invite/door.js";
export { INVITE_STATES, type InviteStateId } from "./invite/states.js";
export { INVITE_NAMESPACES } from "./invite/namespace.js";
export type { SubscribedDoor, SubscribedState } from "./subscribed/door.js";
export { SUBSCRIBED_STATES, type SubscribedStateId } from "./subscribed/states.js";
export { SUBSCRIBED_NAMESPACES } from "./subscribed/namespace.js";
export type { JoinCopied, JoinDoor, JoinField, JoinPlanChosen, JoinState, JoinStation } from "./join/door.js";
export { JOIN_STATES, type JoinStateId } from "./join/states.js";
export { JOIN_NAMESPACES } from "./join/namespace.js";
export type { Blanks } from "./stage/fields.js";
export type {
  StepUpDoor,
  StepUpFactor,
  StepUpFactors,
  StepUpProps,
  StepUpRefusal,
  StepUpVerified,
} from "./step-up/door.js";
export { STEP_UP_STATES, type StepUpStateId } from "./step-up/states.js";
export { STEP_UP_NAMESPACES } from "./step-up/namespace.js";
export type { ApproveAsked, ApproveDoor, ApproveState } from "./approve/door.js";
export { APPROVE_STATES, type ApproveStateId } from "./approve/states.js";
export { APPROVE_NAMESPACES } from "./approve/namespace.js";
export type { AuthorizeDesktopDoor, AuthorizeDesktopState } from "./authorize-desktop/door.js";
export { AUTHORIZE_DESKTOP_STATES, type AuthorizeDesktopStateId } from "./authorize-desktop/states.js";
export { AUTHORIZE_DESKTOP_NAMESPACES } from "./authorize-desktop/namespace.js";
export type { LinkDesktopDoor, LinkDesktopPress, LinkDesktopState } from "./link-desktop/door.js";
export { LINK_DESKTOP_STATES, type LinkDesktopStateId } from "./link-desktop/states.js";
export { LINK_DESKTOP_NAMESPACES } from "./link-desktop/namespace.js";
export type { DeleteAccountDoor, DeleteAccountService, DeleteAccountState } from "./delete-account/door.js";
export { DELETE_ACCOUNT_STATES, type DeleteAccountStateId } from "./delete-account/states.js";
export { DELETE_ACCOUNT_NAMESPACES } from "./delete-account/namespace.js";
export type { WallDoor, WallHeadline, WallStanding, WallState, WallWayBack } from "./wall/door.js";
export { WALL_STATES, type WallStateId } from "./wall/states.js";
export { WALL_NAMESPACES } from "./wall/namespace.js";

import { INVITE_NAMESPACES } from "./invite/namespace.js";
import { JOIN_NAMESPACES } from "./join/namespace.js";
import { NO_PAGE_NAMESPACES } from "./no-page/namespace.js";
import { SETUP_NAMESPACES } from "./setup/namespace.js";
import { SIGN_IN_NAMESPACES } from "./sign-in/namespace.js";
import { SIGNED_OUT_NAMESPACES } from "./signed-out/namespace.js";
import { SUBSCRIBED_NAMESPACES } from "./subscribed/namespace.js";
import { VERIFY_NAMESPACES } from "./verify/namespace.js";
import { STEP_UP_NAMESPACES } from "./step-up/namespace.js";
import { APPROVE_NAMESPACES } from "./approve/namespace.js";
import { AUTHORIZE_DESKTOP_NAMESPACES } from "./authorize-desktop/namespace.js";
import { LINK_DESKTOP_NAMESPACES } from "./link-desktop/namespace.js";
import { DELETE_ACCOUNT_NAMESPACES } from "./delete-account/namespace.js";
import { WALL_NAMESPACES } from "./wall/namespace.js";

/** Every namespace a door's page reads, or its server file reads for it, for the shells that hand pages their words. */
export const DOOR_NAMESPACES: readonly string[] = [
  ...new Set([
    ...SIGN_IN_NAMESPACES,
    ...VERIFY_NAMESPACES,
    ...SIGNED_OUT_NAMESPACES,
    ...NO_PAGE_NAMESPACES,
    ...SETUP_NAMESPACES,
    ...INVITE_NAMESPACES,
    ...SUBSCRIBED_NAMESPACES,
    ...JOIN_NAMESPACES,
    ...STEP_UP_NAMESPACES,
    ...APPROVE_NAMESPACES,
    ...AUTHORIZE_DESKTOP_NAMESPACES,
    ...LINK_DESKTOP_NAMESPACES,
    ...DELETE_ACCOUNT_NAMESPACES,
    ...WALL_NAMESPACES,
  ]),
];
