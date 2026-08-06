import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
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

function useTourSteps(): TourStep[] {
  const { t } = useTranslation();
  return (["flow", "metrics", "heatmap"] as const).map((target) => ({
    target,
    title: t(`routes.rotation.tour.${target}.title`),
    body: t(`routes.rotation.tour.${target}.body`),
  }));
}

function RotationPage() {
  const { t } = useTranslation();
  const rotation = useRotation();
  const sectors = useSectors();
  const tour = useProductTour(TOUR_SEEN_KEY);
  const tourSteps = useTourSteps();

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <PageHeader
        eyebrow={t("routes.rotation.eyebrow")}
        title={t("routes.rotation.title")}
        subtitle={t("routes.rotation.subtitle")}
        action={<HelpButton onClick={tour.start} />}
      />

      <div data-tour="flow">
        {rotation.data ? <RotationFlow data={rotation.data} /> : <SkeletonCard height={140} />}
      </div>

      <div data-tour="metrics" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {rotation.data ? (
          <>
            <MetricCard
              label={t("routes.rotation.flowStrength")}
              accent={
                rotation.data.strength === "High"
                  ? "bullish"
                  : rotation.data.strength === "Medium"
                    ? "warning"
                    : "neutral"
              }
              value={rotation.data.strength}
              footerLeft={t("routes.rotation.signal")}
              footerRight={
                rotation.data.confidence >= 70 ? (
                  <span className="text-bullish">{t("routes.rotation.persistent")}</span>
                ) : (
                  <span className="text-warning">{t("routes.rotation.unstable")}</span>
                )
              }
            />
            <MetricCard
              label={
                <span title={t("routes.rotation.rotationConfidenceTooltip")}>
                  {t("routes.rotation.rotationConfidence")}
                </span>
              }
              accent="info"
              value={<span className="num">{rotation.data.confidence}%</span>}
              footerLeft={t("routes.rotation.rankAgreement")}
              footerRight={`ρ ${rotation.data.rankAgreement >= 0 ? "+" : ""}${rotation.data.rankAgreement}`}
            />
            <MetricCard
              label={t("routes.rotation.winningSector")}
              accent="bullish"
              value={rotation.data.winning}
              footerLeft={t("routes.rotation.avg24h")}
              footerRight={
                <span className="num text-bullish">
                  {rotation.data.winningChange !== undefined
                    ? `${rotation.data.winningChange >= 0 ? "+" : ""}${rotation.data.winningChange}%`
                    : "—"}
                </span>
              }
            />
            <MetricCard
              label={t("routes.rotation.losingSector")}
              accent="bearish"
              value={rotation.data.losing}
              footerLeft={t("routes.rotation.avg24h")}
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

      <ProductTour steps={tourSteps} open={tour.open && !!rotation.data} onClose={tour.close} />
    </div>
  );
}
