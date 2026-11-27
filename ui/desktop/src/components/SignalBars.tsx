import { qualityBars, type Quality } from "../quality";
import { cx } from "./ui";

// Three-bar signal indicator (Discord-style). Colored by grade; empty bars
// dim. "unknown" renders all-dim so a not-yet-reported peer looks neutral.
const labels: Record<Quality, string> = { good: "良好", fair: "一般", poor: "较差", unknown: "未知" };

export default function SignalBars({ quality }: { quality: Quality }) {
  const filled = qualityBars(quality);
  const tone = quality === "good" ? "bg-success" : quality === "fair" ? "bg-warning" : quality === "poor" ? "bg-error" : "bg-base-content/20";
  return <span className="inline-flex h-4 items-end gap-0.5" role="img" aria-label={`连接质量${labels[quality]}`}>
    {[1, 2, 3].map((bar) => <i key={bar} className={cx("block w-0.5 rounded-selector", bar <= filled ? tone : "bg-base-content/20")}
      style={{ height: `${bar * 5}px` }} />)}
  </span>;
}
