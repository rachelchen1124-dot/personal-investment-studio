import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  buildResearchBrief,
  rollingNtmEnd,
  todayInLondon
} from '../../lib/financial-skills/brief.mjs'
import {
  filterFinancialSkills,
  financialSkills
} from '../../lib/financial-skills/catalog.mjs'

const readBundle = async (id) =>
  JSON.parse(
    await readFile(
      new URL(`../../public/financial-skills/${id}.json`, import.meta.url),
      'utf8'
    )
  )
const sha = (value) => createHash('sha256').update(value).digest('hex')

test('all 18 workflows ship complete, verifiable source bundles from one revision', async () => {
  const provenance = JSON.parse(
    await readFile(
      new URL('../../public/financial-skills/provenance.json', import.meta.url),
      'utf8'
    )
  )
  assert.equal(financialSkills.length, 18)
  assert.deepEqual(
    provenance.workflowIds,
    financialSkills.map((skill) => skill.id)
  )
  const license = await readFile(
    new URL('../../public/financial-skills/LICENSE.txt', import.meta.url),
    'utf8'
  )
  assert.equal(sha(license), provenance.licenseSha256)
  for (const skill of financialSkills) {
    const bundle = await readBundle(skill.id)
    assert.equal(bundle.id, skill.id)
    assert.equal(bundle.upstreamCommit, provenance.upstreamCommit)
    assert.equal(bundle.instructionSha256, sha(bundle.instructions))
    assert.match(bundle.instructions, new RegExp(`name: ${skill.id}\\s`))
    assert.ok(bundle.sourceUrl.includes(provenance.upstreamCommit))
    for (const resource of bundle.resources) {
      assert.equal(sha(resource.content), resource.sha256)
      assert.ok(!resource.path.includes('..'))
    }
  }
})

test('research date changes update NTM without replacing the fiscal period', async () => {
  const bundle = await readBundle('dcf-model')
  const input = {
    skillId: 'dcf-model',
    company: 'Microsoft (MSFT)',
    asOf: '2026-10-26',
    period: 'FY2027 Q1'
  }
  const old = buildResearchBrief(input, bundle)
  const current = buildResearchBrief({ ...input, asOf: '2026-10-27' }, bundle)
  assert.ok(old.includes('2027-10-26'))
  assert.ok(current.includes('2027-10-27'))
  assert.ok(!current.includes('2027-10-26'))
  assert.ok(current.includes('FY2027 Q1'))
  assert.ok(current.includes('Do not relabel an FY estimate as NTM'))
})

test('research date follows London midnight and handles leap-year anniversaries', () => {
  assert.equal(todayInLondon(new Date('2026-07-26T23:30:00Z')), '2026-07-27')
  assert.equal(todayInLondon(new Date('2026-12-26T23:30:00Z')), '2026-12-26')
  assert.equal(rollingNtmEnd('2024-02-29'), '2025-02-28')
  assert.throws(() => rollingNtmEnd('2026-02-30'), /valid research date/)
})

test('complete briefs preserve original instructions and every supporting file', async () => {
  const bundle = await readBundle('initiating-coverage')
  const brief = buildResearchBrief(
    {
      skillId: bundle.id,
      company: 'Example sector',
      asOf: '2026-10-27',
      notes: 'Use the attached FY2025 filing.'
    },
    bundle
  )
  assert.ok(brief.includes(bundle.instructions))
  assert.ok(bundle.resources.length > 0)
  for (const resource of bundle.resources)
    assert.ok(brief.includes(resource.content))
  assert.ok(
    brief.includes(
      'has not run an analysis or connected any market-data provider'
    )
  )
  assert.ok(brief.includes('Use the attached FY2025 filing.'))
})

test('compact briefs label omitted references so an incomplete handoff is explicit', async () => {
  const bundle = await readBundle('dcf-model')
  const brief = buildResearchBrief(
    {
      skillId: bundle.id,
      company: 'Example company',
      asOf: '2026-10-27',
      includeReferences: false
    },
    bundle
  )
  assert.ok(brief.includes('Reference contents were not included'))
  for (const resource of bundle.resources)
    assert.ok(!brief.includes(resource.content))
})

test('switching workflows cannot silently prepare a brief with stale instructions', async () => {
  const bundle = await readBundle('dcf-model')
  assert.throws(
    () =>
      buildResearchBrief(
        { skillId: 'earnings-preview', company: 'MSFT', asOf: '2026-10-27' },
        bundle
      ),
    /did not load correctly/
  )
  assert.throws(
    () =>
      buildResearchBrief(
        { skillId: 'dcf-model', company: ' ', asOf: '2026-10-27' },
        bundle
      ),
    /Enter a company/
  )
})

test('search finds valuation methods and respects the category filter', () => {
  assert.equal(filterFinancialSkills('WACC')[0].id, 'dcf-model')
  assert.equal(
    filterFinancialSkills('thesis scorecard')[0].id,
    'thesis-tracker'
  )
  assert.equal(filterFinancialSkills('earnings', 'Model & value').length, 1)
  assert.equal(filterFinancialSkills('not-a-workflow').length, 0)
})
