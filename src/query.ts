import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const QUERY_PRESETS = [
  'summary',
  'failures',
  'cost-outliers',
  'latency-outliers',
  'tool-counts',
  'ungradable',
  'score-histogram',
  'fanout',
] as const

export type QueryPreset = (typeof QUERY_PRESETS)[number]

export interface ClickHousePlan {
  preset: QueryPreset
  query: string
  command: string[]
}

export interface ClickHousePlanOptions {
  preset: QueryPreset
  gradedPath: string
  trajectoriesPath: string
  clickhouseCommand: string[]
}

export function listQueryPresets(): QueryPreset[] {
  return [...QUERY_PRESETS]
}

export function isQueryPreset(value: string): value is QueryPreset {
  return QUERY_PRESETS.includes(value as QueryPreset)
}

export function parseClickHouseCommand(value: string | undefined): string[] {
  const command = value?.trim()
  if (command) return command.split(/\s+/)
  // No explicit override: prefer the vendored binary at the repo root, then PATH.
  const vendored = join(import.meta.dir, '..', 'clickhouse')
  if (existsSync(vendored)) return [vendored]
  return ['clickhouse-local']
}

export function buildClickHousePlan(options: ClickHousePlanOptions): ClickHousePlan {
  const query = buildPresetQuery(options.preset, {
    graded: jsonlFile(options.gradedPath),
    trajectories: jsonlFile(options.trajectoriesPath),
  })
  return {
    preset: options.preset,
    query,
    command: [...options.clickhouseCommand, '--query', query],
  }
}

function buildPresetQuery(preset: QueryPreset, tables: { graded: string; trajectories: string }): string {
  switch (preset) {
    case 'summary':
      return `
SELECT
  count() AS trials,
  uniqExact(JSONExtractString(json, 'taskId')) AS tasks,
  round(avg(JSONExtractFloat(json, 'score')), 4) AS average_score,
  countIf(JSONExtractBool(json, 'pass')) AS pass_count,
  round(avg(toFloat64(JSONExtractBool(json, 'pass'))), 4) AS pass_rate,
  round(avg(JSONExtractFloat(json, 'trial', 'invocation', 'durationMs')), 2) AS average_latency_ms,
  round(sum(JSONExtractFloat(json, 'trial', 'metadata', 'usage', 'costUsd')), 4) AS model_cost_usd,
  round(sum(JSONExtractFloat(json, 'trial', 'metadata', 'youApiUsage', 'costUsd')), 4) AS you_api_cost_usd
FROM ${tables.graded}
FORMAT PrettyCompact`.trim()
    case 'failures':
      return `
SELECT
  JSONExtractString(json, 'taskId') AS task_id,
  JSONExtractInt(json, 'trialIndex') AS trial_index,
  round(JSONExtractFloat(json, 'score'), 4) AS score,
  JSONExtractString(json, 'reasoning') AS reasoning,
  JSONExtractInt(json, 'process', 'toolCallCount') AS tool_calls,
  JSONExtractInt(json, 'process', 'errorCount') AS errors
FROM ${tables.graded}
WHERE NOT JSONExtractBool(json, 'pass')
ORDER BY score ASC, task_id ASC, trial_index ASC
LIMIT 50
FORMAT PrettyCompact`.trim()
    case 'cost-outliers':
      return `
SELECT
  task_id,
  trial_index,
  round(score, 4) AS score,
  round(model_cost_usd, 4) AS model_cost_usd,
  round(you_api_cost_usd, 4) AS you_api_cost_usd,
  round(model_cost_usd + you_api_cost_usd, 4) AS total_cost_usd
FROM
(
  SELECT
    JSONExtractString(json, 'taskId') AS task_id,
    JSONExtractInt(json, 'trialIndex') AS trial_index,
    JSONExtractFloat(json, 'score') AS score,
    JSONExtractFloat(json, 'trial', 'metadata', 'usage', 'costUsd') AS model_cost_usd,
    JSONExtractFloat(json, 'trial', 'metadata', 'youApiUsage', 'costUsd') AS you_api_cost_usd
  FROM ${tables.graded}
)
ORDER BY total_cost_usd DESC
LIMIT 25
FORMAT PrettyCompact`.trim()
    case 'latency-outliers':
      return `
SELECT
  JSONExtractString(json, 'taskId') AS task_id,
  JSONExtractInt(json, 'trialIndex') AS trial_index,
  round(JSONExtractFloat(json, 'score'), 4) AS score,
  JSONExtractInt(json, 'trial', 'invocation', 'durationMs') AS duration_ms,
  JSONExtractInt(json, 'process', 'toolCallCount') AS tool_calls
FROM ${tables.graded}
ORDER BY duration_ms DESC
LIMIT 25
FORMAT PrettyCompact`.trim()
    case 'tool-counts':
      return `
SELECT
  JSONExtractString(event, 'name') AS tool,
  count() AS calls,
  countIf(JSONExtractString(event, 'status') = 'failed') AS failed_calls,
  round(avg(JSONExtractFloat(event, 'durationMs')), 2) AS average_duration_ms
FROM ${tables.graded}
ARRAY JOIN JSONExtractArrayRaw(json, 'trial', 'trajectory') AS event
WHERE JSONExtractString(event, 'type') = 'tool_call'
GROUP BY tool
ORDER BY calls DESC, tool ASC
FORMAT PrettyCompact`.trim()
    case 'ungradable':
      return `
SELECT
  JSONExtractString(json, 'taskId') AS task_id,
  JSONExtractInt(json, 'trialIndex') AS trial_index,
  JSONExtractRaw(json, 'trial', 'task', 'metadata', 'expected_answer') AS expected_answer,
  JSONExtractRaw(json, 'trial', 'task', 'metadata', 'gradable') AS gradable,
  round(JSONExtractFloat(json, 'score'), 4) AS score
FROM ${tables.graded}
WHERE JSONExtractRaw(json, 'trial', 'task', 'metadata', 'expected_answer') IN ('', 'null')
   OR JSONExtractBool(json, 'trial', 'task', 'metadata', 'gradable') = false
ORDER BY task_id ASC, trial_index ASC
LIMIT 100
FORMAT PrettyCompact`.trim()
    case 'score-histogram':
      return `
SELECT
  floor(JSONExtractFloat(json, 'score') * 10) / 10 AS score_bucket,
  count() AS trials,
  countIf(JSONExtractBool(json, 'pass')) AS passing_trials
FROM ${tables.graded}
GROUP BY score_bucket
ORDER BY score_bucket ASC
FORMAT PrettyCompact`.trim()
    case 'fanout':
      // Root you-search call behavior: did the root use the fan-out signature,
      // and what did the extension distill per call? Pairs started events
      // (input.sub_queries) with completed events (details.rlm) by toolCallId.
      return `
WITH trajectory AS (
  SELECT
    JSONExtractString(json, 'taskId') AS task_id,
    JSONExtractInt(json, 'trialIndex') AS trial_index,
    JSONExtractFloat(json, 'score') AS score,
    event
  FROM ${tables.graded}
  ARRAY JOIN JSONExtractArrayRaw(json, 'trial', 'trajectory') AS event
  WHERE JSONExtractString(event, 'type') = 'tool_call'
), started AS (
  SELECT
    task_id,
    trial_index,
    score,
    JSONExtractString(event, 'metadata', 'toolCallId') AS call_id,
    length(JSONExtractArrayRaw(JSONExtractRaw(event, 'input', 'sub_queries'))) AS sub_query_count
  FROM trajectory
  WHERE JSONExtractString(event, 'status') = 'started'
    AND JSONExtractString(event, 'name') = 'you-search'
), finished AS (
  SELECT
    task_id,
    trial_index,
    score,
    JSONExtractString(event, 'metadata', 'toolCallId') AS call_id,
    if(
      length(JSONExtractArrayRaw(JSONExtractRaw(event, 'output', 'details', 'rlm', 'subQueries'))) > 0,
      arraySum(x -> JSONExtractFloat(x, 'facts'), JSONExtractArrayRaw(JSONExtractRaw(event, 'output', 'details', 'rlm', 'subQueries')))
        / length(JSONExtractArrayRaw(JSONExtractRaw(event, 'output', 'details', 'rlm', 'subQueries'))),
      0
    ) AS sq_avg_facts
  FROM trajectory
  WHERE JSONExtractString(event, 'status') = 'completed'
    AND JSONExtractString(event, 'name') = 'you-search'
)
SELECT
  count() AS completed_searches,
  countIf(s.sub_query_count > 0) AS calls_with_sub_queries,
  countIf(s.sub_query_count > 1) AS real_fanout_calls,
  uniqExact(if(s.sub_query_count > 0, s.task_id, NULL)) AS tasks_ever_fanning,
  round(avgIf(f.score, s.sub_query_count > 0), 4) AS avg_score_when_fanning,
  round(avgIf(s.sub_query_count, s.sub_query_count > 1), 2) AS avg_sub_queries_per_fanout,
  round(avgIf(f.sq_avg_facts, s.sub_query_count > 1), 2) AS avg_facts_per_section
FROM started AS s
INNER JOIN finished AS f
  ON s.task_id = f.task_id AND s.trial_index = f.trial_index AND s.call_id = f.call_id
FORMAT PrettyCompact`.trim()
  }
}

export function jsonlFile(path: string): string {
  return `file(${sqlString(path)}, 'JSONAsString', 'json String')`
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}
