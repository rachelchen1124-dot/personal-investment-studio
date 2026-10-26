import { proposeImport, restoreIntake } from './capital-iq.ts'
import { rebaseObservationDates } from './intake-metadata.ts'
import {
  type NormalizedManual,
  type Observation,
  type Upload,
  validDate
} from './manual-intake.mjs'
import {
  type IntakeContext,
  prepareModel,
  rebaseRunSettings,
  type RunSettings
} from './workflow.ts'

export type ModelDraft = { signature: string; settings: RunSettings }
export type IntakeDraft = {
  schema: 'valuation-browser-draft-v1'
  pack: {
    schema: 'valuation-manual-intake-v1'
    context: IntakeContext
    files: Upload[]
    originalObservations: Observation[]
  }
  stage: 'upload' | 'map' | 'review' | 'model'
  model: ModelDraft | null
}

/** Adding fiscal labels does not discard saved assumptions for unchanged source data. */
export function valuationModelKey(
  context: IntakeContext,
  records: NormalizedManual[]
) {
  return JSON.stringify([
    context.company,
    context.issuerId,
    context.valuationDate,
    context.mode,
    records.map((record) => ({
      ...record,
      period: {
        basis: record.period.basis,
        endDate: record.period.endDate,
        months: record.period.months
      },
      issues: record.issues.filter((issue) => issue.code !== 'REVIEW_REQUIRED')
    }))
  ])
}

/** Dates and refreshed source data invalidate results, while analyst inputs survive. */
export function settingsFromModelDraft(
  draft: ModelDraft | null,
  context: IntakeContext,
  records: NormalizedManual[]
): RunSettings | undefined {
  if (!draft) return undefined
  if (draft.signature === valuationModelKey(context, records))
    return draft.settings
  try {
    const parsed: unknown = JSON.parse(draft.signature)
    if (!Array.isArray(parsed) || parsed.length !== 5) return undefined
    const [company, issuerId, valuationDate, mode, previousRecords] = parsed
    if (
      typeof issuerId !== 'string' ||
      typeof valuationDate !== 'string' ||
      !validDate(valuationDate) ||
      company !== context.company ||
      issuerId.trim().toUpperCase() !== context.issuerId.trim().toUpperCase() ||
      !Array.isArray(previousRecords)
    )
      return undefined
    const previousContext = {
      company,
      issuerId,
      valuationDate,
      mode
    } as IntakeContext
    return rebaseRunSettings(
      prepareModel(
        previousRecords as NormalizedManual[],
        previousContext,
        draft.settings.forwardMultiplePeriods
      ),
      prepareModel(records, context, draft.settings.forwardMultiplePeriods),
      draft.settings
    )
  } catch {
    return undefined
  }
}

/** Rebuild native mappings from original tables, including legacy packs without mappings. */
export function rebuildIntake(raw: unknown) {
  const restored = restoreIntake(raw)
  const proposals = restored.files.map((file) =>
    proposeImport(file, restored.context.issuerId)
  )
  const occupied = new Set(
    restored.observations.map((item) =>
      JSON.stringify([item.fileId, item.sheet, item.row, item.column])
    )
  )
  const fiscalMetadata = new Map(
    proposals
      .flatMap((proposal) => proposal.observations)
      .map((item) => [
        JSON.stringify([item.fileId, item.sheet, item.row, item.column]),
        item
      ])
  )
  const sourceFiles = new Map(
    proposals.map((proposal) => [proposal.file.id, proposal.file])
  )
  return {
    context: restored.context,
    files: proposals.map((proposal) => proposal.file),
    observations: [
      ...restored.observations.map((item) => {
        const native = fiscalMetadata.get(
          JSON.stringify([item.fileId, item.sheet, item.row, item.column])
        )
        const dated = rebaseObservationDates(
          sourceFiles.get(item.fileId)!,
          item,
          native
        )
        return native &&
          dated.basis === native.basis &&
          dated.endDate === native.endDate
          ? {
              ...dated,
              fiscalYear: item.fiscalYear ?? native.fiscalYear,
              fiscalQuarter: item.fiscalQuarter ?? native.fiscalQuarter
            }
          : dated
      }),
      ...proposals
        .flatMap((proposal) => proposal.observations)
        .filter(
          (item) =>
            !occupied.has(
              JSON.stringify([item.fileId, item.sheet, item.row, item.column])
            )
        )
    ],
    notes: Object.fromEntries(
      proposals.map((proposal) => [proposal.file.id, proposal.notes])
    )
  }
}

/** Saved assumptions are inputs only. Recovered drafts require fresh run confirmations. */
export function recoverModelDraft(raw: unknown): ModelDraft | null {
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as ModelDraft
  const settings = candidate.settings
  if (
    typeof candidate.signature !== 'string' ||
    !settings ||
    typeof settings !== 'object'
  )
    return null
  const numeric = [
    'currency',
    'debt',
    'cash',
    'preferred',
    'nci',
    'nonOperating',
    'shares',
    'extraShares',
    'price',
    'baseRevenue',
    'baseWorkingCapital',
    'wacc',
    'terminalGrowth',
    'terminalRoic',
    'assumptionsNote',
    'relativePeriod',
    'targetMultiple',
    'targetMultipleRationale'
  ] as const
  if (
    numeric.some(
      (key) =>
        typeof settings[key] !== 'string' || settings[key].length > 20_000
    ) ||
    !['EV/Revenue', 'EV/EBITDA', 'EV/EBIT', 'P/E'].includes(
      settings.multiple
    ) ||
    !Array.isArray(settings.forecasts) ||
    settings.forecasts.length !== 5 ||
    settings.forecasts.some(
      (row) =>
        !row ||
        ['growth', 'margin', 'tax', 'da', 'capex', 'wc'].some(
          (key) => typeof row[key as keyof typeof row] !== 'string'
        )
    ) ||
    !settings.peerSelections ||
    typeof settings.peerSelections !== 'object' ||
    Object.values(settings.peerSelections).some(
      (selection) =>
        !selection ||
        typeof selection.included !== 'boolean' ||
        typeof selection.rationale !== 'string'
    ) ||
    (settings.forwardMultiplePeriods &&
      Object.values(settings.forwardMultiplePeriods).some(
        (period) =>
          !period ||
          !['FY', 'CY', 'NTM'].includes(period.basis) ||
          typeof period.endDate !== 'string'
      )) ||
    (settings.relativeSnapshot !== undefined &&
      typeof settings.relativeSnapshot !== 'string') ||
    (settings.priorSnapshotReview !== undefined &&
      typeof settings.priorSnapshotReview !== 'boolean') ||
    (settings.marketDataMode !== undefined &&
      !['current', 'uploaded'].includes(settings.marketDataMode)) ||
    (settings.autoRecalculate !== undefined &&
      typeof settings.autoRecalculate !== 'boolean')
  )
    return null
  const sourceSettings = { ...settings } as RunSettings & {
    targetNtmEbitda?: unknown
  }
  delete sourceSettings.targetNtmEbitda
  const selections = Object.values(settings.peerSelections).filter(
    (selection) => selection.included
  )
  const continuous =
    settings.marketDataMode === 'current' &&
    settings.autoRecalculate === true &&
    settings.sourceReview === true &&
    settings.capitalReview === true &&
    settings.peerProfileReview === true &&
    selections.length >= 3 &&
    selections.every(
      (selection) =>
        selection.rationale.trim() &&
        (!selection.research?.applied || selection.research.reviewed)
    )
  return {
    signature: candidate.signature,
    settings: {
      ...sourceSettings,
      forwardMultiplePeriods: settings.forwardMultiplePeriods || {},
      relativeSnapshot: settings.relativeSnapshot || 'latest',
      sourceReview: continuous,
      capitalReview: continuous,
      dcfReview: false,
      peerProfileReview: continuous,
      priorSnapshotReview: false,
      peerSelections: Object.fromEntries(
        Object.entries(settings.peerSelections).map(([id, selection]) => [
          id,
          continuous
            ? { ...selection }
            : { included: selection.included, rationale: selection.rationale }
        ])
      )
    }
  }
}

const databaseName = 'valuation-analyst-drafts-v1'
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('drafts')
    request.onsuccess = () => resolve(request.result)
    request.addEventListener('error', () => reject(request.error))
    request.onblocked = () =>
      reject(new Error('Browser draft storage is unavailable.'))
  })
}
async function transaction<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await database()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('drafts', mode)
      const request = action(tx.objectStore('drafts'))
      tx.oncomplete = () => resolve(request.result)
      tx.addEventListener('abort', () => reject(tx.error || request.error))
      tx.addEventListener('error', () => reject(tx.error || request.error))
    })
  } finally {
    db.close()
  }
}
export async function loadIntakeDraft(): Promise<IntakeDraft | null> {
  const draft = await transaction('readonly', (store) => store.get('current'))
  return draft?.schema === 'valuation-browser-draft-v1' ? draft : null
}
export async function saveIntakeDraft(draft: IntakeDraft) {
  if (!draft.pack.files.length)
    await transaction('readwrite', (store) => store.delete('current'))
  else await transaction('readwrite', (store) => store.put(draft, 'current'))
}
