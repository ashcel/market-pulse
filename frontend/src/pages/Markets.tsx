import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function Markets() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Markets</h1>
        <p className="text-sm text-muted-foreground mt-1">Spot & perpetual markets overview</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>All Markets</CardTitle>
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
              {["BTC/USDT", "ETH/USDT", "SOL/USDT", "BNB/USDT", "XRP/USDT", "ADA/USDT", "DOGE/USDT", "AVAX/USDT"].map((sym) => (
                <tr key={sym} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                  <td className="py-3">
                    <a href={`/token/${sym.split("/")[0]}`} className="font-medium hover:text-info transition-colors">{sym}</a>
                  </td>
                  <td className="py-3 text-right font-mono num">${(Math.random() * 50000 + 0.01).toFixed(2)}</td>
                  <td className={`py-3 text-right font-mono num ${Math.random() > 0.5 ? 'text-bullish' : 'text-bearish'}`}>
                    {(Math.random() * 8 - 3).toFixed(2)}%
                  </td>
                  <td className="py-3 text-right font-mono num text-muted-foreground hidden md:table-cell">${(Math.random() * 30 + 0.5).toFixed(1)}B</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}