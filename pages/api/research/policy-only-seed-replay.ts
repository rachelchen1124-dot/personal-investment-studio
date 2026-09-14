import type { NextApiRequest, NextApiResponse } from 'next'

const EVENT_DATE = '2026-07-20'
const START_DATE = '2026-07-16'
const END_DATE = '2026-08-31'
const POLICY_IMPACT_PCT_GDP = -0.4247525946492328
const POLICY_INPUT_PATH =
  'research/trade_policy_alpha/data/canada_policy_impact_2026_07_20.json'
const CANADA_2Y_SERIES = 'BD.CDN.2YR.DQ.YLD' as const
const BOC_URL = `https://www.bankofcanada.ca/valet/observations/FXUSDCAD,${CANADA_2Y_SERIES}/json?start_date=${START_DATE}&end_date=${END_DATE}`
const HORIZONS = [1, 5, 10, 20] as const

type ValetValue = { v?: string }
type Observation = {
  d: string
  FXUSDCAD?: ValetValue
  'BD.CDN.2YR.DQ.YLD'?: ValetValue
}

type SeriesPoint = { date: string; value: number }
type SeriesKey = 'FXUSDCAD' | 'BD.CDN.2YR.DQ.YLD'

function parseSeries(observations: Observation[], key: SeriesKey) {
  const out: SeriesPoint[] = []
  for (const row of observations) {
    const raw = row[key]?.v
    if (raw == null) continue
    const value = Number(raw)
    if (!Number.isFinite(value)) continue
    out.push({ date: row.d, value })
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}

function lastBefore(series: SeriesPoint[], date: string) {
  return [...series].reverse().find((x) => x.date < date) ?? null
}

function onDate(series: SeriesPoint[], date: string) {
  return series.find((x) => x.date === date) ?? null
}

function horizonPoints(series: SeriesPoint[], date: string) {
  const post = series.filter((x) => x.date > date)
  return HORIZONS.map((h) => ({ horizon: h, point: post[h - 1] ?? null }))
}

function fxResponse(series: SeriesPoint[]) {
  const baseline = lastBefore(series, EVENT_DATE)
  const eventDay = onDate(series, EVENT_DATE)
  if (!baseline) throw new Error('No pre-event FX observation found')
  const denominatorShock = Math.abs(POLICY_IMPACT_PCT_GDP)

  return {
    convention: 'USDCAD; positive return means CAD depreciation versus USD',
    baseline,
    event_day_diagnostic: eventDay
      ? {
          ...eventDay,
          return_from_pre_event_pct: (eventDay.value / baseline.value - 1) * 100
        }
      : null,
    horizons: horizonPoints(series, EVENT_DATE).map(({ horizon, point }) => {
      if (!point) return { horizon_business_observation: horizon, available: false }
      const returnPct = (point.value / baseline.value - 1) * 100
      return {
        horizon_business_observation: horizon,
        available: true,
        date: point.date,
        value: point.value,
        return_from_pre_event_pct: returnPct,
        response_per_1pct_gdp_abs_shock_pct: returnPct / denominatorShock
      }
    })
  }
}

function ratesResponse(series: SeriesPoint[]) {
  const baseline = lastBefore(series, EVENT_DATE)
  const eventDay = onDate(series, EVENT_DATE)
  if (!baseline) throw new Error('No pre-event Canada 2Y observation found')
  const denominatorShock = Math.abs(POLICY_IMPACT_PCT_GDP)

  return {
    series: `${CANADA_2Y_SERIES} — Government of Canada benchmark bond yield, 2 year, daily`,
    unit: 'percent yield; changes reported in basis points',
    baseline,
    benchmark_roll_caveat: {
      effective_date: '2026-08-06',
      note:
        'Bank of Canada changed the selected 2-year benchmark issue effective 2026-08-06. Horizons spanning that date are descriptive and should be replaced by a constant-maturity/OIS measure in the production transmission model.'
    },
    event_day_diagnostic: eventDay
      ? {
          ...eventDay,
          change_from_pre_event_bp: (eventDay.value - baseline.value) * 100
        }
      : null,
    horizons: horizonPoints(series, EVENT_DATE).map(({ horizon, point }) => {
      if (!point) return { horizon_business_observation: horizon, available: false }
      const deltaBp = (point.value - baseline.value) * 100
      return {
        horizon_business_observation: horizon,
        available: true,
        date: point.date,
        yield_pct: point.value,
        change_from_pre_event_bp: deltaBp,
        response_per_1pct_gdp_abs_shock_bp: deltaBp / denominatorShock,
        spans_benchmark_roll: point.date >= '2026-08-06'
      }
    })
  }
}

export const config = {
  maxDuration: 60
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const response = await fetch(BOC_URL, { cache: 'no-store' })
    if (!response.ok) {
      throw new Error(`Bank of Canada Valet fetch failed: ${response.status}`)
    }
    const body = (await response.json()) as { observations?: Observation[] }
    const observations = body.observations ?? []
    const fx = parseSeries(observations, 'FXUSDCAD')
    const rates = parseSeries(observations, CANADA_2Y_SERIES)
    if (!fx.length || !rates.length) {
      throw new Error(`Missing market series: FX rows=${fx.length}, rates rows=${rates.length}`)
    }

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800')
    return res.status(200).json({
      status: 'policy_only_seed_replay_complete',
      event: {
        event_id: 'US_CA_MOTOR_2026_07_20',
        announcement_date: EVENT_DATE,
        timestamp_precision: 'date',
        exact_policy_impact_pct_gdp_equivalent: POLICY_IMPACT_PCT_GDP,
        exact_policy_input: POLICY_INPUT_PATH
      },
      methodology: {
        purpose:
          'Descriptive policy-only seed replay before estimating a multi-event transmission model.',
        baseline_rule:
          'Last official daily observation strictly before the announcement date.',
        horizon_rule:
          '1/5/10/20 available business observations strictly after the announcement date.',
        same_day_use:
          'Event-day values are diagnostic only because the announcement timestamp is not yet known.',
        carry_included: false,
        roll_included: false,
        transaction_costs_included: false,
        statistical_inference: false,
        tradable_signal: false
      },
      market_data: {
        source: 'Bank of Canada Valet API',
        request_url: BOC_URL,
        fx_series: 'FXUSDCAD',
        canada_2y_series: CANADA_2Y_SERIES,
        start_date: START_DATE,
        end_date: END_DATE
      },
      fx: fxResponse(fx),
      canada_2y: ratesResponse(rates),
      research_gate: {
        passed_exact_impact: true,
        passed_seed_market_replay: true,
        passed_transmission_model: false,
        next_requirement:
          'Build a multi-event point-in-time tariff panel and estimate horizon-specific FX/rates coefficients with event-level inference before any tradable signal is enabled.'
      }
    })
  } catch (error) {
    console.error(error)
    return res.status(500).json({
      status: 'error',
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
