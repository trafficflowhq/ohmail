"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { Editor } from "@tiptap/react";

/**
 * THE LINK POPOVER — the destination input the toolbar's Link button and ⌘K both open.
 *
 * It replaced `window.prompt`, which held this spot deliberately for a while (one line,
 * keyboard-native, screen-reader-announced). What the prompt could not offer is why it went:
 * no visible Remove for an existing link, no way to refuse a bad scheme with an explanation
 * rather than a silent no-op, and a system dialog that names the browser rather than the app.
 * The costs the prompt was avoiding are paid here explicitly — Escape is handled and STOPPED
 * (the shell's escape cascade must not also fire), focus is given to the input on open and
 * handed back to the editor on close, and the whole thing is a `role="dialog"` with a name.
 *
 * ── WHAT APPLY ACCEPTS, AND WHAT IT MAKES OF IT ──────────────────────────────────────────
 *
 * The editor writes markup a MAIL client renders, so a destination may only be something a
 * mail client can open: http, https or mailto — the same three schemes the server's outbound
 * sanitiser enforces (`outbound-html.ts`), stated here as UX rather than re-implemented as
 * security. The server remains the enforcement; this is the courtesy of not accepting what it
 * will strip, because a control that accepts what the server refuses is a button that silently
 * does nothing.
 *
 * People type what they mean, not a scheme. A scheme-less `a.example/docs` would survive BOTH
 * ends as a relative href — TipTap's validator admits relative URLs and so does the sanitiser
 * — and then dangle unresolvable in the recipient's client. So normalisation happens here, at
 * the one point where "what did the author mean" is still answerable: bare domains become
 * https, a bare address becomes mailto, anything with a scheme is taken at its word and judged
 * against the allow-list. `new URL` then has to parse the result, which is what turns "not a
 * url" from a garbage href into the visible refusal below.
 *
 * ── THE INPUT IS UNCONTROLLED ────────────────────────────────────────────────────────────
 *
 * Read on Apply, via a ref. Nothing reacts to the value while it is being typed — there is no
 * live preview and no per-keystroke validation to feed — so controlling it would buy a render
 * per keystroke and nothing else. The error clears on the next keystroke because stale
 * refusals read as "still wrong", and that is the one thing `onInput` is wired for.
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
      <input
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
