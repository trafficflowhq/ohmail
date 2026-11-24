import { Icon } from "@ohmail/ui/base";

export function IdentityNotice({ children }: { children: string }) {
  return (
    <p className="oh-text" role="note">
      <Icon name="shield" size={16} />
      <span>{children}</span>
    </p>
  );
}
