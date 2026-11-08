/** Distances shown in the unit chosen in Settings (app.distanceUnit): miles unless kilometres. */
export type DistanceUnit = "mi" | "km";

const KM_PER_MI = 1.609344;

const unitOf = (u: string): DistanceUnit => (u === "km" ? "km" : "mi");

export function inUnit(km: number, unit: string): number {
  return Math.round(unitOf(unit) === "mi" ? km / KM_PER_MI : km);
}

export function fmtDistance(km: number, unit: string): string {
  return `${inUnit(km, unit).toLocaleString("en-US")} ${unitOf(unit)}`;
}
