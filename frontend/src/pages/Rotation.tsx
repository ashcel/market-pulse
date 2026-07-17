import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function Rotation() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Rotation</h1>
        <p className="text-sm text-muted-foreground mt-1">Capital rotation & sector flows</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Sector Rotation</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Rotation data loading...</p>
        </CardContent>
      </Card>
    </div>
  );
}