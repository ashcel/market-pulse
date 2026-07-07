import { useState } from "react";

import { cn } from "@/lib/utils";

// Colored monogram fallback when no logo is available for the ticker.
const palette = [
  "var(--color-info)",
  "var(--color-bullish)",
  "var(--color-warning)",
  "var(--color-bearish)",
  "var(--chart-5)",
];

function hashColor(ticker: string) {
  let h = 0;
  for (let i = 0; i < ticker.length; i++) h = (h * 31 + ticker.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

export function AssetIcon({ ticker, className }: { ticker: string; className?: string }) {
  const [failed, setFailed] = useState(false);

  // Sized in em so the icon scales with the caller's text-size class.
  const size = { width: "1.25em", height: "1.25em" };

  if (!failed) {
    return (
      <img
        src={`https://assets.coincap.io/assets/icons/${ticker.toLowerCase()}@2x.png`}
        alt=""
        aria-hidden
        loading="lazy"
        onError={() => setFailed(true)}
        className={cn("inline-block shrink-0 rounded-full bg-surface", className)}
        style={size}
      />
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full text-[10px] font-bold text-background",
        className,
      )}
      style={{ backgroundColor: hashColor(ticker), ...size }}
      aria-hidden
    >
      {ticker.slice(0, 1)}
    </span>
  );
}
