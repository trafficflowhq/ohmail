/**
 * What a screen reader has of a region's words: its text, part by part, without what is kept from it
 * (`aria-hidden`) and without its controls, which are named for themselves.
 */
export function heard(region: Element): string {
  const copy = region.cloneNode(true) as Element;
  for (const kept of copy.querySelectorAll('[aria-hidden="true"], button')) kept.remove();
  const parts: string[] = [];
  const walk = copy.ownerDocument.createTreeWalker(copy, 4);
  for (let node = walk.nextNode(); node; node = walk.nextNode()) parts.push(node.textContent ?? "");
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
