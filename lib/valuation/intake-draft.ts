import type { Observation, Upload } from './manual-intake.mjs'
import type { IntakeContext, RunSettings } from './workflow.ts'
import { proposeImport, restoreIntake } from './capital-iq.ts'

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
  return {
    context: restored.context,
    files: proposals.map((proposal) => proposal.file),
    observations: [
      ...restored.observations,
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
      ))
  )
    return null
  return {
    signature: candidate.signature,
    settings: {
      ...settings,
      forwardMultiplePeriods: settings.forwardMultiplePeriods || {},
      sourceReview: false,
      capitalReview: false,
      dcfReview: false,
      peerProfileReview: false,
      peerSelections: Object.fromEntries(
        Object.entries(settings.peerSelections).map(([id, selection]) => [
          id,
          { included: selection.included, rationale: selection.rationale }
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
