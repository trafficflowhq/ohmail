import { useMemo, useState } from "react";
import type {
  AccountDoor, Answer, DeviceKind, DeviceSession, DevicesDoor, FactorSlot, InvitesDoor, PasswordDoor, SecurityDoor,
} from "@ohmail/app/account";
import { qrEncode, qrSvgPath } from "@ohmail/app-logic/doors/qr";
import { StepUpDialog, type StepUpDoor, type StepUpRefusal } from "@ohmail/app/doors/step-up";
import { browserClipboard } from "@ohmail/app/host/browser";
import type { MailPaneParts } from "@ohmail/app/mail";
import { NONE } from "@ohmail/app/host";
import { useLocale, useText } from "@ohmail/app/text";
import { Button } from "@ohmail/ui/base";
import { SettingNote } from "@ohmail/ui/mail";
import type { BrowserAccountPane, PairGrant, ShellConfig } from "../../src/shell/bridge-kinds";
import { AccountRefusal, accountFetch, nativeAccountFetch } from "./account-fetch";
import { hasHostedAccount, PhoneNoAccount } from "./account-data-panes";
import type { Bridge } from "./bridge";
import { phoneDevicesPane } from "./settings-panes";

type HostedScope = "full" | "calendar";

type Session = {
  scope: HostedScope | "enrollment";
  user?: {
    accountId: string;
    email: string;
    displayName?: string | null;
    twofaEnrolled?: { webauthn?: boolean; totp?: boolean; recoveryCodes?: boolean };
  };
};
type PairRow = { id: string; grant: PairGrant; label: string; createdAt: string; expiresAt: string; status: string };
type OneUseLink = { id: string; label: string; expiresAt: string; link: string };
type DeviceRow = {
  id: string; kind: string; label: string; current: boolean; named?: boolean; createdAt: string; lastSeenAt: string;
};

function deviceKind(kind: string): DeviceKind {
  switch (kind) {
    case "web": return "web";
    case "macos":
    case "desktop-macos": return "mac";
    case "desktop-linux": return "linux";
    case "desktop-windows": return "windows";
    case "mobile-ios": return "ios";
    case "mobile-android": return "android";
    default: return "other";
  }
}

function deviceOf(row: DeviceRow, day: (iso: string) => string): DeviceSession {
  const kind = deviceKind(row.kind);
  const builtIn = (kind === "mac" && row.label === "ohmail for Mac") ||
    (kind === "linux" && row.label === "ohmail for Linux") ||
    (kind === "windows" && row.label === "ohmail for Windows");
  return {
    id: row.id, kind, current: row.current, plainWeb: row.named === false,
    name: builtIn ? { by: "ohmail" } : row.label ? { by: "person", said: row.label } : { by: "nobody" },
    added: day(row.createdAt), seen: day(row.lastSeenAt),
  };
}

function minutesOf(error: AccountRefusal) {
  const delay = (error.details as { retryAfter?: unknown } | undefined)?.retryAfter;
  return typeof delay === "number" && delay > 0 ? Math.max(1, Math.ceil(delay / 60)) : 15;
}

function refused(error: unknown, said: string): Exclude<Answer<never>, { ok: true }> {
  if (error instanceof AccountRefusal) {
    if (error.status === 403 && error.code === "step_up_required") return { ok: false, word: "factor" };
    if (error.status === 401 || error.status === 403) return { ok: false, word: "sign_in" };
  }
  return { ok: false, word: "said", said };
}

async function tried<T>(call: () => Promise<T>, said: string): Promise<Answer<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    return refused(error, said);
  }
}

function QrCode({ value, label }: { value: string; label: string }) {
  const { size, path } = useMemo(() => {
    const matrix = qrEncode(value);
    return { size: matrix.length + 8, path: qrSvgPath(matrix) };
  }, [value]);
  return (
    <svg role="img" aria-label={label} width="100%" height="100%" viewBox={`-4 -4 ${size} ${size}`} shapeRendering="crispEdges">
      <rect x="-4" y="-4" width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

const qr = (value: string, label: string) => <QrCode value={value} label={label} />;
const unavailableInvites = () => <PhoneNoAccount label="invitesEmpty" />;

function BrowserFactor({ open }: { open: () => Promise<unknown> }) {
  const t = useText("phoneSettings");
  const refusal = useText("viewError");
  const [failed, setFailed] = useState(false);
  return <>
    <SettingNote>{t("factorBrowser")}</SettingNote>
    <Button kind="two" size="s" onPress={() => {
      setFailed(false);
      void open().catch(() => setFailed(true));
    }}>{t("openBrowser")}</Button>
    {failed ? <SettingNote warn>{refusal("tryAgain")}</SettingNote> : null}
  </>;
}

async function readHostedUser(request: ReturnType<typeof accountFetch>, accountId: string, expected: HostedScope) {
  const { scope: access, user } = await request<Session>("/auth/session");
  if (access !== expected || user?.accountId !== accountId) throw new AccountRefusal(401);
  return user;
}

export function phoneSettingsFactor(
  bridge: Bridge, config: Pick<ShellConfig, "scope" | "accountId">, pane: BrowserAccountPane,
  expected: HostedScope = "full",
): FactorSlot {
  const { scope } = config;
  const request = accountFetch(bridge, scope);
  const readUser = () => readHostedUser(request, config.accountId, expected);
  const verification: StepUpDoor = {
    async factors() {
      try {
        const { twofaEnrolled } = await readUser();
        return { ok: true, factors: {
          passkey: false, code: twofaEnrolled?.totp === true, recovery: twofaEnrolled?.recoveryCodes === true,
        } };
      } catch {
        return { ok: false, refusal: { word: "refused" } };
      }
    },
    async verify(factor, code) {
      if (factor === "passkey") return { ok: false, refusal: { word: "bad_passkey" } };
      try {
        await request(factor === "code" ? "/auth/step-up/totp" : "/auth/step-up/recovery-code", "POST", { code: code.trim() });
        return { ok: true };
      } catch (error) {
        let refusal: StepUpRefusal = { word: "refused" };
        if (error instanceof AccountRefusal) {
          if (error.status === 423 || error.code === "account_locked") refusal = { word: "locked", minutes: minutesOf(error) };
          else if (error.code === "sign_in_slowed") refusal = { word: "slowed" };
          else if (error.status === 401) refusal = { word: factor === "code" ? "bad_code" : "bad_recovery" };
        }
        return { ok: false, refusal };
      }
    },
  };
  return (ask) => (
    <StepUpDialog {...ask} door={verification} noFactor={
      <BrowserFactor open={async () => {
        await bridge.request("phone.account", { scope, do: "settingsPage", pane });
        ask.onCancel();
      }} />
    } />
  );
}

export function hostedSettingsPanes(
  bridge: Bridge, config: Pick<ShellConfig, "scope" | "setting" | "accountId" | "serverName">,
  expected: HostedScope = "full",
): Pick<MailPaneParts, "account" | "devices" | "invites" | "security"> {
  const { scope, setting } = config;
  const calendarOnly = expected === "calendar";
  const Servers = phoneDevicesPane(bridge);
  if (!hasHostedAccount(setting)) return {
    account: NONE,
    devices: Servers,
    invites: NONE,
    security: NONE,
  };

  const request = accountFetch(bridge, scope);
  const native = nativeAccountFetch(bridge, scope);
  const copy = (text: string) => browserClipboard(window)(text);
  const openServers = () => bridge.request("act", { act: "openServers" });
  const signOut = () => bridge.request("act", { act: "signOut" });
  const readUser = () => readHostedUser(request, config.accountId, expected);

  async function pairs(grant: PairGrant) {
    const { items } = await native<{ items: PairRow[] }>({ do: "pairs" });
    return items.filter((item) => item.grant === grant && item.status === "live");
  }
  const mint = (grant: PairGrant, name: string) => native<OneUseLink>({ do: "mint", grant, name });
  async function revoke(grant: PairGrant, pairId: string) {
    await native({ do: "revoke", grant, pairId });
    return null;
  }

  function useDevicesDoor(): DevicesDoor {
    const locale = useLocale();
    const words = useText("devices");
    const ref = useText("viewError");
    return useMemo(() => {
      const day = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
      const clock = new Intl.DateTimeFormat(locale, { timeStyle: "short" });
      const formatDay = (iso: string) => Number.isFinite(Date.parse(iso)) ? day.format(new Date(iso)) : "";
      return {
        async read() {
          try {
            const [{ items }, codes] = await Promise.all([
              request<{ items: DeviceRow[] }>("/devices"),
              calendarOnly ? [] : pairs("device-pair"),
            ]);
            return { ok: true, value: {
              sessions: items.map((row) => deviceOf(row, formatDay)),
              codes: codes.map((row) => ({ id: row.id, name: row.label || null, until: clock.format(new Date(row.expiresAt)) })),
            } };
          } catch {
            return { ok: false, word: "said", said: words("loadFailed") };
          }
        },
        groupsWebSessions: async () => true,
        add: (name) => tried(async () => {
          const made = await mint("device-pair", name);
          return { id: made.id, link: made.link, name: made.label };
        }, ref("tryAgain")),
        revokeCode: (id) => tried(() => revoke("device-pair", id), ref("tryAgain")),
        remove: (id) => tried(async () => {
          await request(`/devices/${encodeURIComponent(id)}`, "DELETE");
          return null;
        }, ref("tryAgain")),
        signOutWeb: () => tried(async () => ({ ended: (await request<{ revoked: number }>("/devices/revoke-web-sessions", "POST", {})).revoked }), ref("tryAgain")),
        copy,
      };
    }, [locale, words, ref]);
  }

  function useInvitesDoor(): InvitesDoor {
    const locale = useLocale();
    const ref = useText("viewError");
    return useMemo(() => {
      const format = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
      const day = (iso: string) => format.format(new Date(iso));
      return {
        read: () => tried(async () => (await pairs("invite")).map((row) => ({
          id: row.id, name: row.label || null, made: day(row.createdAt), expires: day(row.expiresAt),
        })), ref("loadFailed")),
        make: (name) => tried(async () => {
          const made = await mint("invite", name);
          return { id: made.id, name: made.label, expires: day(made.expiresAt), link: made.link };
        }, ref("tryAgain")),
        revoke: (id) => tried(() => revoke("invite", id), ref("tryAgain")),
        copy,
      };
    }, [locale, ref]);
  }

  function useSecurityDoor(): SecurityDoor {
    const ref = useText("viewError");
    return useMemo(() => ({
      read: async () => {
        try {
          const { twofaEnrolled } = await readUser();
          if (!twofaEnrolled) throw new Error("Missing enrolled factors");
          return { ok: true, value: {
            passkey: twofaEnrolled.webauthn === true,
            authenticator: twofaEnrolled.totp === true,
            recoveryCodes: twofaEnrolled.recoveryCodes === true,
          } };
        } catch {
          return { ok: false, word: "said", said: ref("loadFailed") };
        }
      },
      newCodes: () => tried(async () => (await request<{ codes: string[] }>("/auth/2fa/recovery-codes", "POST", {})).codes, ref("tryAgain")),
      startAuthenticator: () => tried(async () => {
        const { secret, otpauthUrl } = await request<{ secret: string; otpauthUrl?: string }>("/auth/2fa/totp/enroll", "POST", {});
        return { key: secret, uri: otpauthUrl?.startsWith("otpauth://totp/") && otpauthUrl.length <= 350 ? otpauthUrl : undefined };
      }, ref("tryAgain")),
      activate: (code) => tried(async () => {
        await native({ do: "activate", code });
        return null;
      }, ref("tryAgain")),
      removeAuthenticator: () => tried(async () => {
        await request("/auth/2fa/totp", "DELETE");
        return null;
      }, ref("tryAgain")),
    }), [ref]);
  }

  function useAccountDoor(): AccountDoor {
    const ref = useText("viewError");
    return useMemo(() => ({
      async who() {
        try {
          const user = await readUser();
          if (typeof user.email !== "string") throw new Error("Missing account address");
          return { ok: true, value: { address: user.email, displayName: user.displayName ?? undefined } };
        } catch (error) {
          return error instanceof AccountRefusal && (error.status === 401 || error.status === 403)
            ? { ok: false, word: "signed_out" }
            : { ok: false, word: "said", said: ref("loadFailed") };
        }
      },
      signOut: () => signOut().then(() => "opened", () => "unverified"),
      toErase: () => { void bridge.request("phone.account", { scope, do: "deletePage" }).catch(() => {}); },
      toSignIn: () => { void openServers().catch(() => {}); },
    }), [ref]);
  }

  function usePasswordDoor(): PasswordDoor {
    const ref = useText("viewError");
    return useMemo(() => ({
      async change(current, next) {
        try {
          const { revoked } = await request<{ revoked: number }>("/auth/password", "POST", { currentPassword: current, newPassword: next });
          return { ok: true, value: { ended: revoked } };
        } catch (error) {
          if (error instanceof AccountRefusal) {
            if (error.status === 401 && error.code === "credential_refused") return { ok: false, word: "wrong_current" };
            if (error.status === 423) return { ok: false, word: "locked", minutes: minutesOf(error) };
            if (error.code === "sign_in_slowed") return { ok: false, word: "slowed" };
            if (error.status === 409) return { ok: false, word: "conflict" };
          }
          return refused(error, ref("tryAgain"));
        }
      },
    }), [ref]);
  }


  const devices = {
    useDoor: useDevicesDoor, factor: phoneSettingsFactor(bridge, config, "devices", expected),
    End: phoneDevicesPane(bridge, true),
  };
  if (calendarOnly) return {
    account: { useDoor: useAccountDoor, password: NONE, identityOnly: true },
    devices,
    invites: NONE,
    security: { useDoor: useSecurityDoor },
  };
  return {
    account: { useDoor: useAccountDoor, password: { useDoor: usePasswordDoor, factor: phoneSettingsFactor(bridge, config, "account") } },
    devices: { ...devices, qr },
    invites: setting === "selfHosted" ? { useDoor: useInvitesDoor, factor: phoneSettingsFactor(bridge, config, "invites"), qr } : unavailableInvites,
    security: { useDoor: useSecurityDoor, factor: phoneSettingsFactor(bridge, config, "security"), qr },
  };
}
