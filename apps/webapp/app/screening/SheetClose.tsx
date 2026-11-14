/** The full-height sheet's close (`sender-sheet.css`, `.sm-close-bar`): this sheet's and the
 *  subject-rule sheet's, which share the shell. Nothing while the sheet has room around it. */
export function SheetClose({ full, label, onClose }: { full: boolean; label: string; onClose: () => void }) {
  if (!full) return null;
  return (
    <div className="sm-close-bar">
      <button type="button" className="sm-close" aria-label={label} onClick={onClose}>
        ✕
      </button>
    </div>
  );
}
