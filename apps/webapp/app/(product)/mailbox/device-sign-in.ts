import { deviceSignInRefusalCode, pollDelay } from "@ohmail/app-logic/mailboxes/connect/sign-in";
import { NO_DETAILS } from "@ohmail/app-logic/mailboxes/connect/refusal";
import { mailboxIdOfAnswer } from "@ohmail/app-logic/mailboxes/connect/subject";
import type { Answered, CodeCeremony, Refusal, SignInProvider } from "@ohmail/app-logic/mailboxes/connect/types";
import { sessionIsDead, subscribeSessionTruth } from "@ohmail/app-logic/session/session-truth";
import { durableSessionRemove, durableSessionSet } from "@ohmail/app-logic/storage/durable";
import { readSessionFamily } from "../../signed-out-signal";
import { ApiError, apiOwnerHolds, boundApiFamily, boundApiOwner, mailboxes } from "../../api-client";

export const DEVICE_SIGN_IN_KEY = "ohmail.oauth.device";

/** Clear records from the older pane, which stored the display values along with the handle. */
export function discardLegacyDeviceSignIn(): void {
  durableSessionRemove("ohmail.deviceCeremony", "device.ceremony");
}

interface StoredCeremony {
  readonly handle: string;
  readonly deadline: number;
  readonly account: string;
}

type ActiveCeremony = StoredCeremony & { readonly family: string | undefined };

const HANDLE = /^[A-Za-z0-9._~-]{1,512}$/;
// A restored handle still has to match the server's sealed session on its first poll.
function familyOf(account: string): string | undefined {
  return boundApiFamily(account) ?? readSessionFamily() ?? undefined;
}

function stillOwns(entry: Pick<ActiveCeremony, "account" | "family">): boolean {
  const current = readSessionFamily();
  return owner() === entry.account && familyOf(entry.account) === entry.family
    && (current === null || current === entry.family);
}

const NO_ANSWER: Refusal = { status: 0, code: null, message: "", details: NO_DETAILS };

function deviceRefusal(error: unknown): Refusal {
  if (!(error instanceof ApiError)) return NO_ANSWER;
  return { ...NO_ANSWER, status: error.status, code: deviceSignInRefusalCode(error.code) };
}

function owner(): string | null {
  return apiOwnerHolds("/mailboxes/oauth/microsoft/device/poll") ? boundApiOwner() : null;
}

function forget(): void {
  durableSessionRemove(DEVICE_SIGN_IN_KEY, "device.ceremony");
}

function recall(account: string): ActiveCeremony | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(DEVICE_SIGN_IN_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;

  try {
    const entry = JSON.parse(raw) as Partial<StoredCeremony> | null;
    if (entry?.account === account && Object.keys(entry).length === 3 && typeof entry.handle === "string" && HANDLE.test(entry.handle)
      && typeof entry.deadline === "number" && Number.isFinite(entry.deadline) && entry.deadline > Date.now()) {
      return { account, handle: entry.handle, deadline: entry.deadline, family: familyOf(account) };
    }
  } catch {
    // Discard unreadable records as well as expired or differently owned ones.
  }
  forget();
  return null;
}

function displayCode(code: unknown, address: unknown, until: number): CodeCeremony | null {
  if (typeof code !== "string" || !/^[A-Za-z0-9-]{1,32}$/.test(code) || typeof address !== "string") return null;
  try {
    const url = new URL(address);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash
      || !["microsoft.com", "www.microsoft.com", "login.microsoftonline.com"].includes(url.hostname)
      || url.pathname.toLowerCase() !== "/devicelogin") return null;
    return { kind: "shown", code, openAt: url.href, until };
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();
let view: (Pick<ActiveCeremony, "account" | "family"> & { value: CodeCeremony }) | null = null;
let active: ActiveCeremony | null = null;
let starting: AbortController | null = null;
let polling: AbortController | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let nextAt = 0;
let delay = pollDelay(0);

function publish(next: typeof view): void {
  view = next;
  for (const changed of listeners) changed();
}

function clearTimer(): void {
  clearTimeout(timer);
  timer = undefined;
}

function retireWork(): void {
  clearTimer();
  starting?.abort();
  starting = null;
  polling?.abort();
  polling = null;
  active = null;
}

/** Called synchronously when this tab leaves its account. The sign-out sweep reports any storage failure. */
export function retireDeviceSignIn(): boolean {
  retireWork();
  const removed = durableSessionRemove(DEVICE_SIGN_IN_KEY, "device.ceremony") !== "lost";
  publish(null);
  return removed;
}

subscribeSessionTruth(() => {
  if (sessionIsDead()) retireDeviceSignIn();
});

function finish({ account, family }: ActiveCeremony, value: CodeCeremony): void {
  retireWork();
  forget();
  publish({ account, family, value });
}

function schedule(): void {
  if (active === null || listeners.size === 0 || polling !== null || timer !== undefined) return;
  const wait = Math.min(nextAt, active.deadline) - Date.now();
  if (wait <= 0) {
    void poll();
    return;
  }
  timer = setTimeout(() => {
    timer = undefined;
    void poll();
  }, wait);
}

async function poll(): Promise<void> {
  const entry = active;
  if (entry === null || listeners.size === 0) return;
  if (!stillOwns(entry)) {
    retireDeviceSignIn();
    return;
  }
  if (entry.deadline <= Date.now()) {
    finish(entry, { kind: "ended", why: "expired", refusal: null });
    return;
  }
  const request = new AbortController();
  polling = request;
  try {
    const reply = await mailboxes.deviceOAuthPoll({ state: entry.handle }, { expectedOwner: entry.account, expectedFamily: entry.family, signal: request.signal });
    if (polling !== request || !stillOwns(entry)) return;
    switch (reply.status) {
      case "pending": {
        delay = pollDelay(reply.retryAfterMs ?? delay);
        const shown = displayCode(reply.userCode, reply.verificationUri, entry.deadline);
        if (shown === null) throw NO_ANSWER;
        publish({ account: entry.account, family: entry.family, value: shown });
        break;
      }
      case "declined":
      case "expired":
        finish(entry, { kind: "ended", why: reply.status, refusal: null });
        break;
      case "granted": {
        const mailboxId = mailboxIdOfAnswer(reply.mailbox?.id);
        if (mailboxId === null) throw NO_ANSWER;
        const address = typeof reply.mailbox?.address === "string" ? reply.mailbox.address : null;
        finish(entry, { kind: "connected", connected: { mailboxId, address }, created: reply.created === true });
        break;
      }
      default:
        throw NO_ANSWER;
    }
  } catch (error) {
    if (polling !== request || !stillOwns(entry)) return;
    const refusal = deviceRefusal(error);
    if ((refusal.status >= 400 && refusal.status < 500 && refusal.status !== 429)
      || refusal.code === "oauth_device_unconfigured" || error === NO_ANSWER) {
      finish(entry, { kind: "ended", why: "refused", refusal });
    } else {
      const value = view?.value;
      if (value?.kind === "shown" || value?.kind === "checking") {
        publish({ account: entry.account, family: entry.family, value: { ...value, refusal } });
      }
    }
  } finally {
    if (polling === request) {
      polling = null;
      if (!stillOwns(entry)) retireDeviceSignIn();
      else {
        nextAt = Date.now() + delay;
        schedule();
      }
    }
  }
}

function run(entry: ActiveCeremony, value: CodeCeremony, interval = 0): void {
  active = entry;
  nextAt = Date.now();
  delay = pollDelay(interval);
  publish({ account: entry.account, family: entry.family, value });
  schedule();
}

export const webDeviceSignIn = {
  async begin(_provider: SignInProvider, stillWanted: () => boolean = () => true): Promise<Answered<null>> {
    const account = owner();
    if (account === null || starting !== null || active !== null) return { ok: false, refusal: NO_ANSWER };
    const family = familyOf(account);
    const request = new AbortController();
    starting = request;
    try {
      const reply = await mailboxes.deviceOAuthStart({ expectedOwner: account, expectedFamily: family, signal: request.signal });
      if (starting !== request || !stillOwns({ account, family }) || !stillWanted()) return { ok: false, refusal: NO_ANSWER };
      const deadline = Date.parse(reply.expiresAt);
      const shown = displayCode(reply.userCode, reply.verificationUri, deadline);
      if (typeof reply.state !== "string" || !HANDLE.test(reply.state) || shown === null
        || !Number.isFinite(deadline) || deadline <= Date.now()) return { ok: false, refusal: NO_ANSWER };
      const entry: StoredCeremony = { handle: reply.state, deadline, account };
      durableSessionSet(DEVICE_SIGN_IN_KEY, JSON.stringify(entry), "device.ceremony");
      run({ ...entry, family }, shown, reply.intervalMs);
      return { ok: true, value: null };
    } catch (error) {
      return { ok: false, refusal: deviceRefusal(error) };
    } finally {
      if (starting === request) starting = null;
    }
  },
  resume(): void {
    const account = owner();
    if (account === null || active?.account === account || starting !== null) return;
    if (active !== null) retireDeviceSignIn();
    const entry = recall(account);
    if (entry !== null) run(entry, { kind: "checking" });
  },
  live: {
    read: (): CodeCeremony | null => view !== null && stillOwns(view) ? view.value : null,
    subscribe(changed: () => void): () => void {
      listeners.add(changed);
      schedule();
      return () => {
        listeners.delete(changed);
        if (listeners.size === 0) clearTimer();
      };
    },
  },
  stop: retireDeviceSignIn,
};
