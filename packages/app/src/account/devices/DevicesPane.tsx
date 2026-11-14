import { Fragment, type KeyboardEvent, type ReactNode } from "react";
import { Button, Dialog, Field, type IconName } from "@ohmail/ui/base";
import { SettingLine, SettingNote, SettingsSheet, type SettingsSheetProps } from "@ohmail/ui/mail";
import { useText, type Text } from "../../text/index.js";
import { ACCOUNT_REFUSALS, type FactorSlot, type QrSlot } from "../contract.js";
import type { DeviceKind, DeviceSession, DevicesModel } from "./model.js";
import "./placement.css";

export interface DevicesPaneProps {
  readonly model: DevicesModel;
  /** The factor's dialog, filled by the shell: drawn while a verb is parked behind it. */
  readonly factor: FactorSlot;
  /** The picture of the pairing link to scan, filled by the shell. */
  readonly qr: QrSlot;
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
export function DevicesPane({ model, factor, qr }: DevicesPaneProps) {
  return (
    <>
      {model.made === null ? <NewDevice model={model} /> : <MadeLink model={model} qr={qr} />}
      <CodesNotUsed model={model} />
      <SignedIn model={model} />
      <Question model={model} />
      {model.ask ? factor(model.ask) : null}
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
  readonly children: ReactNode;
}) {
  const t = useText("devices");
  const own = useText("accountDevices");
  const { problem, nothingRan } = p.model;
  const nothingRanSaid = t("stepUpCancelledNothingRan");
  let wants: Wants | undefined;
  if (problem === null) wants = nothingRan ? { word: own("cancelled"), line: nothingRanSaid } : undefined;
  else if (problem.with === "copy") wants = { word: own("notCopied"), line: t("copyFailed") };
  else {
    const word = own(problem.with === "read" ? "notRead" : "notDone");
    const line = problem.why.word === "said" ? problem.why.said : t(ACCOUNT_REFUSALS.devices.sign_in.key);
    wants = line === "" ? { word } : { word, line };
  }
  return (
    <SettingsSheet title={p.title} hot={p.title !== undefined} wants={wants}>
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
      <SettingNote>{t("intro")}</SettingNote>
      <div className="account-device-name" onKeyDown={onKey}>
        <Field label={t("addFor")} value={model.name} onChange={model.type} maxLength={100} />
      </div>
      <SettingNote>{t("addHint")}</SettingNote>
      <Button kind="ink" size="s" disabled={off} onPress={model.add}>
        {model.working?.kind === "add" ? t("working") : t("addAction")}
      </Button>
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
  return (
    <FirstSheet model={model} title={made.name === "" ? t("codeFallback") : made.name}>
      <SettingNote>
        {made.name === "" ? t("mintedLead") : t("mintedLeadFor", { name: made.name })}
      </SettingNote>
      {qr(made.link, t("qrAria"))}
      <SettingNote>{t("typedEntry")}</SettingNote>
      <div className="account-device-link">
        <SettingNote>{made.link}</SettingNote>
      </div>
      <Button kind="two" size="s" onPress={model.copy}>
        {t("copyLink")}
      </Button>
      <Button kind="ink" size="s" onPress={model.done}>
        {t("mintedDone")}
      </Button>
      <SettingNote>{t("mintedOnce")}</SettingNote>
    </FirstSheet>
  );
}

/** The codes not used yet, each with the time it works until and its way back. No code, no sheet. */
function CodesNotUsed({ model }: { readonly model: DevicesModel }) {
  const t = useText("devices");
  const { codes, working } = model;
  if (codes.length === 0) return null;
  return (
    <SettingsSheet title={t("codesTitle")} aside={codes.length}>
      {codes.map((code) => (
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
function SignedIn({ model }: { readonly model: DevicesModel }) {
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
        return (
          <Fragment key={device.id}>
            <SettingLine
              label={nameOf(device, t)}
              icon={kind.sign}
              tag={device.current ? own("thisOne") : undefined}
            >
              {/* This device's way out is signing out, which Account has: it gets no second one here. */}
              {device.current ? null : (
                <Button kind="two" size="s" disabled={off} onPress={() => model.askRemove(device.id)}>
                  {working?.kind === "remove" && working.id === device.id ? t("working") : t("remove")}
                </Button>
              )}
            </SettingLine>
            {device.current ? null : (
              <SettingNote>
                {t("deviceMeta", { kind: t(kind.word), created: device.added, seen: device.seen })}
              </SettingNote>
            )}
          </Fragment>
        );
      })}
      {webGroup === null ? null : (
        <>
          <SettingLine label={t("webGroup", { count: webGroup.count })} icon="desktop">
            <Button kind="two" size="s" disabled={off} onPress={model.askSignOutWeb}>
              {working?.kind === "signOutWeb" ? t("working") : t("webGroupAction")}
            </Button>
          </SettingLine>
          <SettingNote>{t("webGroupMeta", { seen: webGroup.seen })}</SettingNote>
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
  let asked: { readonly title: string; readonly line: string; readonly confirm: string } | null = null;
  if (device) {
    asked = {
      title: t("removeAsk", { name: nameOf(device, t) }),
      line: t("removeWhat"),
      confirm: t("remove"),
    };
  } else if (group) {
    asked = {
      title: t("webGroupAsk", { count: group.count }),
      line: t("webGroupWhat"),
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
