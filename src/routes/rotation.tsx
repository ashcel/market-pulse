import { createFileRoute } from "@tanstack/react-router";
import { useRotation, useSectors } from "@/hooks/queries";
import { PageHeader } from "@/components/iq/page-header";
import { RotationFlow } from "@/components/iq/rotation-flow";
import { Heatmap } from "@/components/iq/heatmap";
import { MetricCard } from "@/components/iq/metric-card";
import { SkeletonCard } from "@/components/iq/skeletons";

export const Route = createFileRoute("/rotation")({
  head: () => ({
    meta: [
      { title: "Capital Rotation — IQ" },
      {
        name: "description",
        content: "Where money is flowing across sectors and asset classes today.",
      },
      { property: "og:title", content: "Capital Rotation — IQ" },
      { property: "og:description", content: "Follow the smart money across sectors." },
    ],
  }),
  component: RotationPage,
});

function RotationPage() {
  const rotation = useRotation();
  const sectors = useSectors();

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <PageHeader
        eyebrow="Rotation"
        title="Capital Rotation"
        subtitle="Where money is moving right now."
      />

      {rotation.data ? <RotationFlow data={rotation.data} /> : <SkeletonCard height={140} />}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {rotation.data ? (
          <>
            <MetricCard
              label="Flow Strength"
              accent={
                rotation.data.strength === "High"
                  ? "bullish"
                  : rotation.data.strength === "Medium"
                    ? "warning"
                    : "neutral"
              }
              value={rotation.data.strength}
              footerLeft="Signal"
              footerRight={
                rotation.data.confidence >= 70 ? (
                  <span className="text-bullish">Persistent</span>
                ) : (
                  <span className="text-warning">Unstable</span>
                )
              }
            />
            <MetricCard
              label="Rotation Confidence"
              accent="info"
              value={<span className="num">{rotation.data.confidence}%</span>}
              footerLeft="24h vs 7d rank agreement"
              footerRight="RotationModel v1"
            />
            <MetricCard
              label="Winning Sector"
              accent="bullish"
              value={rotation.data.winning}
              footerLeft="Avg 24h"
              footerRight={
                <span className="num text-bullish">
                  {rotation.data.winningChange !== undefined
                    ? `${rotation.data.winningChange >= 0 ? "+" : ""}${rotation.data.winningChange}%`
                    : "—"}
                </span>
              }
            />
            <MetricCard
              label="Losing Sector"
              accent="bearish"
              value={rotation.data.losing}
              footerLeft="Avg 24h"
              footerRight={
                <span className="num text-bearish">
                  {rotation.data.losingChange !== undefined
                    ? `${rotation.data.losingChange >= 0 ? "+" : ""}${rotation.data.losingChange}%`
                    : "—"}
                </span>
              }
            />
          </>
        ) : (
          Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
        )}
      </div>

      {sectors.data ? <Heatmap sectors={sectors.data} /> : <SkeletonCard height={240} />}
    </div>
  );
}
