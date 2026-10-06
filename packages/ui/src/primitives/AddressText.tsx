import "./address-text.css";

export interface AddressTextProps {
  address: string;
}

/**
 * An address in two halves, so a layout can cut the local part and keep the domain whole: the
 * domain is what says who sent it, and an ellipsis there is the one cut a spoof relies on. The
 * domain is everything after the LAST "@" (a quoted local part may hold one); no "@" ⇒ one whole half.
 * Each hyphen in the domain is held to the character after it, so a wrapped domain never ends a line
 * at its own hyphen; the text a person copies is unchanged.
 */
export function AddressText({ address }: AddressTextProps) {
  const at = address.lastIndexOf("@");
  const domain = at > 0 ? address.slice(at) : address;
  const parts = domain.split(/(-.)/).filter((p) => p !== "");
  return (
    <span className="addr-text">
      {at > 0 ? <span className="addr-local">{address.slice(0, at)}</span> : null}
      <span className="addr-dom">
        {parts.map((p, i) => (/^-.$/.test(p) ? <span key={i} className="addr-nb">{p}</span> : p))}
      </span>
    </span>
  );
}
