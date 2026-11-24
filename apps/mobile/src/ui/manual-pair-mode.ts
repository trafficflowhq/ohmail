let linkRequested = false;

export function requestPairingLink(): void {
  linkRequested = true;
}

export function pairingLinkRequested(): boolean {
  return linkRequested;
}

export function clearPairingLinkRequest(): void {
  linkRequested = false;
}
