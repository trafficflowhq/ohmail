import type { ReactNode } from "react";
import { Button } from "@ohmail/ui/base";
import { SettingActs, SettingNote } from "@ohmail/ui/mail";
import type { ProviderPreset } from "@ohmail/app-logic/mailboxes/connect/providers";
import type { Text } from "../../text/index.js";

/**
 * The preset's own two links, its prerequisite first: opened only by the person's own press, beside the form and
 * never in its place (what was typed stays), and the provider is told nothing of where the person came from.
 */
export function ProviderHelp({ preset, picker }: { preset: ProviderPreset; picker: Text }): ReactNode {
  if (!preset.helpUrl && !preset.prereqUrl) return null;
  return (
    <SettingActs>
      {preset.prereqUrl ? (
        <Button kind="quiet" size="s" href={preset.prereqUrl} outside icon="go">
          {picker(`prereq_${preset.id}`)}
        </Button>
      ) : null}
      {preset.helpUrl ? (
        <Button kind="quiet" size="s" href={preset.helpUrl} outside icon="go">
          {picker(`help_${preset.id}`)}
        </Button>
      ) : null}
    </SettingActs>
  );
}

/**
 * What the chosen provider needs, and how its mailbox is reached. Where the tile connects another way, the caller's
 * sentence stands in its place; the provider's own links stay under it only where a password still connects there:
 * app-password advice beside the provider's sign-in would be a false instruction.
 */
export function ProviderNote({
  preset,
  picker,
  instead,
  help,
}: {
  preset: ProviderPreset;
  picker: Text;
  /** A sentence that takes the note's place. */
  instead: string | null;
  /** The provider's links stand under the note: a password connects this tile here. */
  help: boolean;
}): ReactNode {
  if (instead !== null && !help) return <SettingNote>{instead}</SettingNote>;
  return (
    <div className="mbx-connect-part">
      {/* The lead is the words the sentence leans on; the catalogue still holds it and the sentence as two entries. */}
      {instead === null ? (
        <SettingNote>{[{ strong: picker("needLabel") }, ` ${picker(`need_${preset.id}`)}`]}</SettingNote>
      ) : null}
      <SettingNote>{instead ?? picker(`note_${preset.id}`)}</SettingNote>
      <ProviderHelp preset={preset} picker={picker} />
    </div>
  );
}
