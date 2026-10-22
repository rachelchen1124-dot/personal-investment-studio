export type SectionId = 'historicals' | 'capital' | 'peers' | 'forward'
export type Unit = '' | 'units' | 'thousands' | 'millions' | 'billions'
export type Classification = '' | 'reported' | 'consensus' | 'market' | 'analyst'
export type Sheet = { name: string; rows: string[][]; cachedFormulaCells?: string[] }
export type Upload = {
  id: string
  name: string
  category: SectionId
  provider: string
  availableAt: string
  currency: string
  amountUnit: Unit
  shareUnit: Unit
  importedAt: string
  sha256: string
  reviewed: boolean
  sheets: Sheet[]
}
export type Observation = {
  id: string
  fileId: string
  field: string
  rawValue: string
  issuerId: string
  basis: string
  endDate: string
  periodLabel?: string
  months?: number
  classification: Classification
  currency: string
  unit: Unit
  availableAt: string
  definition: string
  sign: 'as-reported' | 'negative-capex'
  sheet: string
  row: number
  column: number
}
export type NormalizedManual = {
  issuerId: string
  field: string
  value: number | null
  currency: string | null
  classification: string
  period: { basis: string; endDate: string; months: number; label?: string }
  dateResolution?: string
  calculation?: {
    method: 'annual-day-weighted'
    startDate: string
    endDate: string
    components: { sourceId: string; weight: number; days: number; yearDays: number; endDate: string }[]
  }
  definition: string
  source: {
    id: string
    provider: string
    kind: string
    asOf: string
    retrievedAt: string
    locator: string
    section: SectionId
    originalValue: string
    originalUnit: string
    fileSha256: string
  }
  issues: { code: string; message: string }[]
}
export const sections: {
  id: SectionId
  title: string
  label: string
  description: string
  periods: string
  hints: string[]
  note: string
}[]
export const fields: Record<string, string>
export function capitalIqConsensusDefinition(field: string): string
export function numericValue(raw: unknown): number | null
export function validDate(value: unknown): boolean
export function parseDelimited(text: string): string[][]
export function cellAddress(row: number, column: number): string
export function templateCsv(category: SectionId): string
export function mapTemplate(sheet: Sheet, headerRow?: number): Omit<Observation, 'id' | 'fileId'>[]
export function normalizeManual(
  observation: Observation,
  file: Upload,
  context: { valuationDate: string }
): NormalizedManual
