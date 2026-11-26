import { useBinding } from "@ohmail/app-logic/keys";
import { SHEET_CHORD } from "../../keys/availability.js";
import { useContext } from "react";
import { Button, Sentence } from "@ohmail/ui/base";
import { SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { FrameContext } from "../../frame/commands.js";
import { useText, type Text } from "../../text/index.js";
import type { AboutMailboxes, AboutModel } from "./model.js";
import { ABOUT_NAMESPACE } from "./namespace.js";

/**
 * Settings › About ohmail: facts, each on its line. The mailbox line says one of five true sentences, a failed read
 * among them; the account line appears only where the server said it does not name its answers; the policies only
 * where they govern this install.
 */
export function AboutPane(props: { readonly model: AboutModel } | { readonly demo: true }) {
  const t = useText("about");
  const own = useText(ABOUT_NAMESPACE);
  const frame = useContext(FrameContext);
  const help = useBinding(SHEET_CHORD);
  if ("demo" in props) {
    return (
      <SettingsSheet>
        <SettingNote>{t("p1")}</SettingNote>
        <SettingNote>{t("p2")}</SettingNote>
        <SettingNote>{t("keys")}</SettingNote>
      </SettingsSheet>
    );
  }
  const { model } = props;
  const { mailboxes } = model;
  return (
    <>
      <SettingsSheet
        wants={
          mailboxes.kind === "failed"
            ? { word: own("notRead"), line: mailboxes.said, alert: true }
            : undefined
        }
      >
        <Sentence level={2} end="hot">
          ohmail
        </Sentence>
        <SettingLine
          label={t("buildLabel")}
          value={t("build", { version: model.version ?? "", build: model.build })}
        />
        <SettingLine
          label={t("mailboxesLabel")}
          value={mailboxes.kind === "failed" ? undefined : mailboxLine(mailboxes, t)}
        />
        {frame?.api.plan.device === "desktop" && help ? (
          <SettingLine label={t("keyboardLabel")}>
            <Button
              kind="quiet"
              size="s"
              keyHint={help.chord}
              shortcut={help.chord}
              onPress={() => frame.api.commands.over("keys")}
            >
              {own("showKeyboard")}
            </Button>
          </SettingLine>
        ) : frame === null ? (
          <SettingNote>{t("keys")}</SettingNote>
        ) : null}
        {model.namesAccount === false ? (
          <>
            <SettingLine label={t("accountHeaderLabel")} />
            <SettingNote warn>{t("accountHeaderMissing")}</SettingNote>
          </>
        ) : null}
      </SettingsSheet>
      <SettingsSheet>
        <SettingLine label={t("publishedBy")} narrow="under">
          <Button kind="quiet" size="s" href={`mailto:${model.publisher.address}`}>
            {model.publisher.address}
          </Button>
        </SettingLine>
        <SettingNote>{model.publisher.lines.join(" · ")}</SettingNote>
      </SettingsSheet>
      {model.policies ? (
        <SettingsSheet>
          <SettingLine label={t("yourMail")} narrow="under">
            <Button kind="quiet" size="s" href={model.policies.privacy}>
              {own("privacy")}
            </Button>
            <Button kind="quiet" size="s" href={model.policies.subprocessors}>
              {own("subprocessors")}
            </Button>
            <Button kind="quiet" size="s" href={model.policies.imprint}>
              {own("imprint")}
            </Button>
          </SettingLine>
        </SettingsSheet>
      ) : null}
    </>
  );
}

/** The mailbox line's sentence, one per state, as the shipped pane says it. */
function mailboxLine(mailboxes: Exclude<AboutMailboxes, { kind: "failed" }>, t: Text): string {
  if (mailboxes.kind === "reading") return t("loading");
  if (mailboxes.kind === "none") return t("noMailbox");
  const when = mailboxes.lastSyncAt ? absolute(mailboxes.lastSyncAt) : null;
  const synced = when === null ? t("neverSynced") : t("syncedAt", { when });
  return mailboxes.others === 0
    ? t("oneMailbox", { address: mailboxes.first, synced })
    : t("manyMailboxes", { address: mailboxes.first, others: mailboxes.others, synced });
}

/** The viewer's own locale and zone, as the shipped pane writes it; not a relative stamp, which would go stale unpainted. */
function absolute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
