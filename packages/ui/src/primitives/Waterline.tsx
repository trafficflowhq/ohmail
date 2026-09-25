import "./waterline.css";

export interface WaterlineProps {
  label: string;
  /** Right-hand meta, e.g. "last visit · Mon 18:40". */
  meta?: string;
  className?: string;
  /** Its slot in a windowed list's index space, so `useListWindow` measures the line too. */
  index?: number;
}

/** The seen/unseen boundary — one of Blanc's few deliberate hairlines. */
export function Waterline({ label, meta, className, index }: WaterlineProps) {
  return (
    <div
      className={className ? `waterline ${className}` : "waterline"}
      role="separator"
      aria-label={label}
      data-index={index}
    >
      <b>{label}</b>
      {meta ? <span className="num">{meta}</span> : null}
    </div>
  );
}
