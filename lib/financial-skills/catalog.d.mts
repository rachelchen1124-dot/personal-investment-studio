export type FinancialSkillCategory =
  | 'All workflows'
  | 'Model & value'
  | 'Research & earnings'
  | 'Review & prepare'
export interface FinancialSkill {
  id: string
  name: string
  category: Exclude<FinancialSkillCategory, 'All workflows'>
  vertical: string
  command: string
  description: string
  inputs: string[]
  outputs: string[]
  example: string
  valuationLink?: boolean
}
export const financialSkillsSource: string
export const financialSkillCategories: FinancialSkillCategory[]
export const financialSkills: FinancialSkill[]
export function findFinancialSkill(id: string): FinancialSkill | undefined
export function filterFinancialSkills(
  query?: string,
  category?: FinancialSkillCategory
): FinancialSkill[]
