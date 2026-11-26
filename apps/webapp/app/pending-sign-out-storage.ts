import { isOwnerShaped } from "@ohmail/app-logic/storage/owner-cookie";
import { RETIRED_SIGN_OUT_STORAGE, SIGN_OUT_STORAGE_PREFIX as CLEANUP_PREFIX } from "@ohmail/app-logic/storage/storage-owner";

import { dropLocalStorageKeys, dropLocalStorageKeysWhere } from "@ohmail/app-logic/session/boot-cache";
import { LEGACY_COMPOSE_DRAFT_KEY } from "@ohmail/app-logic/writing/compose";
import { durableRemove, durableSet } from "@ohmail/app-logic/storage/durable";

export const PENDING_SIGN_OUT_KEY = "ohmail.session.pendingSignOut";
const CLEANUP_NOTICE = "ohmail.session.shownCleanupNotice";
const RETIRED_COMPOSE_CLEANUP = `${CLEANUP_PREFIX}compose`;
const ISOLATED_SCOPE_PREFIX = `${CLEANUP_PREFIX}isolated.`;
const cleanupKey = (owner: string): string => `${CLEANUP_PREFIX}account.${owner}`;

export interface PendingSignOut {
  press: string;
  account: string | null;
  family: string | null;
  cachePending?: boolean;
  revoked?: boolean;
  isolatedScope?: string;
}

function readOperation(key: string): PendingSignOut | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? "null") as Partial<PendingSignOut> | null;
    if (!value || typeof value.press !== "string" || value.press === ""
      || !(value.account === null || (typeof value.account === "string" && isOwnerShaped(value.account)))
      || !(value.family === null || (typeof value.family === "string" && isOwnerShaped(value.family)))) return null;
    return {
      press: value.press,
      account: value.account,
      family: value.family,
      cachePending: value.cachePending === true,
      revoked: value.revoked === true,
      isolatedScope: typeof value.isolatedScope === "string" && value.account !== null
        && value.isolatedScope === isolatedName(value.account, value.family) ? value.isolatedScope : undefined,
    };
  } catch {
    return null;
  }
}

export function readPendingSignOut(): PendingSignOut | null {
  return readOperation(PENDING_SIGN_OUT_KEY);
}

export function cleanupNoticeShown(press: string): boolean {
  try {
    return localStorage.getItem(CLEANUP_NOTICE) === press;
  } catch {
    return false;
  }
}

export function markCleanupNoticeShown(press: string): void {
  durableSet(CLEANUP_NOTICE, press, "session.signOut");
}

export function retainAccountCleanup(operation: PendingSignOut): void {
  if (operation.account !== null) durableSet(cleanupKey(operation.account), JSON.stringify(operation), "session.signOut");
}

/** Retired or shared storage is never assigned to a replacement account. */
export function retainRetiredCleanup(operation: PendingSignOut): void {
  durableSet(RETIRED_SIGN_OUT_STORAGE, JSON.stringify(operation), "session.signOut");
}

/** The retired compose name is outside every current account's read/write scope. */
export function retainRetiredComposeCleanup(operation: PendingSignOut): void {
  durableSet(RETIRED_COMPOSE_CLEANUP, JSON.stringify(operation), "session.signOut");
}

export function finishRetiredComposeCleanup(): void {
  const operation = readOperation(RETIRED_COMPOSE_CLEANUP);
  if (operation?.account == null) return;
  const local = dropLocalStorageKeysWhere((key) => key === LEGACY_COMPOSE_DRAFT_KEY);
  if (local.enumerated && local.survivors.length === 0 && readOperation(RETIRED_COMPOSE_CLEANUP)?.press === operation.press) {
    durableRemove(RETIRED_COMPOSE_CLEANUP, "session.signOut");
  }
}

function isolatedName(owner: string, family: string | null): string {
  return `${owner}~${family ?? "legacy"}`;
}

/** Keep drafts written under an isolated mount in the same scope on reload. */
export function readIsolatedScope(owner: string, family: string | null): string | undefined {
  const scope = isolatedName(owner, family);
  try {
    return window.localStorage.getItem(ISOLATED_SCOPE_PREFIX + owner) === scope ? scope : undefined;
  } catch {
    return undefined;
  }
}

export function isolateAccountScope(owner: string, family: string | null): string {
  const scope = isolatedName(owner, family);
  durableSet(ISOLATED_SCOPE_PREFIX + owner, scope, "session.signOut");
  return scope;
}

/** The fence survives a later press from another account. */
export function accountCleanup(owner: string): PendingSignOut | null {
  const operation = readOperation(cleanupKey(owner));
  return operation?.account === owner ? operation : null;
}

export function otherAccountCleanup(owner: string): string[] {
  try {
    const accounts: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      const operation = key?.startsWith(`${CLEANUP_PREFIX}account.`) ? readOperation(key) : null;
      if (operation?.account && operation.account !== owner) accounts.push(operation.account);
    }
    return accounts;
  } catch {
    return [];
  }
}

export function confirmAccountCleanup(owner: string): boolean {
  return durableRemove(cleanupKey(owner), "session.signOut") === "stored";
}

/** Only a verified exclusive wipe can remove all accounts' outstanding fences. */
export function clearAccountCleanup() {
  return dropLocalStorageKeys([CLEANUP_PREFIX]);
}

export function accountCleanupOwed(owner: string): boolean {
  return accountCleanup(owner) !== null;
}
