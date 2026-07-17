import { createFileRoute } from "@tanstack/react-router";
import { useRotation, useSectors } from "@/hooks/queries";
import { PageHeader } from "@/components/features/page-header";
import { RotationFlow } from "@/components/features/rotation-flow";
import { Heatmap } from "@/components/features/heatmap";
import { MetricCard } from "@/components/features/metric-card";
import { SkeletonCard } from "@/components/features/skeletons";
import {
  HelpButton,
  ProductTour,
  useProductTour,
  type TourStep,
} from "@/components/features/product-tour";

export const Route = createFileRoute("/rotation")({
  head: () => ({
    meta: [
      { title: "Capital Rotation — Market Pulse" },
      {
        name: "description",
        content: "Where money is flowing across sectors and asset classes today.",
      },
      { property: "og:title", content: "Capital Rotation — Market Pulse" },
      { property: "og:description", content: "Follow the smart money across sectors." },
    ],
  }),
  component: RotationPage,
});

const TOUR_SEEN_KEY = "iq-rotation-tour-v1";

const TOUR_STEPS: TourStep[] = [
  {
    target: "flow",
    title: "The rotation path",
    body: "Sectors ordered from where money is leaving to where it's arriving, based on 24-hour performance. Capital rarely exits crypto — it rotates. Riding the sector it's rotating into is usually easier than fighting the one it's leaving.",
  },
  {
    target: "metrics",
    title: "Flow quality",
    body: "How strong the rotation is, how confident the model is that it's real (24h and 7d rankings agreeing), and the winning and losing sectors with their average 24-hour move. A high-confidence, persistent flow is far more tradeable than an unstable one.",
  },
  {
    target: "heatmap",
    title: "Sector heatmap",
    body: "Every sector broken down into its individual assets, coloured by 24-hour performance — so you can see whether a sector's move is broad or carried by a single token.",
  },
];

function RotationPage() {
  const rotation = useRotation();
  const sectors = useSectors();
  const tour = useProductTour(TOUR_SEEN_KEY);

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <PageHeader
        eyebrow="Rotation"
        title="Capital Rotation"
        subtitle="Where money is moving right now."
        action={<HelpButton onClick={tour.start} />}
      />

      <div data-tour="flow">
        {rotation.data ? <RotationFlow data={rotation.data} /> : <SkeletonCard height={140} />}
      </div>

      <div data-tour="metrics" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
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
              label={
                <span title="Rescaled from the real 24h-vs-7d sector rank correlation (shown as ρ below) — not an independently calibrated probability.">
                  Rotation Confidence
                </span>
              }
              accent="info"
              value={<span className="num">{rotation.data.confidence}%</span>}
              footerLeft="24h vs 7d rank agreement"
              footerRight={`ρ ${rotation.data.rankAgreement >= 0 ? "+" : ""}${rotation.data.rankAgreement}`}
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

      <div data-tour="heatmap">
        {sectors.data ? <Heatmap sectors={sectors.data} /> : <SkeletonCard height={240} />}
      </div>

      <ProductTour steps={TOUR_STEPS} open={tour.open && !!rotation.data} onClose={tour.close} />
    </div>
  );
}
