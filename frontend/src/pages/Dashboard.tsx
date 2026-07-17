import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function Dashboard() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">Market overview & key metrics</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Market Cap</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono num">$3.42T</div>
            <p className="text-xs text-bullish mt-1">+2.3%</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">BTC Dominance</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono num">54.8%</div>
            <p className="text-xs text-bearish mt-1">-0.4%</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">24h Volume</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono num">$128.5B</div>
            <p className="text-xs text-muted-foreground mt-1">Uniswap + CEX</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Top Movers</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 font-medium text-muted-foreground">Symbol</th>
                <th className="text-right py-2 font-medium text-muted-foreground">Price</th>
                <th className="text-right py-2 font-medium text-muted-foreground">24h</th>
                <th className="text-right py-2 font-medium text-muted-foreground hidden md:table-cell">Volume</th>
              </tr>
            </thead>
            <tbody>
              {["BTC", "ETH", "SOL", "BNB", "XRP"].map((sym) => (
                <tr key={sym} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                  <td className="py-3 font-medium">{sym}</td>
                  <td className="py-3 text-right font-mono num">${(Math.random() * 50000 + 100).toFixed(2)}</td>
                  <td className="py-3 text-right font-mono num text-bullish">+{(Math.random() * 5).toFixed(2)}%</td>
                  <td className="py-3 text-right font-mono num text-muted-foreground hidden md:table-cell">${(Math.random() * 50 + 1).toFixed(1)}B</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}