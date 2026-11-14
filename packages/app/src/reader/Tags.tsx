/** A letter's tags in the reading head, each whole, as the kit's capsule. A tag the mirror does not hold is not drawn. */
import { Tag } from "@ohmail/ui/base";
import { useMirror } from "@ohmail/app-logic/reader";
import type { TagDTO as TagEntity } from "@ohmail/client-engine";

export function Tags({ labels }: { labels: readonly string[] }) {
  const { mirror } = useMirror();
  return (
    <>
      {labels.flatMap((id) => {
        const tag = mirror?.get<TagEntity>("tag", id);
        return tag ? [<Tag key={id}>{tag.name}</Tag>] : [];
      })}
    </>
  );
}
