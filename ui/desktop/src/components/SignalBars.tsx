import { qualityBars, type Quality } from "../quality";
import { Tooltip, cx } from "./ui";

// Three-bar signal indicator (Discord-style). Colored by grade; empty bars
// dim. "unknown" renders all-dim so a not-yet-reported peer looks neutral.
export default function SignalBars({ quality, title }: { quality: Quality; title?: string }) {
  const filled = qualityBars(quality);
  const tone = quality === "good" ? "bg-success" : quality === "fair" ? "bg-warning" : quality === "poor" ? "bg-error" : "bg-base-content/20";
  const meter = <span className="inline-flex h-4 items-end gap-0.5" role="img" aria-label={`连接质量 ${quality}`}>
    {[1, 2, 3].map((bar) => <i key={bar} className={cx("block w-0.5 rounded-selector", bar <= filled ? tone : "bg-base-content/20")}
      style={{ height: `${bar * 5}px` }} />)}
  </span>;
  return title ? <Tooltip label={title}>{meter}</Tooltip> : meter;
}
