import { cn } from "@/lib/utils";
import type { RotationData } from "@/lib/types";
import { IqCard } from "./iq-card";
import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";

export function RotationFlow({ data, className }: { data: RotationData; className?: string }) {
  return (
    <IqCard className={cn("flex flex-col gap-6", className)}>
      <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
        {data.flow.map((node, i) => (
          <div key={node} className="flex items-center gap-2 sm:gap-3">
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: i * 0.05 }}
              className={cn(
                "flex min-w-[80px] flex-col items-center justify-center rounded-lg border border-border bg-surface px-3 py-3",
                i === 0 && "border-info/40 bg-info-soft",
                i === data.flow.length - 1 && "border-warning/40 bg-warning-soft",
              )}
            >
              <div className="text-sm font-semibold">{node}</div>
              {data.legs[i] && (
                <div className="mt-1 num text-[10px] text-muted-foreground">
                  {data.legs[i].strength}%
                </div>
              )}
            </motion.div>
            {i < data.flow.length - 1 && (
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
        ))}
      </div>
    </IqCard>
  );
}
