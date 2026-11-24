import { useEffect, useMemo, useState } from "react";
import { DRAFT_REPLY_COST_CREDITS } from "@ohmail/app-logic/writing/draft-reply";
import { useConsent } from "@ohmail/app-logic/consent/consent-row";
import { TrialProgress } from "@ohmail/app/account/subscription";
import { StorageExplanation, StorageInfo } from "@ohmail/app/account/storage";
import { NONE, type AwayWire } from "@ohmail/app/host";
import type { MailPaneParts } from "@ohmail/app/mail";
import { AiPane, aiCreditsOf, useAiDoor, type AiDoor } from "@ohmail/app/settings/ai";
import { PhoneAwaySettings } from "@ohmail/app/settings/away";
import { useLocale, useText } from "@ohmail/app/text";
import { design, Empty, Tag } from "@ohmail/ui/base";
import { formatFileSize } from "@ohmail/ui/file-size";
import { FigureLine, FigureTable, ScaleBar, SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import type { ShellConfig } from "../../src/shell/bridge-kinds";
import { accountFetch } from "./account-fetch";
import type { Bridge } from "./bridge";

type Request = ReturnType<typeof accountFetch>;
type AccountData = {
  metered: boolean;
  access?: "open" | "refused";
  aiCredits?: unknown;
  trialProgress?: { day: number; total: number };
  lifecycle?: { state: keyof typeof STATE; trialEndsAt?: string | null };
  storage?: StorageUsage;
};

type StorageUsage = {
  usedBytes: number;
  limitBytes: number;
  offer?: { current?: { plan?: "solo" | "plus" | "pro" | null } };
  planLimitBytes?: number;
  limitReason?: "trial" | "held" | "plan";
  mailboxes?: Array<{ id: string; usedBytes: number; letters: number; expectedBytes: number }>;
};
type StorageMailbox = { id: string; address: string; displayName?: string | null };
const HUES = Object.values(design.tagHues);

const STATE = {
  active: "active", trialing: "trial", grace: "overdue", past_due: "overdue", closed: "closed", erased: "closed",
} as const;
const PLAN = { solo: "Solo", plus: "Plus", pro: "Pro" } as const;

function useRead<T>(read?: (signal: AbortSignal) => Promise<T>) {
  const [answer, setAnswer] = useState<T | "failed" | null>(null);
  useEffect(() => {
    if (!read) return;
    const abort = new AbortController();
    void read(abort.signal).then(
      (value) => { if (!abort.signal.aborted) setAnswer(value); },
      () => { if (!abort.signal.aborted) setAnswer("failed"); },
    );
    return () => abort.abort();
  }, [read]);
  return answer;
}

export function PhoneNoAccount({ label = "noAccount" }: { label?: string }) {
  const t = useText("phoneSettings");
  return <SettingsSheet><Empty label={t(label)} /></SettingsSheet>;
}

function PhoneAi({ request, readAccess, managed }: {
  request: Request;
  readAccess: (signal: AbortSignal) => Promise<AccountData>;
  managed: boolean;
}) {
  const refusal = useText("viewError");
  const aiRefusal = useText("aiRefusal");
  const { draftReplies, setDraftReplies } = useConsent();
  const access = useRead(readAccess);
  const door = useMemo<AiDoor>(() => ({
    read: async () => (await request<{ aiEnabled: boolean }>("/account/ai")).aiEnabled,
    set: async (next) => (await request<{ aiEnabled: boolean }>("/account/ai", "PATCH", { aiEnabled: next })).aiEnabled,
    model: async () => managed ? null : (await request<{ features?: { ai?: boolean } }>("/hello")).features?.ai ?? null,
    messageFor: () => refusal("tryAgain"),
  }), [request, managed, refusal]);
  const { model, saveDraft } = useAiDoor(door);

  const credits = access && access !== "failed" && access.metered && access.access === "open"
    ? aiCreditsOf(access.aiCredits, access.lifecycle) : null;
  return <AiPane
    phone
    model={model}
    noModelSaid={aiRefusal("noModel")}
    cloudModel={managed && model.enabled === true && model.problem === null}
    credits={credits && { ...credits, draftCost: credits.draftCost ?? DRAFT_REPLY_COST_CREDITS }}
    draftReplies={draftReplies !== null && setDraftReplies
      ? { enabled: draftReplies, toggle: (next) => saveDraft(() => setDraftReplies(next)) } : undefined}
  />;
}

function Usage({ usage, roster }: { usage: StorageUsage; roster: StorageMailbox[] }) {
  const t = useText("settings");
  const locale = useLocale();
  const size = (bytes: number) => formatFileSize(bytes, locale);
  const number = new Intl.NumberFormat(locale);
  const shares = usage.mailboxes ?? [];
  const rows = shares.flatMap((row, index) => {
    const mailbox = roster.find(({ id }) => id === row.id);
    if (!mailbox || ![row.usedBytes, row.letters, row.expectedBytes].every((n) => Number.isSafeInteger(n) && n >= 0)) return [];
    return [{
      id: row.id, name: mailbox.displayName?.trim() || mailbox.address, hue: HUES[index % HUES.length],
      figures: [number.format(row.letters), size(row.usedBytes), size(row.expectedBytes)],
      bytes: row.usedBytes, letters: row.letters, expected: row.expectedBytes,
    }];
  });
  const used = size(usage.usedBytes);
  const limit = size(usage.limitBytes);
  const scale = Math.max(usage.usedBytes, usage.limitBytes);
  const counted = rows.reduce((sum, row) => sum + row.bytes, 0);
  const next = rows.reduce((totals, row) => ({ letters: totals.letters + row.letters, expected: totals.expected + row.expected }), { letters: 0, expected: 0 });
  const total = rows.length > 0 && rows.length === shares.length && counted === usage.usedBytes;
  const share = (bytes: number) => 100 * bytes / scale;
  const parts = rows.map(({ bytes, hue }) => ({ share: share(bytes), hue }));
  return <>
  <SettingsSheet>
    <FigureLine figure={used} info={<StorageInfo />} of={t(usage.limitReason === "trial" ? "storageFigureTrial" : "storageFigureOf", { limit })} />
    <ScaleBar label={t("storageOf", { used, limit })}
      parts={[...parts, { share: share(Math.max(0, usage.usedBytes - counted)) }]}
      marks={[{ at: share(usage.limitBytes) }]}
      scale={[{ label: t("storageScaleStart") }, { label: size(scale) }]}
    />
    {rows.length ? <FigureTable label={t("mailboxes")}
      columns={["storageColMailbox", "storageColLetters", "storageColKept", "storageColExpected"].map((key) => t(key))}
      rows={rows}
      sum={total ? { name: t("storageTotal"), figures: [number.format(next.letters), used, size(next.expected)] } : undefined}
    /> : null}
  </SettingsSheet>
  <StorageExplanation t={t} plan={{ kind: "keeps", plan: usage.offer?.current?.plan ?? null,
    limit: size(usage.planLimitBytes ?? usage.limitBytes) }} />
  </>;
}

function AccountUsage({ read, readRoster }: {
  read: (signal: AbortSignal) => Promise<AccountData>;
  readRoster?: (signal: AbortSignal) => Promise<StorageMailbox[]>;
}) {
  const t = useText("phoneSettings");
  const sub = useText("accountSubscription");
  const load = useText("viewError");
  const locale = useLocale();
  const access = useRead(read);
  const roster = useRead(readRoster);
  if (access === "failed" || access === null) {
    return <SettingsSheet><SettingNote warn={access === "failed"} busy={access === null}>
      {access === "failed" ? load("loadFailed") : t("accountLoading")}
    </SettingNote></SettingsSheet>;
  }
  const usage = access.storage;
  if (readRoster) {
    if (!usage || !Number.isSafeInteger(usage.usedBytes) || usage.usedBytes < 0 ||
      !Number.isSafeInteger(usage.limitBytes) || usage.limitBytes <= 0) {
      return <PhoneNoAccount label="storageEmpty" />;
    }
    return <Usage usage={usage} roster={Array.isArray(roster) ? roster : []} />;
  }
  if (!access.metered) return <PhoneNoAccount label="subscriptionEmpty" />;
  const plan = usage?.offer?.current?.plan;
  const status = access.lifecycle ? STATE[access.lifecycle.state] : undefined;
  const trial = access.lifecycle?.state === "trialing";
  const trialEnd = trial ? access.lifecycle?.trialEndsAt : null;
  const progress = trial && access.trialProgress;
  const hasProgress = progress && Number.isSafeInteger(progress.day) && Number.isSafeInteger(progress.total) &&
    progress.day >= 1 && progress.day <= progress.total;
  return <SettingsSheet
    title={plan && PLAN[plan] ? PLAN[plan] : sub(plan === null ? "noPlan" : "notRead")}
    aside={<Tag>{sub(status ?? "notRead")}</Tag>}
  >
    {hasProgress ? <TrialProgress progress={progress} phone /> : null}
    {trialEnd && Number.isFinite(Date.parse(trialEnd))
      ? <SettingLine label={sub("trialEnds")} value={new Intl.DateTimeFormat(locale === "en" ? "en-GB" : locale, { weekday: "short", day: "numeric", month: "short" }).format(new Date(trialEnd)).replace(",", "")} />
      : null}
  </SettingsSheet>;
}

export const hasHostedAccount = (setting: ShellConfig["setting"]) => setting === "managed" || setting === "selfHosted";

export function phoneAwayWire(request: Request): AwayWire {
  return {
    state: () => request("/away-responder"),
    save: (draft) => request("/away-responder", "PUT", draft),
  };
}

function OrganizerNote({ bridge }: { bridge: Bridge }) {
  const [notes, setNotes] = useState<readonly string[]>([]);
  useEffect(() => {
    let current: AbortController | undefined;
    const read = () => {
      current?.abort();
      const { signal } = current = new AbortController();
      void bridge.request("phone.organize", { do: "read" }, { signal }).then(({ rows }) => {
        if (!signal.aborted) setNotes(rows.filter((row) => row.tag === "reader").flatMap((row) => row.notes));
      }, () => { if (!signal.aborted) setNotes([]); });
    };
    read();
    const off = bridge.on((event) => {
      if (event.type === "organizerChanged" || (event.type === "wake" && event.why === "foreground")) read();
    });
    return () => { off(); current?.abort(); };
  }, [bridge]);
  return notes.length ? <SettingsSheet>{notes.map((note) => <SettingNote key={note}>{note}</SettingNote>)}</SettingsSheet> : null;
}

export function accountDataPanes(
  bridge: Bridge, { scope, setting }: Pick<ShellConfig, "scope" | "setting">,
): Pick<MailPaneParts, "ai" | "away" | "billing" | "storage"> {
  const request = accountFetch(bridge, scope);
  const hosted = hasHostedAccount(setting);
  const read = (signal: AbortSignal) => request<AccountData>("/account/access", "GET", undefined, signal);
  const roster = async (signal: AbortSignal) =>
    (await request<{ items: StorageMailbox[] }>("/mailboxes", "GET", undefined, signal)).items;
  return {
    ai: hosted ? () => <PhoneAi request={request} readAccess={read} managed={setting === "managed"} /> : NONE,
    away: () => <><PhoneAwaySettings />{setting === "standalone" ? <OrganizerNote bridge={bridge} /> : null}</>,
    billing: hosted ? () => <AccountUsage read={read} /> : NONE,
    storage: hosted ? () => <AccountUsage read={read} readRoster={roster} /> : NONE,
  };
}
