export interface FinancialSkillBundle {
  id: string
  instructions: string
  sourceUrl: string
  upstreamCommit: string
  resources: { path: string; content: string; sha256: string }[]
  instructionSha256: string
}
export interface ResearchBriefInput {
  skillId: string
  company: string
  asOf: string
  period?: string
  question?: string
  notes?: string
  includeReferences?: boolean
}
export function todayInLondon(now?: Date): string
export function validateAsOfDate(value: string): Date
export function rollingNtmEnd(asOf: string): string
export function buildResearchBrief(
  input: ResearchBriefInput,
  bundle: FinancialSkillBundle
): string
