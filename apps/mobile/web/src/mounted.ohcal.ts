/**
 * What the ohcal app mounts: the calendar's places, registered here when they exist. None is yet, so the frame stands
 * with its dock and nothing in it; the calendar app never mounts a mail place.
 */
import { nothingMounted, type Mounted } from "./frame-supplies";

const mounted: Mounted = nothingMounted();
export default mounted;
