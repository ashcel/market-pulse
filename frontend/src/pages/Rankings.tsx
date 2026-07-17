import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const tokens = [
  { symbol: "BTC", name: "Bitcoin", price: 67432.10, change24h: 2.34, volume: 28.5, score: 78 },
  { symbol: "ETH", name: "Ethereum", price: 3456.78, change24h: -1.23, volume: 15.2, score: 65 },
  { symbol: "SOL", name: "Solana", price: 145.23, change24h: 5.67, volume: 8.1, score: 82 },
  { symbol: "BNB", name: "BNB", price: 578.90, change24h: 0.45, volume: 3.2, score: 71 },
  { symbol: "XRP", name: "XRP", price: 0.6234, change24h: -0.89, volume: 2.8, score: 55 },
  { symbol: "ADA", name: "Cardano", price: 0.45, change24h: 1.23, volume: 1.5, score: 60 },
  { symbol: "DOGE", name: "Dogecoin", price: 0.12, change24h: -2.1, volume: 0.8, score: 45 },
  { symbol: "AVAX", name: "Avalanche", price: 28.45, change24h: 3.21, volume: 1.2, score: 68 },
];

export default function Rankings() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Rankings</h1>
        <p className="text-sm text-muted-foreground mt-1">Top assets ranked by signal score</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>All Tokens</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 font-medium text-muted-foreground">#</th>
                <th className="text-left py-2 font-medium text-muted-foreground">Name</th>
                <th className="text-right py-2 font-medium text-muted-foreground">Price</th>
                <th className="text-right py-2 font-medium text-muted-foreground">24h</th>
                <th className="text-right py-2 font-medium text-muted-foreground hidden md:table-cell">Volume</th>
                <th className="text-right py-2 font-medium text-muted-foreground hidden md:table-cell">Score</th>
              </tr>
            </thead>
            <tbody>
              {tokens.sort((a, b) => b.score - a.score).map((t, i) => (
                <tr key={t.symbol} className="border-b border-border/50 hover:bg-muted/30 transition-colors cursor-pointer">
                  <td className="py-3 text-muted-foreground">{i + 1}</td>
                  <td className="py-3">
                    <a href={`/token/${t.symbol}`} className="font-medium hover:text-info transition-colors">
                      {t.symbol}
                    </a>
                    <span className="text-muted-foreground ml-2 text-xs">{t.name}</span>
                  </td>
                  <td className="py-3 text-right font-mono num">${t.price.toLocaleString()}</td>
                  <td className={`py-3 text-right font-mono num ${t.change24h >= 0 ? 'text-bullish' : 'text-bearish'}`}>
                    {t.change24h >= 0 ? '+' : ''}{t.change24h}%
                  </td>
                  <td className="py-3 text-right font-mono num text-muted-foreground hidden md:table-cell">${t.volume}B</td>
                  <td className="py-3 text-right hidden md:table-cell">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                      t.score >= 70 ? 'bg-bullish-soft text-bullish' : 
                      t.score >= 50 ? 'bg-warning-soft text-warning' : 
                      'bg-bearish-soft text-bearish'
                    }`}>{t.score}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}