import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function News() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">News</h1>
        <p className="text-sm text-muted-foreground mt-1">Market news & catalyst events</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Latest News</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">News feed loading...</p>
        </CardContent>
      </Card>
    </div>
  );
}