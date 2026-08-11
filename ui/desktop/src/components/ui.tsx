import type { ButtonHTMLAttributes, ReactNode } from "react";

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export function Tooltip({ label, children, side = "top", className }: {
  label: string;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
}) {
  return <span className={cx("tooltip", `tooltip-${side}`, className)} data-tip={label}>{children}</span>;
}

export function IconButton({ label, className, children, ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <Tooltip label={label}>
    <button type="button" className={cx("btn btn-ghost btn-square btn-sm", className)} aria-label={label} {...props}>
      {children}
    </button>
  </Tooltip>;
}

export function InitialAvatar({ name, size = "md", online }: {
  name?: string;
  size?: "sm" | "md" | "lg";
  online?: boolean;
}) {
  const dimensions = size === "sm" ? "h-7 w-7 text-xs" : size === "lg" ? "h-12 w-12 text-lg" : "h-9 w-9 text-sm";
  return <div className={cx("avatar avatar-placeholder", online === true && "avatar-online", online === false && "avatar-offline")}>
    <div className={cx("rounded-selector bg-neutral text-neutral-content", dimensions)}>
      <span className="font-semibold">{(name || "?").slice(0, 1).toUpperCase()}</span>
    </div>
  </div>;
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return <div className="hero min-h-full">
    <div className="hero-content text-center">
      <div className="max-w-md">
        <div className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-box bg-base-200 text-2xl text-base-content/70">{icon}</div>
        <h2 className="text-lg font-semibold">{title}</h2>
        {children && <div className="mt-2 text-sm text-base-content/55">{children}</div>}
      </div>
    </div>
  </div>;
}

export function ModalHeader({ title, eyebrow, onClose }: { title: string; eyebrow?: string; onClose: () => void }) {
  return <div className="flex items-start justify-between gap-4 border-b border-base-300 px-6 py-5">
    <div>
      {eyebrow && <p className="mb-1 text-xs font-medium uppercase tracking-[0.18em] text-base-content/45">{eyebrow}</p>}
      <h2 className="text-xl font-semibold">{title}</h2>
    </div>
    <IconButton label="关闭" onClick={onClose}>×</IconButton>
  </div>;
}
