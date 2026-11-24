import { useRef } from "react";
import { Button } from "../../base/index.js";
import "./attach.css";

export interface AttachProps {
  /** Its name, with the limit said: "Attach · 25 MB a message". */
  label: string;
  /** The files that were chosen, several at once. */
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}

/** One direct act: the clip opens the system's own file dialog. No menu and no list of files behind it. */
export function Attach({ label, onFiles, disabled }: AttachProps) {
  const picker = useRef<HTMLInputElement | null>(null);
  return (
    <span className="oh-attach">
      <Button
        kind="two"
        size="s"
        icon="clip"
        label={label}
        disabled={disabled}
        onPress={() => picker.current?.click()}
      />
      <input
        ref={picker}
        className="oh-attach-picker"
        type="file"
        multiple
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          /* The same file can be chosen again after it was taken off. */
          event.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
    </span>
  );
}
