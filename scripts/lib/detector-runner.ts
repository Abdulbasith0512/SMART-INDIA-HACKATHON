// Live detector run against Supabase (service role). Shared by `npm run detect` and `npm run verify:m3`.
// Reads ONLY the deidentified tier (through detection_daily_features), runs the frozen detector, and writes
// provenance + findings + candidates through the invariant-checked upsert function.
import type { SupabaseClient } from "@supabase/supabase-js";
import { execSync } from "node:child_process";
import { DETECTOR_V1, DetectorEngine, configHash, hashFeatureRows, type DetectorConfig, type FeatureRow, type RegionNode, type SourceKey } from "../../src/detection";

export interface LiveRunResult {
  runId: string | null;
  configHash: string;
  inputHash: string;
  inputRows: number;
  episodes: number;
  actions: Record<string, number>;
  findings: number;
  episodeKeys: string[];
  evidenceFloor: number;
}

function codeVersion(): string | null {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

async function must<T>(label: string, p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data as T;
}

export async function loadDetectorInput(db: SupabaseClient, from?: string, to?: string) {
  const settings = await must<{ value_int: number }[]>("privacy settings", db.from("privacy_settings").select("value_int").eq("key", "min_aggregate_cell_size"));
  const privacyK = settings[0]?.value_int ?? 5;

  const regions: RegionNode[] = [];
  for (let a = 0; ; a += 1000) {
    const page = await must<{ id: string; region_type: RegionNode["type"]; parent_region_id: string | null; name: string }[]>(
      "regions", db.from("regions").select("id, region_type, parent_region_id, name").order("id").range(a, a + 999));
    regions.push(...page.map((r) => ({ id: r.id, type: r.region_type, parentId: r.parent_region_id, name: r.name })));
    if (page.length < 1000) break;
  }

  let start = from;
  let end = to;
  if (!start || !end) {
    const first = await must<{ observed_date: string }[]>("first date", db.from("deidentified_observations").select("observed_date").order("observed_date").limit(1));
    const last = await must<{ observed_date: string }[]>("last date", db.from("deidentified_observations").select("observed_date").order("observed_date", { ascending: false }).limit(1));
    if (!first.length) throw new Error("no deidentified observations to analyse");
    start ??= first[0].observed_date;
    end ??= last[0].observed_date;
  }

  const raw = await must<Array<{ region_id: string; date: string; syndrome: string; reports: number; cases: number; unknown_severity: number; by_source: Record<string, number> }>>(
    "features", db.rpc("detection_daily_features", { _from: start, _to: end }));
  const rows: FeatureRow[] = raw.map((r) => ({
    regionId: r.region_id, date: r.date, syndrome: r.syndrome, reports: r.reports, cases: r.cases,
    unknownSeverity: r.unknown_severity, bySource: r.by_source as Partial<Record<SourceKey, number>>,
  }));
  return { input: { rows, regions, startDate: start!, endDate: end!, privacyK }, privacyK };
}

export async function runLiveDetector(db: SupabaseClient, opts: { from?: string; to?: string; dryRun?: boolean; cfg?: DetectorConfig } = {}): Promise<LiveRunResult> {
  const cfg = opts.cfg ?? DETECTOR_V1;
  const { input, privacyK } = await loadDetectorInput(db, opts.from, opts.to);
  const engine = new DetectorEngine(input, cfg);
  const inputHash = hashFeatureRows(input.rows);
  const cfgHash = configHash(cfg);

  const result = engine.replay({ collectFindings: true });
  const episodes = result.state.episodes;
  const base: LiveRunResult = {
    runId: null, configHash: cfgHash, inputHash, inputRows: input.rows.length, episodes: episodes.length, actions: {},
    findings: result.findings.length, episodeKeys: episodes.map((e) => e.key).sort(), evidenceFloor: engine.evidenceFloor,
  };
  if (opts.dryRun) return base;

  const runRow = await must<{ id: string }>("start run", db.from("detector_runs").insert({
    detector_name: "jansanket-detector", detector_version: cfg.version, method_code: cfg.methodCode, config: cfg, config_hash: cfgHash,
    mode: "replay", data_from: input.startDate, data_to: input.endDate, as_of_from: input.startDate, as_of_to: input.endDate,
    input_row_count: input.rows.length, input_hash: inputHash, code_version: codeVersion(), privacy_k_applied: privacyK,
    evidence_floor: engine.evidenceFloor, status: "running",
  }).select("id").single());
  const runId = runRow.id;

  try {
    const findingRows = result.findings.map((f) => ({
      run_id: runId,
      as_of_date: engine.store.dates[f.asOfDay],
      district_id: f.districtId,
      block_ids: f.blocks,
      scope: f.scope,
      syndrome: f.syndrome,
      window_days: f.test.w,
      // privacy: counts below the evidence floor are never stored (the DB enforces this too)
      observed: f.test.observed >= engine.evidenceFloor ? f.test.observed : null,
      expected: Math.round(f.test.expected * 1000) / 1000,
      p_value: Number(f.test.p.toPrecision(6)),
      ratio: Math.round(f.test.ratio * 1000) / 1000,
      decision: f.test.decision,
      failed_gates: f.test.failed,
    }));
    for (let i = 0; i < findingRows.length; i += 500) await must("findings", db.from("detector_findings").insert(findingRows.slice(i, i + 500)));

    const actions: Record<string, number> = {};
    for (const ep of episodes) {
      const c = engine.buildCandidate(ep);
      const res = await must<{ id: string; action: string }>("upsert", db.rpc("upsert_detected_signal", {
        _p: {
          method_code: c.methodCode, episode_key: c.episodeKey, region_id: c.regionId, syndrome: c.syndrome,
          window_start: c.windowStart, window_end: c.windowEnd, observed_value: c.observedValue, baseline_value: c.baselineValue,
          deviation: c.deviation, signal_score: c.signalScore, sample_count: c.sampleCount, minimum_sample_count: c.minimumSampleCount,
          confidence: c.confidence, explanation: c.explanation, run_id: runId, first_detected_on: c.firstDetectedOn,
          last_seen_on: c.lastSeenOn, score_components: c.scoreComponents, evidence: c.evidence,
        },
      }));
      actions[res.action] = (actions[res.action] ?? 0) + 1;
    }

    await must("finish run", db.from("detector_runs").update({
      status: "succeeded", finished_at: new Date().toISOString(),
      stats: { ...result.stats, episodes: episodes.length, upserts: actions },
    }).eq("id", runId));
    return { ...base, runId, actions };
  } catch (e) {
    await db.from("detector_runs").update({ status: "failed", finished_at: new Date().toISOString(), error: String(e instanceof Error ? e.message : e).slice(0, 2000) }).eq("id", runId);
    throw e;
  }
}
