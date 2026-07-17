import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function Technical() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Technical</h1>
        <p className="text-sm text-muted-foreground mt-1">Technical analysis & chart patterns</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Technical Overview</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Technical analysis data loading...</p>
        </CardContent>
      </Card>
    </div>
  );
}