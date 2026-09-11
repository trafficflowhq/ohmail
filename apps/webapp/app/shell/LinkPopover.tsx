"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { Editor } from "@tiptap/react";
import { TextField } from "@ohmail/ui";

/**
 * The link popover — the destination input the toolbar's Link button and ⌘K both open. It replaced
 * `window.prompt`, which could offer no visible Remove, no explained refusal of a bad scheme, and a
 * dialog naming the browser; the prompt's costs are paid explicitly — Escape handled and STOPPED
 * (the shell's cascade must not also fire), focus given on open and handed back on close, a named
 * `role="dialog"`. Apply accepts http, https or mailto — the same three schemes the server's
 * outbound sanitiser enforces (`outbound-html.ts`), stated as UX rather than re-implemented as
 * security: a control that accepts what the server strips is a button that silently does nothing.
 */

/**
 * People type what they mean, not a scheme: a scheme-less `a.example/docs` would survive BOTH ends
 * as a relative href (TipTap admits relative URLs, so does the sanitiser) and dangle unresolvable
 * in the recipient's client — so normalisation happens here, at the one point where "what did the
 * author mean" is still answerable: bare domains become https, a bare address becomes mailto,
 * anything with a scheme is judged against the allow-list, and `new URL` must parse the result. The
 * input is uncontrolled, read on Apply via a ref — nothing reacts per keystroke, so controlling it
 * buys a render per keystroke and nothing else; the error clears on the next keystroke because
 * stale refusals read as "still wrong".
 */

/** The schemes a composed link may carry — the sanitiser's list, worn as UX. */
const ALLOWED_LINK_SCHEMES = new Set(["http", "https", "mailto"]);

/**
 * What the author typed, made into a destination a mail client can open — or `null` when it
 * cannot be one. `""` in means `""` out: the caller reads an empty answer as "remove the
 * link", the same semantics the prompt had.
 */
export function normalizeHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  // Protocol-relative slips past scheme checks by having no scheme; the sanitiser refuses it
  // (`allowProtocolRelative: false`) and so does this, before the https-prefix below could
  // turn it into something else.
  if (trimmed.startsWith("//")) return null;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  const candidate = scheme
    ? trimmed
    : /^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/.test(trimmed)
      ? `mailto:${trimmed}`
      : `https://${trimmed}`;
  const parsed = (() => {
    try { return new URL(candidate); } catch { return null; }
  })();
  if (!parsed) return null;
  // `URL.protocol` is the parser's answer, colon included — not a re-derivation by regex.
  if (!ALLOWED_LINK_SCHEMES.has(parsed.protocol.slice(0, -1).toLowerCase())) return null;
  return candidate;
}

export interface LinkPopoverProps {
  editor: Editor;
  /** Close the popover. `true` hands focus back to the editor; a click elsewhere does not. */
  onClose: (focusEditor: boolean) => void;
}

export function LinkPopover({ editor, onClose }: LinkPopoverProps) {
  const t = useTranslations("compose");
  const inputRef = useRef<HTMLInputElement>(null);
  const [bad, setBad] = useState(false);

  /**
   * The href under the caret at the moment the popover OPENED. A state initializer rather
   * than a render-time read, because the popover mounts fresh on every open (it is
   * conditionally rendered) and must not chase the document afterwards — the selection it is
   * editing is the one the author had when they asked for it.
   */
  const [initialHref] = useState<string>(
    () => (editor.getAttributes("link").href as string | undefined) ?? "",
  );

  const remove = (): void => {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    onClose(false);
  };

  const apply = (): void => {
    const href = normalizeHref(inputRef.current?.value ?? "");
    if (href === "") {
      // An empty answer UNSETS rather than doing nothing — the prompt's semantics, kept,
      // because "clear the field and confirm" is how people express removal in every form.
      remove();
      return;
    }
    if (href === null) {
      setBad(true);
      return;
    }
    // `extendMarkRange` first: with the caret INSIDE a link and nothing selected, the new
    // destination covers the whole anchor rather than a zero-width slice of it — which is
    // what "edit this link" means. On a plain selection it is a no-op.
    // `setLink` has the extension's own validator behind it; a refusal there (`run()` false)
    // gets the same visible answer as ours, never a silent nothing.
    const ok = editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    if (!ok) {
      setBad(true);
      return;
    }
    onClose(false);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Escape") {
      // Handled AND stopped: the shell's escape cascade hangs on a document listener
      // (`keymap.tsx`), and without this line the press that closes the popover would also
      // leave Compose. Innermost thing open closes first — the cascade's own rule.
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      apply();
    }
  };

  /** Focus left the popover for somewhere real: the author moved on. Close without stealing back. */
  const onBlur = (e: React.FocusEvent<HTMLDivElement>): void => {
    if (e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget)) {
      onClose(false);
    }
  };

  return (
    <div
      className="rte-linkpop"
      role="dialog"
      aria-label={t("rte.link")}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
      <TextField
        ref={inputRef}
        className="rte-linkpop-url"
        type="text"
        inputMode="url"
        autoFocus
        defaultValue={initialHref}
        placeholder="https://…"
        aria-label={t("linkPrompt")}
        aria-invalid={bad || undefined}
        onInput={() => setBad(false)}
      />
      <button type="button" className="rte-linkpop-apply" onClick={apply}>
        {t("rte.linkApply")}
      </button>
      {initialHref !== "" && (
        <button type="button" className="rte-linkpop-remove" onClick={remove}>
          {t("rte.linkRemove")}
        </button>
      )}
      {bad && (
        <p className="rte-linkpop-err" role="alert">
          {t("rte.linkBad")}
        </p>
      )}
    </div>
  );
}
