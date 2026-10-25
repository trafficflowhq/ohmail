/**
 * THE iPAD'S WINDOW CONTROLS ARE PART OF THE TOP INSET. In Split View, Slide Over and a free window
 * iPadOS draws its window controls over the app's top-leading corner, and the safe area this app
 * reads does not include them: they sat on Back and on the list title. The system says where they
 * end: the safe area adapted at its corners (`getWindowControlsInset`, iOS 26+), which every iPad
 * window takes where it is read. A 44pt strip read from frames stands in only for a window smaller
 * than its screen where no reading exists. Every phone is untouched.
 */
export const IPAD_WINDOW_CONTROLS_PT = 44;

export interface WindowShape {
  isPad: boolean;
  window: { width: number; height: number };
  screen: { width: number; height: number };
}

/** True where iPadOS draws window controls over the app: an iPad window smaller than its screen. */
export function windowedOnPad({ isPad, window, screen }: WindowShape): boolean {
  if (!isPad) return false;
  return window.width < screen.width - 1 || window.height < screen.height - 1;
}

/**
 * The top inset a screen pays: the system's, raised to the controls' own edge where the system
 * read it (`controlsTop`, null where it could not), else the frame strip on a windowed iPad. A
 * windowed reading short of the strip is no reading: resizable windows answer the status bar alone.
 */
export function topInsetWithControls(systemTop: number, shape: WindowShape, controlsTop: number | null = null): number {
  if (!shape.isPad) return systemTop;
  const windowed = windowedOnPad(shape);
  if (controlsTop !== null && Number.isFinite(controlsTop) && !(windowed && controlsTop < IPAD_WINDOW_CONTROLS_PT)) {
    return Math.max(systemTop, controlsTop);
  }
  return windowed ? systemTop + IPAD_WINDOW_CONTROLS_PT : systemTop;
}
