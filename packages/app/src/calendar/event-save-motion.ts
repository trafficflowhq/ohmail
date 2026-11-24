function eventChip(card: HTMLElement, eventId: string) {
  return [...(card.closest(".cal-body-view")?.querySelectorAll<HTMLElement>("[data-record]") ?? [])].find(
    (chip) => chip.dataset.record === eventId,
  );
}

/** A leaving copy has no controls and never delays the write or the route. */
function leaveCopy(element: HTMLElement, to?: HTMLElement) {
  const document = element.ownerDocument;
  const from = element.getBoundingClientRect();
  if (!from.width || !from.height) return;
  const copy = element.cloneNode(true) as HTMLElement;
  copy.inert = true;
  copy.setAttribute("aria-hidden", "true");
  copy.removeAttribute("role");
  copy.querySelectorAll("[id]").forEach((child) => child.removeAttribute("id"));
  copy.dataset.still = "";
  Object.assign(copy.style, {
    position: "fixed",
    left: `${from.left}px`,
    top: `${from.top}px`,
    width: `${from.width}px`,
    height: `${from.height}px`,
    maxWidth: "none",
    margin: "0",
    zIndex: "8",
    pointerEvents: "none",
    transformOrigin: "top left",
  });
  const reduced = document.documentElement.dataset.rm === "1";
  const dest = reduced ? undefined : to?.getBoundingClientRect();
  const transform =
    dest &&
    `translate(${dest.left - from.left}px, ${dest.top - from.top}px) scale(${dest.width / from.width}, ${dest.height / from.height})`;
  const css = getComputedStyle(element);
  const duration = css.getPropertyValue(reduced ? "--d-reduced" : "--d-out").trim();
  const time = Number.parseFloat(duration) * (duration.endsWith("ms") ? 1 : 1000);
  (element.closest(".fr-frame") ?? document.body).append(copy);
  const animation = copy.animate(
    [
      { opacity: 1, transform: "none" },
      { opacity: 0, transform: transform || "none" },
    ],
    {
      duration: Number.isFinite(time) ? time : 180,
      easing: css.getPropertyValue("--e-in").trim() || "ease-in",
      fill: "forwards",
    },
  );
  animation.onfinish = animation.oncancel = () => copy.remove();
}

export function closeEventDraft(card: HTMLElement | null, eventId: string) {
  if (card) leaveCopy(card, eventChip(card, eventId));
}

export function fadeRejectedEvent(view: HTMLElement | null, eventId: string) {
  const chip = view && eventChip(view, eventId);
  if (chip) leaveCopy(chip);
}
