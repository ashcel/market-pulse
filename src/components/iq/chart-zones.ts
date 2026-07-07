import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";

/**
 * A horizontal price band drawn from `from` to the pane's right edge.
 * lightweight-charts has no built-in rectangles, so this is rendered by a
 * series primitive on the underlying canvas.
 */
export interface PriceZone {
  priceLow: number;
  priceHigh: number;
  from: Time;
  fill: string;
  border: string;
  label: string;
  labelColor: string;
  /** Which edge of the band the label hugs (default "top"). */
  labelAlign?: "top" | "middle" | "bottom";
}

interface ZoneRect extends Omit<PriceZone, "priceLow" | "priceHigh" | "from"> {
  x: number;
  top: number;
  bottom: number;
}

class ZonesPaneRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly rects: ZoneRect[]) {}

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      for (const rect of this.rects) {
        const width = mediaSize.width - rect.x;
        const height = rect.bottom - rect.top;
        if (width <= 0 || height <= 0) continue;

        context.fillStyle = rect.fill;
        context.fillRect(rect.x, rect.top, width, height);
        context.strokeStyle = rect.border;
        context.lineWidth = 1;
        context.strokeRect(rect.x + 0.5, rect.top + 0.5, width - 1, height - 1);

        if (height >= 14) {
          context.font = "500 9px JetBrains Mono, ui-monospace, monospace";
          context.textBaseline = "top";
          context.fillStyle = rect.labelColor;
          const textY =
            rect.labelAlign === "bottom"
              ? rect.bottom - 13
              : rect.labelAlign === "middle"
                ? (rect.top + rect.bottom) / 2 - 4
                : rect.top + 4;
          context.fillText(rect.label, rect.x + 6, textY);
        }
      }
    });
  }
}

class ZonesPaneView implements IPrimitivePaneView {
  constructor(private readonly source: ZonesPrimitive) {}

  zOrder(): PrimitivePaneViewZOrder {
    return "bottom";
  }

  renderer(): IPrimitivePaneRenderer | null {
    const { chart, series, zones } = this.source;
    if (!chart || !series || zones.length === 0) return null;

    const timeScale = chart.timeScale();
    const visible = timeScale.getVisibleRange();
    if (!visible) return null;

    const rects: ZoneRect[] = [];
    for (const zone of zones) {
      if ((zone.from as number) > (visible.to as number)) continue;
      // Anchor scrolled off-screen to the left: clamp to the pane edge.
      const x = timeScale.timeToCoordinate(zone.from) ?? 0;
      const top = series.priceToCoordinate(zone.priceHigh);
      const bottom = series.priceToCoordinate(zone.priceLow);
      if (top === null || bottom === null) continue;
      const { priceLow: _lo, priceHigh: _hi, from: _from, ...style } = zone;
      rects.push({ ...style, x, top, bottom });
    }
    return rects.length > 0 ? new ZonesPaneRenderer(rects) : null;
  }
}

export class ZonesPrimitive implements ISeriesPrimitive<Time> {
  chart: IChartApi | null = null;
  series: ISeriesApi<SeriesType> | null = null;
  zones: PriceZone[] = [];

  private readonly paneView = new ZonesPaneView(this);
  private requestUpdate: (() => void) | null = null;

  attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  setZones(zones: PriceZone[]): void {
    this.zones = zones;
    this.requestUpdate?.();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.paneView];
  }
}
