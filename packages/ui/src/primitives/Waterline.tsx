import "./waterline.css";

export interface WaterlineProps {
  label: string;
  /** Right-hand meta, e.g. "last visit · Mon 18:40". */
  meta?: string;
  className?: string;
}

/** The seen/unseen boundary — one of Blanc's few deliberate hairlines. */
export function Waterline({ label, meta, className }: WaterlineProps) {
  return (
    <div
      className={className ? `waterline ${className}` : "waterline"}
      role="separator"
      aria-label={label}
    >
      <b>{label}</b>
      {meta ? <span className="num">{meta}</span> : null}
    </div>
  );
}
