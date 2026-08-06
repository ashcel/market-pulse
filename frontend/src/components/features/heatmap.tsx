import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { Sector } from "@/lib/types";
import { CardEyebrow, IqCard } from "./iq-card";
import { motion } from "framer-motion";

function toneClass(change: number) {
  if (change >= 3) return "bg-bullish/25 text-bullish border-bullish/30";
  if (change >= 1) return "bg-bullish/15 text-bullish border-bullish/20";
  if (change > 0) return "bg-bullish/10 text-bullish border-bullish/15";
  if (change === 0) return "bg-muted text-muted-foreground border-border";
  if (change > -1) return "bg-bearish/10 text-bearish border-bearish/15";
  if (change > -3) return "bg-bearish/15 text-bearish border-bearish/20";
  return "bg-bearish/25 text-bearish border-bearish/30";
}

export function Heatmap({ sectors, className }: { sectors: Sector[]; className?: string }) {
  const { t } = useTranslation();
  const groups = sectors.reduce<string[]>(
    (acc, s) => (acc.includes(s.group) ? acc : [...acc, s.group]),
    [],
  );
  return (
    <IqCard className={cn("flex flex-col gap-4", className)}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {groups.map((group) => {
          const items = sectors.filter((s) => s.group === group);
          if (!items.length) return null;
          return (
            <div key={group} className="flex flex-col gap-2">
              <CardEyebrow className="text-center">{group}</CardEyebrow>
              <div className="grid grid-cols-2 gap-1.5">
                {items.map((s, i) => (
                  <motion.div
                    key={s.ticker}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2, delay: i * 0.02 }}
                  >
                    <Link
                      to="/token/$symbol"
                      params={{ symbol: s.ticker }}
                      className={cn(
                        "flex min-h-[54px] flex-col items-center justify-center rounded-lg border px-2 py-2 text-center transition-transform hover:scale-[1.02]",
                        toneClass(s.change),
                      )}
                    >
                      <div className="text-xs font-semibold tracking-wide">{s.ticker}</div>
                      <div className="num text-[11px] font-medium">
                        {s.change > 0 ? "+" : ""}
                        {s.change.toFixed(2)}%
                      </div>
                    </Link>
                  </motion.div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <div className="flex items-center gap-2">
          <span>{t("components.batchB.heatmap.capitalInflow")}</span>
          <span className="h-1 w-24 rounded-full bg-gradient-to-r from-bullish/20 to-bullish" />
          <span className="text-bullish">{t("components.batchB.heatmap.strong")}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-bearish">{t("components.batchB.heatmap.strong")}</span>
          <span className="h-1 w-24 rounded-full bg-gradient-to-r from-bearish to-bearish/20" />
          <span>{t("components.batchB.heatmap.capitalOutflow")}</span>
        </div>
      </div>
    </IqCard>
  );
}
