import { AlertTriangle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { useTrustState } from "@/hooks/useTrustState";

export function TrustIndicator() {
  const trust = useTrustState();
  const failures = Object.values(trust.details).filter((detail) => detail.status !== "healthy");
  return (
    <div className="flex items-center gap-1.5" title={failures.map((detail) => detail.reason).join("; ")}>
      {trust.environment !== "live" && <Badge variant="outline" className="text-[9px] uppercase text-muted-foreground">{trust.environment}</Badge>}
      {failures.length > 0 && <span className="flex items-center gap-1 text-[10px] text-warning"><AlertTriangle className="h-3.5 w-3.5" /><span className="hidden max-w-52 truncate md:inline">{failures[0].reason}</span></span>}
    </div>
  );
}
