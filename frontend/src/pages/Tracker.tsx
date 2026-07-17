import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function Tracker() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Tracker</h1>
        <p className="text-sm text-muted-foreground mt-1">Tracked signals & positions</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Active Trackers</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Tracked signals loading...</p>
        </CardContent>
      </Card>
    </div>
  );
}