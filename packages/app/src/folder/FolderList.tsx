/**
 * A FOLDER'S LIST: its name with the way to it (Folders, then each folder above it), how many letters it holds and the
 * list's menu; what is new and what came before.
 * Empty, it says the folder holds nothing; gone from the mail server, it says so by name.
 */
import { useFolderModel } from "@ohmail/app-logic/folder";
import { Empty } from "@ohmail/ui/base";
import { GroupHeading, ListHead, type Way } from "@ohmail/ui/mail";
import type { PaneProps } from "../frame/contract.js";
import { LetterRows, ListColumn, ListMenu } from "../place-list/index.js";
import { useText } from "../text/index.js";

export function FolderList({ plan }: PaneProps) {
  const model = useFolderModel();
  const t = useText("folder");
  const leaf = model.path.at(-1) ?? "";
  /* Where it lives: Folders, then each folder above it. Folders opens the fold of every folder once the rail has
     one; until then it is said, not pressed. */
  const way: Way | undefined =
    model.folder !== null
      ? {
          parts: [
            { label: t("way.all") },
            ...model.way.map((part) =>
              part.open ? { label: part.label, onPress: part.open } : { label: part.label },
            ),
          ],
          title: [t("way.all"), ...model.path].join(" / "),
          more: { label: "…" },
        }
      : undefined;
  const head = (
    <ListHead
      title={model.goneName ?? leaf}
      hot={model.fresh.some((m) => m.unread)}
      way={way}
      count={model.count > 0 ? t("metaCount", { count: model.count }) : undefined}
      aside={<ListMenu label={t("list.menu")} items={[]} />}
    />
  );
  const both = model.fresh.length > 0 && model.earlier.length > 0;
  const rows = (label: string, list: typeof model.fresh) =>
    list.length === 0 ? null : (
      <section aria-label={label}>
        {both ? <GroupHeading count={String(list.length)}>{label}</GroupHeading> : null}
        <LetterRows
          label={label}
          rows={list}
          cursor={model.list.openId}
          press={model.list.press}
          stamp={model.stamp}
          file={t("row.file")}
          who={(m) => m.from.name ?? m.from.address}
          spoken={(m) => (m.unread ? t("row.unread") : t("row.read"))}
        />
      </section>
    );
  return (
    <ListColumn head={head} plan={plan}>
      {rows(t("group.new"), model.fresh)}
      {rows(t("group.earlier"), model.earlier)}
      {model.goneName !== null ? <Empty label={t("gone", { name: model.goneName })} /> : null}
      {model.empty ? <Empty label={t("emptyTitle")} /> : null}
      {model.loading ? <Empty label={t("loading")} /> : null}
    </ListColumn>
  );
}
