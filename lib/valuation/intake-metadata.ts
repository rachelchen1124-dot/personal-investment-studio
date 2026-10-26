import type { Observation, Upload } from './manual-intake.mjs'
import { exportDate } from './capital-iq.ts'
import { ntmPeriodEnd } from './forward-period.ts'

/** File-derived dates follow corrected source metadata; explicit row dates do not. */
export function rebaseObservationDates(
  file: Upload,
  observation: Observation,
  native?: Observation
): Observation {
  const automatic = Boolean(native && observation.id.startsWith('auto:'))
  const originalSource = observation.availableAt || exportDate(file.name)
  const sourceDateMode =
    observation.sourceDateMode ||
    (!observation.availableAt ||
    (automatic &&
      (observation.availableAt === file.availableAt ||
        observation.availableAt === exportDate(file.name)))
      ? 'file'
      : 'row')
  const sourceInherited = sourceDateMode === 'file'
  const periodDateMode =
    observation.periodDateMode ||
    (automatic &&
    sourceInherited &&
    native?.periodDateMode === 'snapshot' &&
    (!observation.endDate ||
      observation.endDate === originalSource ||
      observation.endDate === file.availableAt)
      ? 'snapshot'
      : automatic &&
          sourceInherited &&
          native?.periodDateMode === 'ntm' &&
          observation.basis === 'NTM' &&
          (!observation.endDate ||
            observation.endDate === ntmPeriodEnd(originalSource))
        ? 'ntm'
        : 'explicit')
  const availableAt = sourceInherited
    ? file.availableAt
    : observation.availableAt
  const endDate =
    periodDateMode === 'snapshot'
      ? availableAt
      : periodDateMode === 'ntm'
        ? ntmPeriodEnd(availableAt)
        : observation.endDate
  return {
    ...observation,
    sourceDateMode,
    periodDateMode,
    availableAt,
    endDate,
    ...(periodDateMode === 'ntm' &&
    observation.field === 'evEbitdaForward' &&
    endDate
      ? {
          forwardPeriodConfirmation: {
            originalBasis:
              observation.forwardPeriodConfirmation?.originalBasis ?? 'NTM',
            originalEndDate: '',
            note: `SP_TEV_EBITDA_FWD uses NTM ending ${endDate}, twelve months from snapshot ${availableAt}. Source period end unavailable; uploaded multiple used unchanged. The target row is linked automatically when its matching TEV is present.`
          }
        }
      : {})
  }
}
