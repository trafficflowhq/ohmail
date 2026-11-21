import "./address-text.css";

export interface AddressTextProps {
  address: string;
}

/**
 * An address in two halves, so that a line short of room cuts the local part and keeps the domain whole: the domain
 * says who sent it, and an ellipsis there is the one cut a spoof relies on. The domain is everything from the LAST
 * "@" (a quoted local part may hold one); an address with no "@" is one half, kept whole. Each hyphen of the domain
 * is held to the letter after it, so a domain too long for its line never breaks at its own hyphen as if it were
 * hyphenation. The text a person copies is the address, unchanged.
 */
export function AddressText({ address }: AddressTextProps) {
  const at = address.lastIndexOf("@");
  const local = at > 0 ? address.slice(0, at) : null;
  const domain = at > 0 ? address.slice(at) : address;
  const parts = domain.split(/(-.)/).filter((part) => part !== "");
  return (
    <span className="oh-address">
      {local !== null ? (
        <span className="oh-address-local" data-short={Array.from(local).length <= 4 ? "" : undefined}>
          {local}
        </span>
      ) : null}
      <span className="oh-address-domain">
        {parts.map((part, i) =>
          /^-.$/.test(part) ? (
            <span key={i} className="oh-address-held">
              {part}
            </span>
          ) : (
            part
          ),
        )}
      </span>
    </span>
  );
}
