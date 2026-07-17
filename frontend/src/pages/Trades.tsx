import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const trades = [
  { id: "1", symbol: "BTC", direction: "long", entry: 65200, exit: 67432, pnl: "+$2,232", status: "closed", date: "2026-07-15" },
  { id: "2", symbol: "ETH", direction: "short", entry: 3600, exit: 3456, pnl: "+$144", status: "closed", date: "2026-07-14" },
  { id: "3", symbol: "SOL", direction: "long", entry: 138, exit: null, pnl: "—", status: "open", date: "2026-07-16" },
];

export default function Trades() {
  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Trade Journal</h1>

      <Card>
        <CardHeader>
          <CardTitle>Recent Trades</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 font-medium text-muted-foreground">Date</th>
                <th className="text-left py-2 font-medium text-muted-foreground">Symbol</th>
                <th className="text-left py-2 font-medium text-muted-foreground">Direction</th>
                <th className="text-right py-2 font-medium text-muted-foreground">Entry</th>
                <th className="text-right py-2 font-medium text-muted-foreground">Exit</th>
                <th className="text-right py-2 font-medium text-muted-foreground">PnL</th>
                <th className="text-right py-2 font-medium text-muted-foreground">Status</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                  <td className="py-3 text-muted-foreground">{t.date}</td>
                  <td className="py-3 font-medium">{t.symbol}</td>
                  <td className="py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                      t.direction === 'long' ? 'bg-bullish-soft text-bullish' : 'bg-bearish-soft text-bearish'
                    }`}>{t.direction}</span>
                  </td>
                  <td className="py-3 text-right font-mono num">${t.entry.toLocaleString()}</td>
                  <td className="py-3 text-right font-mono num">{t.exit ? `$${t.exit.toLocaleString()}` : '—'}</td>
                  <td className={`py-3 text-right font-mono num ${t.pnl.startsWith('+') ? 'text-bullish' : t.pnl === '—' ? 'text-muted-foreground' : 'text-bearish'}`}>{t.pnl}</td>
                  <td className="py-3 text-right">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                      t.status === 'closed' ? 'bg-info-soft text-info' : 'bg-warning-soft text-warning'
                    }`}>{t.status}</span>
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