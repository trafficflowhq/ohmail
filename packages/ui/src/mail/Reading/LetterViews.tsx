import { Button, type IconName } from "../../base/index.js";
import "./letter-views.css";

/** One way to see the letter: Show images, Adapt to dark, Show as text. */
export interface LetterView {
  id: string;
  label: string;
  icon?: IconName;
  /** Offered under a finger only: with a pointer the way stands where the letter has no layout of its own. */
  touchOnly?: boolean;
  onPress?: () => void;
}

export interface LetterViewsProps {
  /** The group's name for a screen reader. */
  label: string;
  views: readonly LetterView[];
}

/** The ways to see a letter: quiet words at the trailing edge, above it. */
export function LetterViews({ label, views }: LetterViewsProps) {
  if (!views.length) return null;
  return (
    <div className="oh-letterviews" role="group" aria-label={label}>
      {views.map((view) => (
        <span key={view.id} className="oh-letterviews-way" data-touch-only={view.touchOnly ? "" : undefined}>
          <Button kind="quiet" size="s" icon={view.icon} onPress={view.onPress}>
            {view.label}
          </Button>
        </span>
      ))}
    </div>
  );
}
