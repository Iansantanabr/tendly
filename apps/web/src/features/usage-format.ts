/**
 * A change against the previous period, short enough to sit under a figure:
 * one decimal below 10%, whole percents up to 999%, and past that a multiplier
 * (+16408% reads as ×165), since a four-digit percent says nothing more.
 * Falls use a true minus sign. Nothing to compare gives an empty string.
 */
export function formatChange(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return '';
  const size = Math.abs(value);
  if (value >= 999.5) return `×${Math.round(1 + value / 100)}`;
  const digits = size < 9.95 ? (Math.round(size * 10) / 10).toString() : String(Math.round(size));
  if (digits === '0') return '0%';
  return `${value < 0 ? '−' : '+'}${digits}%`;
}
