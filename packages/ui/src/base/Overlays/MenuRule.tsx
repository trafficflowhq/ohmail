import "./menu.css";

export interface MenuRuleProps {
  /** The title of the group under the rule, where a menu holds more than one titled group: "Applies to". */
  title?: string;
}

/** A rule between two groups of a menu, and under it the next group's title where it has one. */
export function MenuRule({ title }: MenuRuleProps) {
  return (
    <>
      <hr className="oh-menu-rule" />
      {title ? <h4 className="oh-text oh-menu-title">{title}</h4> : null}
    </>
  );
}
