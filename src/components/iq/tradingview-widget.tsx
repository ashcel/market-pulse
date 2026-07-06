import { useEffect, useRef } from "react";

interface Props {
  symbol?: string;
  height?: number | string;
}

export function TradingViewWidget({ symbol = "BINANCE:BTCUSDT", height = 460 }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    container.innerHTML = "";

    // No placeholder `__widget` div: the embed script inserts its own
    // full-height container before itself, and an extra 100%-height sibling
    // would push the iframe below the clipped viewport of the card.
    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol,
      interval: "60",
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1",
      locale: "en",
      hide_side_toolbar: false,
      allow_symbol_change: true,
      support_host: "https://www.tradingview.com",
      backgroundColor: "rgba(19,20,26,1)",
      gridColor: "rgba(255,255,255,0.04)",
    });

    if (container) {
      container.appendChild(script);
    }

    return () => {
      const curr = ref.current;
      if (curr) {
        curr.innerHTML = "";
      }
    };
  }, [symbol]);

  return (
    <div
      className="tradingview-widget-container overflow-hidden rounded-xl border border-border bg-card"
      style={{ height }}
    >
      <div ref={ref} style={{ height: "100%", width: "100%" }} />
    </div>
  );
}
