import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { clampMenuPosition } from "../menu";
import { cx } from "./ui";

export type MenuItem = { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean };

// A right-click popup menu positioned at (x, y), clamped on screen, dismissed
// on outside click / Escape / scroll. Discord-style channel & message actions.
export default function ContextMenu({ x, y, items, onClose }: {
  x: number; y: number; items: MenuItem[]; onClose: () => void;
}) {
  const ref = useRef<HTMLUListElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos(clampMenuPosition(x, y, el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight));
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [onClose]);

  return <div className="fixed inset-0 z-50" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
    <ul ref={ref} className="menu menu-sm fixed w-48 rounded-box border border-base-300 bg-base-100 p-2 shadow-2xl"
      style={{ left: pos.left, top: pos.top }} onMouseDown={(e) => e.stopPropagation()}>
      {items.map((item, i) => <li key={i}><button className={cx(item.danger && "text-error")} disabled={item.disabled}
        onClick={() => { item.onSelect(); onClose(); }}>{item.label}</button></li>)}
    </ul>
  </div>;
}
