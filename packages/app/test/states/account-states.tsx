/**
 * THE ACCOUNT GROUP'S STATES, BY ADDRESS: every state of `ACCOUNT_STATES` over the page's own fixtures, in the
 * language asked, each drawn as a shell draws its pane in Settings, in the body its state names. The factor's slot
 * holds the doors' dialog over a fake door, and the dialog's own state (`how`, `err`) is reached as a person reaches
 * it, by the presses `factorSteps` names. The account's states page draws one (`account-page.tsx`); its cases draw
 * them all; the comparison's subjects open the page at their keys.
 */
import type { ReactNode } from "react";
import { qrEncode, qrSvgPath } from "@ohmail/app-logic/doors/qr";
import type { AccountPaneId, AccountState, FactorSlot, QrSlot } from "../../src/account/contract.js";
import { ACCOUNT_STATES } from "../../src/account/index.js";
import { AccountPane } from "../../src/account/account/AccountPane.js";
import type { AccountDrawn } from "../../src/account/account/states.js";
import { DevicesPane } from "../../src/account/devices/DevicesPane.js";
import type { DevicesModel } from "../../src/account/devices/model.js";
import { InvitesPane } from "../../src/account/invites/InvitesPane.js";
import type { InvitesModel } from "../../src/account/invites/model.js";
import { SecurityPane } from "../../src/account/security/SecurityPane.js";
import type { SecurityModel } from "../../src/account/security/model.js";
import { StoragePane } from "../../src/account/storage/StoragePane.js";
import type { StorageModel } from "../../src/account/storage/model.js";
import { SubscriptionPane } from "../../src/account/subscription/SubscriptionPane.js";
import type { SubscriptionModel } from "../../src/account/subscription/model.js";
import { WayOutPane } from "../../src/account/way-out/WayOutPane.js";
import type { WayOutModel } from "../../src/account/way-out/model.js";
import { StepUpDialog, type StepUpDoor, type StepUpRefusal } from "../../src/doors/step-up/index.js";
import { fillOver, type Messages } from "../../src/text/index.js";
import { CODE, LAPTOP, PHONE, plain, THIS } from "../account/devices/fake-door.js";
import { FOR_RAHEL } from "../account/invites/fake-door.js";
import { READS } from "../account/subscription/fake-door.js";
import { FRAME_WORDS } from "../support/frame-words.js";
import accountDe from "../../messages/account.de.json" with { type: "json" };
import accountEn from "../../messages/account.en.json" with { type: "json" };
import ownAccountDe from "../../messages/account-account.de.json" with { type: "json" };
import ownAccountEn from "../../messages/account-account.en.json" with { type: "json" };
import ownDevicesDe from "../../messages/account-devices.de.json" with { type: "json" };
import ownDevicesEn from "../../messages/account-devices.en.json" with { type: "json" };
import ownInvitesDe from "../../messages/account-invites.de.json" with { type: "json" };
import ownInvitesEn from "../../messages/account-invites.en.json" with { type: "json" };
import ownSecurityDe from "../../messages/account-security.de.json" with { type: "json" };
import ownSecurityEn from "../../messages/account-security.en.json" with { type: "json" };
import ownStorageDe from "../../messages/account-storage.de.json" with { type: "json" };
import ownStorageEn from "../../messages/account-storage.en.json" with { type: "json" };
import ownSubscriptionDe from "../../messages/account-subscription.de.json" with { type: "json" };
import ownSubscriptionEn from "../../messages/account-subscription.en.json" with { type: "json" };
import doorsDe from "../../messages/doors.de.json" with { type: "json" };
import doorsEn from "../../messages/doors.en.json" with { type: "json" };
import menuDe from "../../messages/settings-menu.de.json" with { type: "json" };
import menuEn from "../../messages/settings-menu.en.json" with { type: "json" };
import settingsDe from "../../messages/settings.de.json" with { type: "json" };
import settingsEn from "../../messages/settings.en.json" with { type: "json" };

export type Lang = "en" | "de";

const EN: Messages = {
  ...FRAME_WORDS.en,
  ...settingsEn,
  ...menuEn,
  ...accountEn,
  ...doorsEn,
  ...ownDevicesEn,
  ...ownInvitesEn,
  ...ownSecurityEn,
  ...ownAccountEn,
  ...ownStorageEn,
  ...ownSubscriptionEn,
};
/** Every sentence the page draws, in both languages: German where the catalogue has it, English where it does not. */
export const ACCOUNT_WORDS: Readonly<Record<Lang, Messages>> = {
  en: EN,
  de: fillOver(EN, {
    ...FRAME_WORDS.de,
    ...settingsDe,
    ...menuDe,
    ...accountDe,
    ...doorsDe,
    ...ownDevicesDe,
    ...ownInvitesDe,
    ...ownSecurityDe,
    ...ownAccountDe,
    ...ownStorageDe,
    ...ownSubscriptionDe,
  }),
};

/** A plain sentence of the catalogue as written, in the language asked. */
export function say(lang: Lang, namespace: string, key: string): string {
  const at = (ACCOUNT_WORDS[lang][namespace] as Record<string, unknown> | undefined)?.[key];
  if (typeof at !== "string") throw new Error(`no sentence ${namespace}.${key} in ${lang}`);
  return at;
}

/* The page's own fixtures, made here: no source file holds a link, a key, a code or an amount. */
const PART = ["q8Vh", "Rw3L", "mTx7", "PaKd", "e2Ns"].join("");
const KEY = "JBSWY3DPEHPK3PXP";
const CODES = Array.from({ length: 10 }, (_, i) =>
  [String(58049 + i * 4271).padStart(5, "0"), String(86391 - i * 3517).padStart(5, "0")].join("-"),
);
export const ACCOUNT = "mila@lichtgrat.example";
/** What a person types into the dialog's field before its refusal: the reference's own two. */
export const TYPED = { code: "0".repeat(6), recovery: ["KQ4X", "82MD"].join("-") } as const;

/** Each pane's states over the page's fixtures, in the language asked: its refusals and its amounts said in it. */
function statesIn(lang: Lang) {
  const failed = say(lang, "session", "refusedOffline");
  const monthly = (amount: string) => say(lang, "settings", "storagePriceMonth").replace("{price}", amount);
  return {
    devices: ACCOUNT_STATES.devices({
      sessions: [THIS, PHONE, LAPTOP, plain(3), plain(2)],
      code: CODE,
      link: `https://api.ohmail.example/pair#${PART}`,
      failed,
    }),
    billing: ACCOUNT_STATES.billing(READS.card.value),
    storage: ACCOUNT_STATES.storage({
      plan: { solo: monthly("$9"), plus: monthly("$15"), pro: monthly("$29") },
      addon: monthly("$5"),
    }),
    invites: ACCOUNT_STATES.invites({
      invite: FOR_RAHEL,
      link: `https://mail.lichtgrat.example/join/invite#${PART}`,
      failed,
    }),
    security: ACCOUNT_STATES.security({ codes: CODES, key: KEY, failed }),
    account: ACCOUNT_STATES.account({ address: ACCOUNT, failed }),
    storageFacts: ACCOUNT_STATES.storageFacts(),
    wayOut: ACCOUNT_STATES.wayOut,
  };
}
/** The records the page draws. The password form alone is not one: the Account pane draws each of its states open. */
export type AccountRecord = keyof ReturnType<typeof statesIn>;

/** What a state is drawn with besides its model: the factor's dialog and the picture of a link, as a shell fills them. */
export interface Slots {
  readonly factor: FactorSlot;
  readonly qr: QrSlot;
}

/** One state of one pane: where it stands in the registry, which section of Settings draws it, and how. */
export interface Drawn {
  /** `<record>.<name>`, as the page's own word `pick` names it. */
  readonly id: string;
  readonly record: AccountRecord;
  readonly address: string | null;
  /** The section of Settings it stands in. */
  readonly section: AccountPaneId;
  draw(slots: Slots): ReactNode;
}

const nothing = (): void => {};

/** A state's pane, as a shell draws it in its body. */
function paneOf(record: AccountRecord, state: AccountState<unknown, string>, slots: Slots): ReactNode {
  const { factor, qr } = slots;
  switch (record) {
    case "devices":
      return <DevicesPane model={state.model as DevicesModel} factor={factor} qr={qr} />;
    case "invites":
      return <InvitesPane model={state.model as InvitesModel} factor={factor} qr={qr} />;
    case "security":
      return <SecurityPane model={state.model as SecurityModel} factor={factor} />;
    case "billing":
      return <SubscriptionPane model={state.model as SubscriptionModel} toStorage={nothing} />;
    case "storage":
    case "storageFacts":
      return (
        <StoragePane
          model={state.model as StorageModel}
          body={record === "storage" ? "pane" : "facts"}
          factor={factor}
        />
      );
    case "wayOut":
      return <WayOutPane model={state.model as WayOutModel} />;
    case "account": {
      const { account, password, formOpen } = state.model as AccountDrawn;
      return state.body === "signOutOnly" ? (
        <AccountPane body="signOutOnly" model={account} />
      ) : (
        <AccountPane body="pane" model={account} password={password} factor={factor} formOpen={formOpen} />
      );
    }
  }
}

/** The section of Settings a record's state stands in. */
const sectionOf = (record: AccountRecord, state: AccountState<unknown, string>): AccountPaneId =>
  record === "wayOut" ? (state.model as WayOutModel).section : record === "storageFacts" ? "storage" : record;

/** Every state of every pane, registered or not, in the language asked. */
export function accountStatesIn(lang: Lang): readonly Drawn[] {
  return Object.entries(statesIn(lang)).flatMap(([record, states]) =>
    Object.entries(states as Record<string, AccountState<unknown, string>>).map(([name, state]) => ({
      id: `${record}.${name}`,
      record: record as AccountRecord,
      address: state.address,
      section: sectionOf(record as AccountRecord, state),
      draw: (slots: Slots) => paneOf(record as AccountRecord, state, slots),
    })),
  );
}

/** An address's words in the registry's order: sorted, as every registered key is written. */
const keyOf = (words: URLSearchParams, leave: ReadonlySet<string>): string =>
  [...words.entries()]
    .filter(([word]) => !leave.has(word))
    .map(([word, value]) => `${word}=${value}`)
    .sort()
    .join("&");
/** The page's own words, which no registered key carries: the language, the text size and a state by name. */
const OWN = new Set(["lang", "size", "pick"]);
/** The looks: the same state in another window or scheme is the same state. */
const LOOKS = new Set(["device", "face", "scheme"]);

/**
 * The state an address names: by name (`pick`), by its registered key, or, in another look than the registry's,
 * by the key without its look's words (the lane's own pictures of a rest state).
 */
export function drawnAt(words: URLSearchParams, lang: Lang): Drawn | null {
  const all = accountStatesIn(lang);
  const pick = words.get("pick");
  if (pick !== null) return all.find((state) => state.id === pick) ?? null;
  const exact = keyOf(words, OWN);
  const plainKey = keyOf(words, new Set([...OWN, ...LOOKS]));
  return (
    all.find((state) => state.address === exact) ?? all.find((state) => state.address === plainKey) ?? null
  );
}

/** Every registered key the page draws, once: the Account pane's draws the password form's. */
export const ACCOUNT_KEYS: readonly string[] = accountStatesIn("en").flatMap((state) =>
  state.address === null ? [] : [state.address],
);

/** How the fake door refuses a verify, by the address's `err`: the dialog's own words, or the shell's sentence. */
function refusalOf(err: string, lang: Lang): StepUpRefusal | null {
  const shell = (key: string): StepUpRefusal => ({ word: "said", said: say(lang, "session", key) });
  switch (err) {
    case "code":
      return { word: "bad_code" };
    case "passkey":
      return { word: "bad_passkey" };
    case "recovery":
      return { word: "bad_recovery" };
    case "locked":
      return { word: "locked", minutes: 15 };
    case "slowed":
      return { word: "slowed" };
    case "refused":
      return { word: "refused" };
    case "lost":
      return shell("refusedOwnerAbsent");
    case "pendingout":
      return shell("refusedOwnerSignedOut");
    case "mismatch":
      return shell("refusedOwnerMismatch");
    case "unchecked":
      return shell("refusedSessionUnchecked");
    default:
      return null;
  }
}

/** The dialog's door for an address: all three factors enrolled; a verify refused by `err`, else never answered. */
export function stepUpDoorFor(words: URLSearchParams, lang: Lang): StepUpDoor {
  const err = words.get("err");
  const refusal = err === null ? null : refusalOf(err, lang);
  return {
    factors: () => Promise.resolve({ ok: true, factors: { passkey: true, code: true, recovery: true } }),
    verify: () => (refusal === null ? new Promise(() => {}) : Promise.resolve({ ok: false, refusal })),
  };
}

/** A person's step in the dialog: a press on the button its catalogue key names, or a value typed into the blank. */
export type FactorStep =
  { readonly press: string } | { readonly type: string; readonly into: "codeLabel" | "recoveryLabel" };

/** The presses that bring the dialog from its first way (the passkey) to the way and the refusal an address names. */
export function factorSteps(words: URLSearchParams): readonly FactorStep[] {
  const how = words.get("how");
  const steps: FactorStep[] = [];
  if (how === "code") steps.push({ press: "useCode" });
  if (how === "recovery") steps.push({ press: "useRecovery" });
  if (words.get("err") === null) return steps;
  if (how === "code") steps.push({ type: TYPED.code, into: "codeLabel" }, { press: "verify" });
  else if (how === "recovery")
    steps.push({ type: TYPED.recovery, into: "recoveryLabel" }, { press: "verify" });
  else steps.push({ press: "passkey" });
  return steps;
}

/** The slots as the web fills them: the doors' dialog over the address's door, and a link's picture to scan. */
export function slotsFor(words: URLSearchParams, lang: Lang): Slots {
  const door = stepUpDoorFor(words, lang);
  return {
    factor: (ask) => <StepUpDialog door={door} {...ask} />,
    qr: (value, label) => <Qr value={value} label={label} />,
  };
}

/** The picture of a link to scan, drawn as the web's QR part draws it: dark on white, its quiet zone kept. */
function Qr({ value, label }: { readonly value: string; readonly label: string }) {
  const matrix = qrEncode(value);
  const quiet = 4;
  const size = matrix.length + 2 * quiet;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`${-quiet} ${-quiet} ${size} ${size}`}
      shapeRendering="crispEdges"
    >
      <rect x={-quiet} y={-quiet} width={size} height={size} fill="#fff" />
      <path d={qrSvgPath(matrix)} fill="#000" />
    </svg>
  );
}
