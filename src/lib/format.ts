export function formatUnits(value: number) {
  if (!Number.isFinite(value)) return "n/a";
  if (value >= 100) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (value >= 1) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

export function formatMoney(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  const abs = Math.abs(value);
  if (abs >= 1000) {
    return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }
  if (abs >= 1) {
    return `$${value.toLocaleString(undefined, { maximumFractionDigits: abs >= 10 ? 3 : 5 })}`;
  }
  // Sub-dollar prices (DOGE, PEPE): fixed decimals would collapse nearby
  // levels into the same string — keep significant digits instead.
  return `$${value.toLocaleString(undefined, { maximumSignificantDigits: 5 })}`;
}

export function formatEntryRange(low: number, high: number): string {
  if (Math.abs(low - high) < 1e-9) return formatMoney(low);
  return `${formatMoney(low)} – ${formatMoney(high)}`;
}
