// Transparent signal score. EVERY term is a documented, bounded, measurable quantity.
//
//   score = 100 x Q x ( wD*D + wP*P + wV*V + wG*G + wS*S )
//
// The score is a RANKING / PRIORITY aid. It is not a probability, not P(real event), not a probability of an
// outbreak and not a diagnostic confidence. `confidence` is likewise an evidence-SUFFICIENCY index
// (data quality x volume), never the probability that a signal is real.
import { clamp, round } from "./numerics";
import type { DetectorConfig, ScoreComponents, ScoreResult, WindowTest } from "./types";

export const SCORE_FORMULA_VERSION = "score/1.0.0";

export function scoreAlarm(cfg: DetectorConfig, t: WindowTest, involvedBlocks: number, blocksInDistrict: number): ScoreResult {
  const s = cfg.score;

  // D: deviation from baseline = half statistical evidence (-log10 p), half effect size (log2 ratio).
  const negLogP = -Math.log10(Math.max(t.p, 1e-300));
  const deviation = 0.5 * clamp((negLogP - s.deviationPMinLog10) / s.deviationPSpanLog10, 0, 1)
    + 0.5 * clamp(Math.log2(Math.max(t.ratio, 1e-9)) / s.ratioSpanLog2, 0, 1);

  // P: persistence = share of window days that were elevated.
  const persistence = t.w > 0 ? clamp(t.elevatedDays / t.w, 0, 1) : 0;

  // V: report volume (log scale, saturating at volumeReference reports).
  const volume = clamp(Math.log10(Math.max(t.observed, 1)) / Math.log10(s.volumeReference), 0, 1);

  // G: geographic concentration. 1 = a single block carries the signal; 0 = every block in the district.
  // A district with one (or zero) eligible block has no spread to measure: treat it as fully concentrated.
  const nBlocks = Math.max(0, Math.floor(blocksInDistrict));
  const nInv = clamp(Math.floor(involvedBlocks), 1, Math.max(1, nBlocks));
  const geographic = nBlocks <= 1 ? 1 : clamp(1 - (nInv - 1) / (nBlocks - 1), 0, 1);

  // S: source diversity = effective number of source types (1/HHI), saturating at effectiveSourcesSaturation.
  const total = t.sourceCounts.reduce((a, b) => a + b, 0);
  let effective = 0;
  if (total > 0) {
    const hhi = t.sourceCounts.reduce((a, c) => a + (c / total) ** 2, 0);
    effective = hhi > 0 ? 1 / hhi : 0;
  }
  const sourceMix = s.effectiveSourcesSaturation > 1 ? clamp((effective - 1) / (s.effectiveSourcesSaturation - 1), 0, 1) : 1;

  // Q: data-quality multiplier.
  const qualityParts = {
    history: clamp(t.historyDays / s.qualityHistoryReferenceDays, 0, 1),
    bulk: clamp(1 - t.bulkShare, 0, 1),
    severity: clamp(1 - 0.5 * t.unknownSeverityShare, 0, 1),
  };
  const quality = qualityParts.history * qualityParts.bulk * qualityParts.severity;

  const w = s.weights;
  const raw = quality * (w.deviation * deviation + w.persistence * persistence + w.volume * volume + w.geographic * geographic + w.sourceMix * sourceMix);
  const score = round(100 * clamp(raw, 0, 1), 2);
  const components: ScoreComponents = {
    deviation: round(deviation, 4), persistence: round(persistence, 4), volume: round(volume, 4),
    geographic: round(geographic, 4), sourceMix: round(sourceMix, 4), quality: round(quality, 4),
    qualityParts: { history: round(qualityParts.history, 4), bulk: round(qualityParts.bulk, 4), severity: round(qualityParts.severity, 4) },
    effectiveSources: round(effective, 3), involvedBlocks: nInv, blocksInDistrict: nBlocks,
  };
  return {
    score,
    priority: score >= s.highFrom ? "high" : score >= s.mediumFrom ? "medium" : "low",
    confidence: round(clamp(quality * Math.min(1, t.observed / s.confidenceVolumeReference), 0, 1), 3),
    components,
    formulaVersion: SCORE_FORMULA_VERSION,
  };
}
