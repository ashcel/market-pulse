import { useQuery } from "@tanstack/react-query";

import { fetchFundingBacktest, type FundingBacktestResult } from "@/lib/engine/funding-history";

/**
 * On-demand funding-harvest backtest for one symbol. Deliberately has NO
 * refetchInterval and a 10-min staleTime that mirrors the server-side cache:
 * a backtest fans out to ~100 kline calls, so the UI mounts this behind an
 * explicit user action (`enabled`) and never polls it.
 */
export function useFundingBacktest(symbol: string, enabled: boolean) {
  return useQuery<FundingBacktestResult>({
    queryKey: ["funding-backtest", symbol.toUpperCase()],
    queryFn: () => fetchFundingBacktest(symbol),
    enabled: enabled && symbol.length > 0,
    staleTime: 10 * 60 * 1000,
  });
}
