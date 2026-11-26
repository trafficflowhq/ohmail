import { type KeyboardEvent, type ReactNode } from "react";
import { Button, Dialog, Field, type IconName } from "@ohmail/ui/base";
import {
  ActionPanel,
  SettingLine,
  SettingNote,
  SettingsSheet,
  type SettingsSheetProps,
} from "@ohmail/ui/mail";
import type { PaneSheet } from "../../settings/contract.js";
import { useLocale, useText, type Text } from "../../text/index.js";
import { ACCOUNT_REFUSALS, type FactorSlot, type QrSlot } from "../contract.js";
import type { DeviceKind, DeviceSession, DevicesModel } from "./model.js";
import "./placement.css";

export interface DevicesPaneProps {
  readonly phone?: boolean;
  readonly model: DevicesModel;
  /** The factor's dialog, filled by the shell: drawn while a verb is parked behind it. */
  readonly factor: FactorSlot;
  /** The picture of the pairing link to scan, filled by the shell. */
  readonly qr?: QrSlot;
  readonly sheet?: PaneSheet;
}

type Wants = NonNullable<SettingsSheetProps["wants"]>;

/** A kind of device, by the word that says it and the sign that draws it. A kind this build does not know is a device. */
const KIND: Readonly<Record<DeviceKind, { readonly word: string; readonly sign: IconName }>> = {
  web: { word: "kindWeb", sign: "desktop" },
  mac: { word: "kindMac", sign: "desktop" },
  linux: { word: "kindLinux", sign: "desktop" },
  windows: { word: "kindWindows", sign: "desktop" },
  android: { word: "kindAndroid", sign: "phone" },
  ios: { word: "kindIos", sign: "phone" },
  other: { word: "kindOther", sign: "key" },
};

export const deviceKindText = (kind: DeviceKind, t: Text): string => t(KIND[kind].word);

/** A device's name: its owner's word; ohmail's own, said in the reader's language; or its kind where nobody named it. */
function nameOf(device: DeviceSession, t: Text): string {
  const kind = t(KIND[device.kind].word);
  if (device.name.by === "person") return device.name.said;
  return device.name.by === "ohmail" ? t("mintedName", { kind }) : kind;
}

/**
 * Settings › Devices: a new device paired by a link that is shown once, the codes not used yet, and what is signed
 * in, each with its way back. It holds no state and reaches nothing: it draws its model, and its verbs are the
 * model's. A removal is asked about before it is sent.
 */
export function DevicesPane({ model, factor, qr, sheet, phone }: DevicesPaneProps) {
  const t = useText("devices");
  const locale = useLocale();
  const body = (
    <>
      {qr ? (
        <>
          {model.made === null ? <NewDevice model={model} /> : <MadeLink model={model} qr={qr} />}
          <CodesNotUsed model={model} />
        </>
      ) : model.problem || model.nothingRan || model.told ? (
        <FirstSheet model={model} />
      ) : null}
      <SignedIn model={model} phone={phone} />
      <Question model={model} />
      {model.ask ? factor(model.ask) : null}
    </>
  );
  const foot = qr ? (
    <ActionPanel
      label={t("title")}
      items={[
        model.made === null
          ? {
              id: "add",
              icon: "plus",
              label: model.working?.kind === "add" ? t("working") : t("addAction"),
              kind: "ink",
              disabled: model.working !== null,
              onPress: model.add,
            }
          : { id: "done", icon: "check", label: t("mintedDone"), kind: "ink", onPress: model.done },
      ]}
    />
  ) : undefined;
  const count =
    model.list.at === "read"
      ? new Intl.NumberFormat(locale).format(model.list.devices.length + (model.list.webGroup?.count ?? 0))
      : undefined;
  return sheet ? (
    sheet(body, foot, count)
  ) : (
    <>
      {body}
      {foot}
    </>
  );
}

/**
 * The pane's first sheet. What the last read, verb or copy left to say stands on it: why it did not go through, by
 * the sentence it has today, or that nothing ran; and under its lines what the last verb did.
 */
function FirstSheet(p: {
  readonly model: DevicesModel;
  readonly title?: string;
  readonly aside?: string;
  readonly children?: ReactNode;
}) {
  const t = useText("devices");
  const own = useText("accountDevices");
  const { problem, nothingRan } = p.model;
  const nothingRanSaid = t("stepUpCancelledNothingRan");
  let wants: Wants | undefined;
  if (problem === null) wants = nothingRan ? { word: own("cancelled"), line: nothingRanSaid } : undefined;
  else if (problem.with === "copy") wants = { word: own("notCopied"), line: t("copyPairingFailed") };
  else {
    const word = own(problem.with === "read" ? "notRead" : "notDone");
    const line = problem.why.word === "said" ? problem.why.said : t(ACCOUNT_REFUSALS.devices.sign_in.key);
    wants = line === "" ? { word } : { word, line };
  }
  return (
    <SettingsSheet title={p.title} aside={p.aside} hot={p.title !== undefined} wants={wants}>
      {problem !== null && nothingRan ? <SettingNote>{nothingRanSaid}</SettingNote> : null}
      {p.children}
      <Told told={p.model.told} />
    </SettingsSheet>
  );
}

/** What the last verb did, where a screen reader hears it arrive. */
function Told({ told }: { readonly told: DevicesModel["told"] }) {
  const t = useText("devices");
  let said: string | null = null;
  if (told?.kind === "signedOutWeb") said = t("webGroupDone", { count: told.ended });
  else if (told !== null) said = t(told.kind);
  return <div role="status">{said === null ? null : <SettingNote>{said}</SettingNote>}</div>;
}

/** Whose device it is, or nobody's, and the verb that makes its link. Enter in the name presses it. */
function NewDevice({ model }: { readonly model: DevicesModel }) {
  const t = useText("devices");
  const off = model.working !== null;
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (!off) model.add();
  };
  return (
    <FirstSheet model={model}>
      <div className="account-device-name" onKeyDown={onKey}>
        <Field
          label={t("whoseDevice")}
          placeholder={t("namePlaceholder")}
          value={model.name}
          onChange={model.type}
          maxLength={100}
        />
      </div>
    </FirstSheet>
  );
}

/**
 * The pairing link, shown once: its picture to scan and, for a device with no camera, the link itself to type,
 * with the name it was made for. Copy says "copied" only through the model; Done takes it down.
 */
function MadeLink({ model, qr }: { readonly model: DevicesModel; readonly qr: QrSlot }) {
  const t = useText("devices");
  const { made } = model;
  if (made === null) return null;
  const code = model.codes.find(({ id }) => id === made.id);
  return (
    <FirstSheet
      model={model}
      title={made.name || t("newDevice")}
      aside={code ? t("onceUntil", { time: code.until }) : undefined}
    >
      {qr(made.link, t("qrAria"))}
      <SettingLine label={t("scanWith")} value={t("scanApp")} />
      <SettingNote>{t("typedEntry")}</SettingNote>
      <div className="account-device-link">
        <SettingNote>{made.link}</SettingNote>
      </div>
      <Button kind="two" size="s" onPress={model.copy}>
        {t("copyLink")}
      </Button>
      {code ? (
        <Button
          kind="quiet"
          size="s"
          label={t("revokePairingLink")}
          disabled={model.working !== null}
          onPress={() => model.revokeCode(code.id)}
        >
          {t("revoke")}
        </Button>
      ) : null}
    </FirstSheet>
  );
}

/** The codes not used yet, each with the time it works until and its way back. No code, no sheet. */
function CodesNotUsed({ model }: { readonly model: DevicesModel }) {
  const t = useText("devices");
  const { codes, working } = model;
  const unused = codes.filter((code) => code.id !== model.made?.id);
  if (unused.length === 0) return null;
  return (
    <SettingsSheet title={t("codesTitle")} aside={unused.length}>
      {unused.map((code) => (
        <SettingLine
          key={code.id}
          label={code.name ?? t("codeFallback")}
          icon="key"
          value={t("codeMeta", { time: code.until })}
          narrow="detail"
        >
          <Button kind="two" size="s" disabled={working !== null} onPress={() => model.revokeCode(code.id)}>
            {working?.kind === "revokeCode" && working.id === code.id ? t("working") : t("revoke")}
          </Button>
        </SettingLine>
      ))}
    </SettingsSheet>
  );
}

/**
 * What is signed in. Before the list has answered: that it is being read. A read that failed: that, and the way to
 * read again, never an empty list. Then this device first, marked and with no verb; every other with its way out;
 * and, where the server groups them, the other browser sessions as one line.
 */
function SignedIn({ model, phone }: { readonly model: DevicesModel; readonly phone?: boolean }) {
  const t = useText("devices");
  const own = useText("accountDevices");
  const { list, working } = model;
  const title = t("devicesTitle");
  if (list.at === "loading") {
    return (
      <SettingsSheet title={title}>
        <div role="status">
          <SettingNote>{t("loading")}</SettingNote>
        </div>
      </SettingsSheet>
    );
  }
  if (list.at === "failed") {
    const again = (
      <Button kind="two" size="s" onPress={model.retry}>
        {t("retry")}
      </Button>
    );
    return (
      <SettingsSheet title={title} hot aside={again}>
        <SettingNote warn>{t("loadFailed")}</SettingNote>
      </SettingsSheet>
    );
  }
  const { devices, webGroup } = list;
  if (devices.length === 0 && webGroup === null) return null;
  const off = working !== null;
  return (
    <SettingsSheet title={title} aside={devices.length}>
      {devices.map((device) => {
        const kind = KIND[device.kind];
        const description = [
          phone ? t(kind.word) : null,
          !device.plainWeb ? t("deviceId", { id: device.id }) : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <SettingLine
            key={device.id}
            label={nameOf(device, t)}
            value={phone ? undefined : t(kind.word)}
            description={description || undefined}
            icon={kind.sign}
            tag={
              device.current
                ? own(device.kind === "ios" || device.kind === "android" ? "thisPhone" : "thisOne")
                : undefined
            }
          >
            {/* This device's way out is signing out, which Account has: it gets no second one here. */}
            {device.current ? null : (
              <Button
                kind={phone ? "quiet" : "two"}
                size="s"
                disabled={off}
                onPress={() => model.askRemove(device.id)}
              >
                {working?.kind === "remove" && working.id === device.id ? t("working") : t("remove")}
              </Button>
            )}
          </SettingLine>
        );
      })}
      {webGroup === null ? null : (
        <>
          <SettingLine label={t("webGroup", { count: webGroup.count })} icon="desktop">
            <Button kind={phone ? "quiet" : "two"} size="s" disabled={off} onPress={model.askSignOutWeb}>
              {working?.kind === "signOutWeb" ? t("working") : t("webGroupAction")}
            </Button>
          </SettingLine>
        </>
      )}
    </SettingsSheet>
  );
}

/** What is asked before a removal is sent: what it does, the answer that does it, and the way out. */
function Question({ model }: { readonly model: DevicesModel }) {
  const t = useText("devices");
  const { question, list } = model;
  const listed = list.at === "read" ? list : null;
  const device =
    question?.kind === "remove" ? listed?.devices.find((each) => each.id === question.id) : undefined;
  const group = question?.kind === "signOutWeb" ? listed?.webGroup : undefined;
  let asked: { readonly title: string; readonly line?: string; readonly confirm: string } | null = null;
  if (device) {
    asked = {
      title: t("removeAsk", { name: nameOf(device, t) }),
      ...(!device.plainWeb && { line: t("deviceId", { id: device.id }) }),
      confirm: t("remove"),
    };
  } else if (group) {
    asked = {
      title: t("webGroupAsk", { count: group.count }),
      line: t("webGroupScope"),
      confirm: t("webGroupAction"),
    };
  }
  return (
    <Dialog
      open={asked !== null}
      onClose={model.dismiss}
      title={asked?.title ?? ""}
      hot
      line={asked?.line}
      confirm={{ label: asked?.confirm ?? "", onPress: model.confirm, disabled: model.working !== null }}
      cancel={{ label: t("cancel") }}
    />
  );
}
