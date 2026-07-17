import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const pillars = [
  { name: "Trend", score: 72, max: 100 },
  { name: "Momentum", score: 58, max: 100 },
  { name: "Breadth", score: 45, max: 100 },
  { name: "Volatility", score: 65, max: 100 },
  { name: "Participation", score: 51, max: 100 },
];

export default function Regime() {
  const avg = pillars.reduce((s, p) => s + p.score, 0) / pillars.length;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Market Regime</h1>
      </div>

      {/* Regime Gauge */}
      <Card>
        <CardHeader>
          <CardTitle>Overall Regime Score</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <div className="relative w-32 h-32">
              <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="42" fill="none" stroke="oklch(1 0 0 / 0.07)" strokeWidth="8" />
                <circle cx="50" cy="50" r="42" fill="none" stroke="oklch(0.7 0.16 245)" strokeWidth="8"
                  strokeDasharray={`${(avg / 100) * 264} 264`} strokeLinecap="round" />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-2xl font-bold font-mono num">{avg.toFixed(0)}</span>
              </div>
            </div>
            <div>
              <div className="text-lg font-medium">Mixed Regime</div>
              <p className="text-sm text-muted-foreground">Neutral trending with moderate participation</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Pillar Breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {pillars.map((p) => (
          <Card key={p.name}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">{p.name}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between mb-2">
                <span className="text-2xl font-bold font-mono num">{p.score}</span>
                <span className="text-xs text-muted-foreground">{p.score >= 60 ? 'Strong' : p.score >= 40 ? 'Moderate' : 'Weak'}</span>
              </div>
              <div className="w-full h-2 bg-border rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all bg-info" style={{ width: `${(p.score / p.max) * 100}%` }} />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}