import type { Ref } from "react";
import { Dot } from "../Primitives/Dot.js";
import "./camera-square.css";

export interface CameraSquareProps {
  /** `live`: the camera looks, on the solid ground with the hot dot. `off`: it does not, on the quiet ground. */
  state: "live" | "off";
  /** What the square is, for a screen reader: "Camera", "Camera off". The square draws no word. */
  label: string;
  /** The square's own box. Whoever stands a camera's picture on the page stands it at this box. */
  boxRef?: Ref<HTMLDivElement>;
}

/**
 * The square a camera stands in: as wide as its room up to its own measure, four corners that frame what is
 * looked at, and the hot dot while the camera looks. It is a picture with a name and takes no press and no keys:
 * what turns the camera on, and what else may be done, are the page's buttons beside it.
 */
export function CameraSquare({ state, label, boxRef }: CameraSquareProps) {
  return (
    <div ref={boxRef} className="oh-camera" data-state={state} role="img" aria-label={label}>
      <i className="oh-camera-corner" aria-hidden="true" />
      <i className="oh-camera-corner" aria-hidden="true" />
      <i className="oh-camera-corner" aria-hidden="true" />
      <i className="oh-camera-corner" aria-hidden="true" />
      {state === "live" ? <Dot kind="hot" /> : null}
    </div>
  );
}
