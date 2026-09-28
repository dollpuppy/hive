export type Child = Node | string | null | undefined | false | Child[];

/** Tiny element builder. `on*` props become listeners; known properties are set, others become attributes. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === "class") {
      el.className = String(value);
    } else if (key in el) {
      Reflect.set(el, key, value);
    } else {
      el.setAttribute(key, String(value));
    }
  }
  const append = (c: Child): void => {
    if (Array.isArray(c)) c.forEach(append);
    else if (c !== null && c !== undefined && c !== false) el.append(c);
  };
  children.forEach(append);
  return el;
}
