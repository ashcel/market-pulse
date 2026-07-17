import { useParams } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function TokenDetail() {
  const { symbol } = useParams();

  return (
    <div className="p-6 space-y-6">
      {/* Token Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{symbol}</h1>
          <span className="text-sm text-muted-foreground">1 BTC = $67,432.10</span>
        </div>
        <div className="text-right">
          <div className="text-2xl font-mono num">$67,432.10</div>
          <div className="text-sm font-mono num text-bullish">+2.34%</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Chart */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Price Chart</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[400px] flex items-center justify-center border border-border/50 rounded-lg bg-surface">
              <span className="text-muted-foreground">Chart loading...</span>
            </div>
          </CardContent>
        </Card>

        {/* Signal Panel */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Signal</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Setup</span>
                <span className="text-sm font-medium text-bullish">Bullish FVG</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Decision</span>
                <span className="text-sm font-medium text-info">Bounce</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Confidence</span>
                <span className="text-sm font-mono num text-bullish">78%</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Regime</span>
                <span className="text-sm font-medium">Trending</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Risk Plan</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Entry</span><span className="font-mono num">$67,200</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Stop</span><span className="font-mono num text-bearish">$66,500</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Target 1</span><span className="font-mono num text-bullish">$68,500</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Target 2</span><span className="font-mono num text-bullish">$69,800</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">R:R</span><span className="font-mono num">1:2.4</span></div>
            </CardContent>
          </Card>

          <div className="flex gap-2">
            <Button className="flex-1">Run Analysis</Button>
            <Button variant="outline" className="flex-1">Invalidation</Button>
          </div>
        </div>
      </div>
    </div>
  );
}