import "./delivery-label.css";

export function DeliveryLabel({ title, children }: { title: string; children: string }) {
  return (
    <span className="delivery-label badge oh-badge" role="note" aria-label={title} title={title}>
      <span aria-hidden="true">{children}</span>
    </span>
  );
}
