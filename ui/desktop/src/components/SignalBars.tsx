import { qualityBars, type Quality } from "../quality";

// Three-bar signal indicator (Discord-style). Colored by grade; empty bars
// dim. "unknown" renders all-dim so a not-yet-reported peer looks neutral.
export default function SignalBars({ quality, title }: { quality: Quality; title?: string }) {
  const filled = qualityBars(quality);
  return <span className={`signal ${quality}`} title={title} role="img" aria-label={`连接质量 ${quality}`}>
    {[1, 2, 3].map((bar) => <i key={bar} className={bar <= filled ? "on" : ""} />)}
  </span>;
}
