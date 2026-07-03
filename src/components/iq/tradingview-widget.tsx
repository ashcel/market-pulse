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
    const inner = document.createElement("div");
    inner.className = "tradingview-widget-container__widget";
    inner.style.height = "100%";
    inner.style.width = "100%";
    container.appendChild(inner);

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
    container.appendChild(script);

    return () => {
      container.innerHTML = "";
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
