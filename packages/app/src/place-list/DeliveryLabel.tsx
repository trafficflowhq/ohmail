import "./delivery-label.css";

export function DeliveryLabel({
  title,
  place,
  children,
}: {
  title: string;
  place?: boolean;
  children: string;
}) {
  return (
    <span
      className={place ? "delivery-label badge oh-badge place" : "delivery-label badge oh-badge"}
      title={title}
    >
      {children}
    </span>
  );
}
