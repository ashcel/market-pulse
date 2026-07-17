import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function Settings() {
  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="text-sm font-medium text-muted-foreground block mb-1">Display Name</label>
            <input type="text" className="w-full bg-surface border border-input rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring" placeholder="Your name" />
          </div>
          <div>
            <label className="text-sm font-medium text-muted-foreground block mb-1">Email</label>
            <input type="email" className="w-full bg-surface border border-input rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring" placeholder="you@example.com" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>API Keys</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="text-sm font-medium text-muted-foreground block mb-1">Binance API Key</label>
            <input type="password" className="w-full bg-surface border border-input rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring" placeholder="Enter API key" />
          </div>
          <div>
            <label className="text-sm font-medium text-muted-foreground block mb-1">Bybit API Key</label>
            <input type="password" className="w-full bg-surface border border-input rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring" placeholder="Enter API key" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}