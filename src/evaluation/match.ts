// Matching detected episodes against the oracle, and the confusion-matrix definitions.
// All definitions are fixed and versioned (MATCHING_RULES_VERSION) and recorded with every evaluation.
import type { OracleEvent } from "./oracle";

export const MATCHING_RULES_VERSION = "match/1.0.0";

export interface EvalAlarm { day: number; windowStart: number; windowEnd: number; involved: string[] }
export interface EvalEpisode {
  id: string;
  syndrome: string;
  firstAlarmDay: number;
  lastAlarmDay: number;
  involved: string[];
  alarms: EvalAlarm[];
  score?: number;
  priority?: string;
}

export interface MatchRules {
  /** Tolerance after the event end for an alarm to count as in-time. */
  tauDays: number;
  /** Longest detector window: alarms may lag an event by up to this long and still overlap it. */
  maxWindow: number;
  firstEvalDay: number;
  lastDay: number;
  syndromes: string[];
  allBlocks: string[];
}

export interface EventResult {
  id: string;
  kind: OracleEvent["kind"];
  variant?: string;
  syndrome: string;
  shape: string;
  multiplier: number | null;
  durationDays: number;
  realizedReports: number;
  evaluable: boolean;
  /** true cluster: credited alarm on or before end + tau.  decoy: some episode alerted on it (alerted = false is the GOOD outcome). */
  detected: boolean;
  lateDetected: boolean;
  creditedDay: number | null;
  delayDays: number | null;
  normalizedDelay: number | null;
  episodes: number; // crediting episodes (fragmentation)
  localization: { jaccard: number; exact: boolean; overreach: number; missing: number } | null;
  alerted: boolean; // decoys
}

export interface EpisodeLabel {
  id: string;
  label: "TP" | "FP";
  fpKind: "decoy" | "spurious" | null;
  creditedEvents: string[];
  priority?: string;
  score?: number;
}

export interface RunEvaluation {
  events: EventResult[];
  episodes: EpisodeLabel[];
  trueClusters: number;
  detected: number;
  detectedEvaluable: number;
  evaluableClusters: number;
  lateOnly: number;
  tpEpisodes: number;
  fpEpisodes: number;
  decoyFalseAlerts: number;
  decoys: number;
  fragments: number; // extra crediting episodes beyond the first, per detected event
  units: { positive: number; positiveAlarmed: number; negative: number; falsePositive: number; decoyZoneAlarmed: number };
}

const inter = (a: readonly string[], b: readonly string[]) => a.some((x) => b.includes(x));

/** Earliest in-rule alarm day of `ep` crediting `ev`, or null. Union of overlapped event days must reach min(2, duration). */
export function creditedDay(ep: EvalEpisode, ev: OracleEvent, rules: MatchRules): number | null {
  if (ep.syndrome !== ev.syndrome) return null;
  const need = Math.min(2, ev.durationDays);
  const covered = new Set<number>();
  for (const a of [...ep.alarms].sort((x, y) => x.day - y.day)) {
    if (!inter(a.involved, ev.blocks)) continue;
    for (let d = Math.max(a.windowStart, ev.startDay); d <= Math.min(a.windowEnd, ev.endDay); d++) covered.add(d);
    if (a.day >= ev.startDay + 1 && a.day <= ev.endDay + rules.maxWindow && covered.size >= need) return a.day;
  }
  return null;
}

/** Loose overlap (decoy labelling): same syndrome, block overlap, an alarm window touching [start, end + maxWindow]. */
function looselyMatches(ep: EvalEpisode, ev: OracleEvent, rules: MatchRules): boolean {
  return ep.syndrome === ev.syndrome && ep.alarms.some((a) => inter(a.involved, ev.blocks) && a.windowEnd >= ev.startDay && a.windowStart <= ev.endDay + rules.maxWindow);
}

export function evaluateRun(oracle: readonly OracleEvent[], episodes: readonly EvalEpisode[], rules: MatchRules): RunEvaluation {
  const trueEvents = oracle.filter((e) => e.kind === "true_cluster");
  const decoys = oracle.filter((e) => e.kind === "decoy_reporting_artifact");

  const events: EventResult[] = [];
  const creditedBy = new Map<string, string[]>(); // episode id -> credited true events
  for (const ev of trueEvents) {
    const crediting: Array<{ ep: EvalEpisode; day: number }> = [];
    for (const ep of episodes) {
      const day = creditedDay(ep, ev, rules);
      if (day !== null) crediting.push({ ep, day });
    }
    crediting.sort((a, b) => a.day - b.day);
    const first = crediting[0]?.day ?? null;
    for (const c of crediting) creditedBy.set(c.ep.id, [...(creditedBy.get(c.ep.id) ?? []), ev.id]);
    const detected = first !== null && first <= ev.endDay + rules.tauDays;
    let localization: EventResult["localization"] = null;
    if (crediting.length > 0) {
      const found = [...new Set(crediting.flatMap((c) => c.ep.involved))];
      const hit = found.filter((b) => ev.blocks.includes(b)).length;
      const union = new Set([...found, ...ev.blocks]).size;
      localization = {
        jaccard: union ? hit / union : 0,
        exact: found.length === ev.blocks.length && hit === ev.blocks.length,
        overreach: found.length - hit,
        missing: ev.blocks.length - hit,
      };
    }
    events.push({
      id: ev.id, kind: ev.kind, variant: ev.variant, syndrome: ev.syndrome, shape: ev.shape, multiplier: ev.multiplier,
      durationDays: ev.durationDays, realizedReports: ev.realizedReports, evaluable: ev.evaluable, detected, lateDetected: first !== null && !detected,
      creditedDay: first, delayDays: first === null ? null : first - ev.startDay,
      normalizedDelay: first === null ? null : (first - ev.startDay) / ev.durationDays,
      episodes: crediting.length, localization, alerted: false,
    });
  }

  // An episode already credited to a TRUE cluster is explained by that cluster; it cannot also be a decoy false alert.
  let decoyFalseAlerts = 0;
  for (const ev of decoys) {
    const alerted = episodes.some((ep) => !creditedBy.has(ep.id) && looselyMatches(ep, ev, rules));
    if (alerted) decoyFalseAlerts++;
    events.push({
      id: ev.id, kind: ev.kind, variant: ev.variant, syndrome: ev.syndrome, shape: ev.shape, multiplier: ev.multiplier,
      durationDays: ev.durationDays, realizedReports: ev.realizedReports, evaluable: false, detected: false, lateDetected: false, creditedDay: null,
      delayDays: null, normalizedDelay: null, episodes: 0, localization: null, alerted,
    });
  }

  const labels: EpisodeLabel[] = episodes.map((ep) => {
    const credited = creditedBy.get(ep.id) ?? [];
    if (credited.length > 0) return { id: ep.id, label: "TP", fpKind: null, creditedEvents: credited, priority: ep.priority, score: ep.score };
    const decoy = decoys.some((d) => looselyMatches(ep, d, rules));
    return { id: ep.id, label: "FP", fpKind: decoy ? "decoy" : "spurious", creditedEvents: [], priority: ep.priority, score: ep.score };
  });

  // ---- unit grid (block x syndrome x day) ----------------------------------------------------
  const key = (b: string, s: string, d: number) => `${b}|${s}|${d}`;
  const positive = new Set<string>();
  const grace = new Set<string>();
  for (const ev of trueEvents) {
    for (const b of ev.blocks) {
      for (let d = ev.startDay; d <= Math.min(rules.lastDay, ev.endDay + rules.maxWindow); d++) {
        if (d < rules.firstEvalDay) continue;
        (d <= ev.endDay ? positive : grace).add(key(b, ev.syndrome, d));
      }
    }
  }
  const decoyZone = new Set<string>();
  for (const ev of decoys) for (const b of ev.blocks) for (let d = ev.startDay; d <= Math.min(rules.lastDay, ev.endDay + rules.maxWindow); d++) decoyZone.add(key(b, ev.syndrome, d));

  const alarmed = new Set<string>();
  for (const ep of episodes) for (const a of ep.alarms) for (const b of a.involved) if (a.day >= rules.firstEvalDay && a.day <= rules.lastDay) alarmed.add(key(b, ep.syndrome, a.day));

  const totalUnits = rules.allBlocks.length * rules.syndromes.length * (rules.lastDay - rules.firstEvalDay + 1);
  let positiveAlarmed = 0;
  let falsePositive = 0;
  let decoyZoneAlarmed = 0;
  for (const u of alarmed) {
    if (positive.has(u)) positiveAlarmed++;
    else if (!grace.has(u)) {
      falsePositive++;
      if (decoyZone.has(u)) decoyZoneAlarmed++;
    }
  }
  const negative = totalUnits - positive.size - grace.size;

  const tpEpisodes = labels.filter((l) => l.label === "TP").length;
  const detectedEvents = events.filter((e) => e.kind === "true_cluster" && e.detected);
  return {
    events, episodes: labels,
    trueClusters: trueEvents.length,
    detected: detectedEvents.length,
    detectedEvaluable: detectedEvents.filter((e) => e.evaluable).length,
    evaluableClusters: trueEvents.filter((e) => e.evaluable).length,
    lateOnly: events.filter((e) => e.kind === "true_cluster" && e.lateDetected).length,
    tpEpisodes, fpEpisodes: labels.length - tpEpisodes,
    decoyFalseAlerts, decoys: decoys.length,
    fragments: events.filter((e) => e.kind === "true_cluster" && e.episodes > 1).reduce((a, e) => a + e.episodes - 1, 0),
    units: { positive: positive.size, positiveAlarmed, negative, falsePositive, decoyZoneAlarmed },
  };
}
