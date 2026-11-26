import { refuse, type Refusal } from "../refusal";
import { WEB_APP_URL } from "./account";
import type { FetchLike } from "./bearer";
import { discardAdmission, MANAGED_ORIGIN, probePairing, type MintedPair, type MobileDeviceKind, type PairingEnv, type ProbeOutcome } from "./pairing";
import { withinApprovalDeadline } from "./approval-deadline";
import { addressProblem, parseServerAddress, PROBE_DEADLINE_MS } from "./server-base";

export type ApprovalBrowserExit = "cancelled" | "failed" | "wrong-server";

export interface BrowserApprovalDeps {
  readonly fetchImpl: FetchLike;
  readonly kind: MobileDeviceKind;
  readonly label: string;
  readonly calendarOnly?: boolean | undefined;
  readonly pkce: () => Promise<{ verifier: string; challenge: string }>;
  /** Resolves when launched. The callback reports when the system sheet finishes. */
  readonly open: (url: string, signal: AbortSignal, onClosed: (result: ApprovalBrowserExit) => void, launch?: string) => Promise<boolean>;
  readonly close: () => void;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now: () => number;
  readonly previousSession: string | null;
}

export type ApprovalOutcome =
  | { readonly ok: true; readonly approved: MintedPair; readonly scope?: "calendar" }
  | { readonly ok: false; readonly reason: Refusal; readonly issued?: MintedPair };

const APPROVAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Typed addresses use the same rules as the server picker, with HTTPS required for this browser flow. */
export function browserSignInOrigin(address: string | null): { origin: string } | { reason: Refusal } {
  if (address === null) return { origin: MANAGED_ORIGIN };
  const problem = addressProblem(address);
  if (problem !== null) return { reason: problem };
  const origin = parseServerAddress(address);
  if (origin === null || !origin.startsWith("https://")) return { reason: refuse("baseCleartext") };
  return { origin };
}

/** Wait only for the existing credential-free pairing probe. Back can leave it without blocking another attempt. */
export async function probeBrowserSignIn(env: PairingEnv, origin: string, signal: AbortSignal): Promise<ProbeOutcome> {
  if (signal.aborted) return { kind: "refused", reason: refuse("connectSuperseded") };
  const transport = env.approvalFetchImpl;
  if (!transport) return { kind: "refused", reason: refuse("signInUnreachable") };
  const fetchImpl: FetchLike = (url, init) => transport(url, {
    ...(init as RequestInit), credentials: "omit", redirect: "error",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: () => void = () => {};
  const ended = new Promise<ProbeOutcome>((resolve) => {
    stop = () => resolve({ kind: "refused", reason: refuse("connectSuperseded") });
    signal.addEventListener("abort", stop, { once: true });
    timer = setTimeout(() => resolve({ kind: "refused", reason: refuse("signInUnreachable") }), 3 * PROBE_DEADLINE_MS);
  });
  const probing = probePairing({ ...env, fetchImpl }, { origin });
  let accepted: ProbeOutcome | undefined;
  try {
    accepted = await Promise.race([probing, ended]);
    return accepted;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    void probing.then((late) => {
      if (late !== accepted && late.kind === "offers") discardAdmission(late.admission);
    }, () => {});
  }
}

type ApprovalBody = {
  approvalId?: unknown;
  expiresIn?: unknown;
  launch?: unknown;
  scope?: unknown;
  retryAfterMs?: unknown;
  tokens?: { accessToken?: unknown; refreshToken?: unknown };
  error?: { code?: unknown };
};

async function post(fetchImpl: FetchLike, url: string, data: object) {
  return withinApprovalDeadline(async (signal) => {
    const response = await fetchImpl(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data),
      credentials: "omit", redirect: "error", signal,
    });
    const body = (await response.json().catch(() => null)) as ApprovalBody | null;
    return { status: response.status, ok: response.ok, body };
  });
}

async function checkApprovalPage(fetchImpl: FetchLike, page: URL, signal: AbortSignal): Promise<Refusal | null> {
  try {
    return await withinApprovalDeadline(async (request) => {
      const response = await fetchImpl(page.href, {
        method: "GET", credentials: "omit", redirect: "manual", cache: "no-store", signal: request,
      });
      if (response.type === "opaqueredirect" || response.redirected ||
          (response.status >= 300 && response.status < 400) ||
          (response.url && new URL(response.url).origin !== page.origin)) {
        return refuse("signInWrongServer", page.host);
      }
      return response.ok ? null : refusalFor(response.status);
    }, signal);
  } catch {
    return refuse(signal.aborted ? "connectSuperseded" : "signInUnreachable");
  }
}

function refusalFor(status: number, code?: unknown): Refusal {
  if (code === "approval_denied") return refuse("signInDenied");
  if (code === "approval_expired") return refuse("signInExpired");
  if (status === 404 || status === 405) return refuse("signInNotOffered");
  if (status === 429) return refuse("signInRateLimited");
  if (status === 503) return refuse("signInUnreachable");
  return refuse("signInRefused");
}

/** The browser URL carries the request ID. The launch proof goes to its private cookie jar. */
export async function awaitBrowserApproval(
  deps: BrowserApprovalDeps, { origin, selfHosted = origin !== MANAGED_ORIGIN }: { origin: string; selfHosted?: boolean },
  signal: AbortSignal,
): Promise<ApprovalOutcome> {
  const refused = (reason: Refusal): ApprovalOutcome => ({ ok: false, reason });
  const startedAt = deps.now();
  let started: Awaited<ReturnType<typeof post>>;
  let verifier: string;
  try {
    const pkce = await deps.pkce();
    if (signal.aborted) return refused(refuse("connectSuperseded"));
    verifier = pkce.verifier;
    started = await post(deps.fetchImpl, `${origin}/auth/desktop-approval`, {
      challenge: pkce.challenge, kind: deps.kind, label: deps.label,
      ...(deps.calendarOnly ? { scope: "calendar" } : {}),
      ...(selfHosted ? { launchOrigin: origin } : {}),
    });
  } catch {
    return refused(refuse("signInUnreachable"));
  }
  if (!started.ok) return refused(refusalFor(started.status, started.body?.error?.code));
  const { approvalId, expiresIn, launch } = started.body ?? {};
  if (typeof approvalId !== "string" || !APPROVAL_ID.test(approvalId) ||
      typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) return refused(refuse("signInRefused"));

  if (signal.aborted) return refused(refuse("connectSuperseded"));
  const expiresAt = startedAt + expiresIn * 1000;
  if (deps.now() >= expiresAt) return refused(refuse("signInExpired"));

  const page = new URL("/approve", selfHosted ? origin : WEB_APP_URL);
  page.searchParams.set("request", approvalId);
  let launchProof: string | undefined;
  if (selfHosted) {
    if (typeof launch !== "string" || !/^\d{13}\.[0-9a-f]{32}$/.test(launch)) return refused(refuse("signInNotOffered"));
    launchProof = launch;
    const problem = await checkApprovalPage(deps.fetchImpl, page, signal);
    if (problem) return refused(problem);
  } else {
    page.searchParams.set("device", "phone");
  }

  if (signal.aborted) return refused(refuse("connectSuperseded"));
  if (deps.now() >= expiresAt) return refused(refuse("signInExpired"));
  let closed: ApprovalBrowserExit | null = null;
  const browserProblem = () => {
    if (closed === "wrong-server") return refuse("signInWrongServer", page.host);
    return closed === "failed" ? refuse("signInNoBrowser") : null;
  };
  try {
    const opened = await deps.open(page.href, signal, (result) => { closed = result; }, launchProof);
    if (!opened) return refused(refuse("signInNoBrowser"));
  } catch {
    return refused(refuse("signInNoBrowser"));
  }

  const claim = {
    approvalId, verifier, kind: deps.kind,
    ...(deps.previousSession === null ? {} : { previousSession: deps.previousSession }),
  };
  try {
    for (;;) {
      if (signal.aborted) return refused(refuse("connectSuperseded"));
      const problem = browserProblem();
      if (problem) return refused(problem);
      if (deps.now() >= expiresAt) return refused(refuse("signInExpired"));
      // Let a claim that already went out settle so its caller can revoke a late mint after Back.
      const browserReturned = closed === "cancelled";
      const response = await post(deps.fetchImpl, `${origin}/auth/desktop-approval/claim`, claim);
      if (response.status !== 202) {
        if (!response.ok) return refused(refusalFor(response.status, response.body?.error?.code));
        const { accessToken, refreshToken } = response.body?.tokens ?? {};
        if (typeof accessToken !== "string" || !accessToken || typeof refreshToken !== "string" || !refreshToken) {
          return refused(refuse("signInRefused"));
        }
        const issued = { accessToken, refreshToken };
        const browserRefusal = browserProblem();
        return browserRefusal
          ? { ok: false, reason: browserRefusal, issued }
          : { ok: true, approved: issued, ...(response.body?.scope === "calendar" ? { scope: "calendar" } : {}) };
      }
      // Android may resume the app only after its browser is closed. Claim once on return before giving up.
      if (browserReturned) return refused(refuse("signInCancelled"));
      if (closed !== null) continue;
      const retryAfter = Number(response.body?.retryAfterMs);
      const delay = Number.isFinite(retryAfter) ? Math.min(8_000, Math.max(500, retryAfter)) : 2_000;
      await deps.sleep(delay, signal);
    }
  } catch {
    return refused(refuse(signal.aborted ? "connectSuperseded" : "signInUnreachable"));
  } finally {
    deps.close();
  }
}
