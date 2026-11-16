/** How long a request has left, as a person reads a countdown: minutes and seconds ("4:40"), never below zero. */
export function clock(seconds: number): string {
  const left = Math.max(0, Math.floor(seconds));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}
