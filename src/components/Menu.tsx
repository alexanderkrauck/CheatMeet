import { useEffect, useRef, type ReactNode } from "react";

/**
 * The one dropdown in the app. Both the account menu and the per-meeting
 * actions used to hand-roll the same `<details>` + outside-click + Escape
 * behaviour with near-identical stylesheets.
 */
export default function Menu({
  title,
  icon,
  align = "end",
  children,
}: {
  title: string;
  icon: ReactNode;
  align?: "start" | "end";
  children: ReactNode;
}) {
  const host = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const close = (event: Event) => {
      const node = host.current;
      if (!node?.open) return;
      if (event.type === "keydown") {
        if ((event as KeyboardEvent).key !== "Escape") return;
        node.open = false;
        // Dismissing with the keyboard has to put focus somewhere sensible.
        node.querySelector("summary")?.focus();
        return;
      }
      if (!node.contains(event.target as Node)) node.open = false;
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);

  return (
    <details className={`menu menu-${align}`} ref={host}>
      <summary aria-label={title} title={title}>
        {icon}
      </summary>
      {/* Choosing an item dismisses the menu, whatever that item does — and
          focus goes back to the trigger rather than onto a hidden control. */}
      <div
        onClick={() => {
          const node = host.current;
          if (!node?.open) return;
          node.open = false;
          node.querySelector("summary")?.focus();
        }}
      >
        {children}
      </div>
    </details>
  );
}
