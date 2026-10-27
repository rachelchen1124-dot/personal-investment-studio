import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  financialSkills,
  financialSkillsSource
} from '../lib/financial-skills/catalog.mjs'

const source = process.argv[2]
if (!source)
  throw new Error(
    'Usage: node scripts/sync-financial-skills.mjs /absolute/path/to/financial-services'
  )
const sourceRoot = path.resolve(source)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'public', 'financial-skills')
const upstreamCommit = execFileSync(
  'git',
  ['-C', sourceRoot, 'rev-parse', 'HEAD'],
  { encoding: 'utf8' }
).trim()
if (!/^[a-f0-9]{40}$/.test(upstreamCommit))
  throw new Error('A full upstream commit is required.')
if (
  execFileSync('git', ['-C', sourceRoot, 'status', '--porcelain'], {
    encoding: 'utf8'
  }).trim()
) {
  throw new Error(
    'Use an unmodified upstream checkout so provenance describes the actual source.'
  )
}
const hash = (value) => createHash('sha256').update(value).digest('hex')
await mkdir(output, { recursive: true })

async function textFiles(directory, prefix = '') {
  const results = []
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries.sort((a, b) =>
    a.name.localeCompare(b.name, 'en')
  )) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory())
      results.push(
        ...(await textFiles(path.join(directory, entry.name), relative))
      )
    else if (entry.isFile()) results.push(relative)
    else throw new Error(`Unsupported source entry: ${relative}`)
  }
  return results
}

for (const skill of financialSkills) {
  const upstreamPath = `plugins/vertical-plugins/${skill.vertical}/skills/${skill.id}`
  const directory = path.join(sourceRoot, upstreamPath)
  const instructions = await readFile(path.join(directory, 'SKILL.md'), 'utf8')
  const resources = []
  for (const relative of await textFiles(directory)) {
    if (relative === 'SKILL.md') continue
    if (!/\.(md|py|txt|json|ya?ml)$/.test(relative))
      throw new Error(`Review non-text resource before importing: ${relative}`)
    const content = await readFile(path.join(directory, relative), 'utf8')
    resources.push({ path: relative, content, sha256: hash(content) })
  }
  const bundle = {
    id: skill.id,
    upstreamRepository: financialSkillsSource,
    upstreamCommit,
    upstreamPath,
    sourceUrl: `${financialSkillsSource}/blob/${upstreamCommit}/${upstreamPath}/SKILL.md`,
    license: 'Apache-2.0',
    instructionSha256: hash(instructions),
    instructions,
    resources
  }
  await writeFile(
    path.join(output, `${skill.id}.json`),
    JSON.stringify(bundle, null, 2) + '\n'
  )
}
const license = await readFile(path.join(sourceRoot, 'LICENSE'), 'utf8')
await writeFile(path.join(output, 'LICENSE.txt'), license)
await writeFile(
  path.join(output, 'NOTICE.txt'),
  `Financial Skills in Rachel's Investment Studio\n\nOriginal workflows and reference materials: Anthropic and contributors.\nSource: ${financialSkillsSource}\nUpstream revision: ${upstreamCommit}\nLicense: Apache License, Version 2.0 (see LICENSE.txt).\n\nThe original workflow instructions and bundled reference files are reproduced\nwithout edits inside each workflow JSON. The catalog descriptions, browser UI\nand research brief adapter were added for Investment Studio.\n\nScope: ${financialSkills.length} core financial-analysis and equity-research workflows.\nThis is a browser-based workflow and prompt workbench. It is not a deployment\nof Claude Managed Agents or a connection to a financial data provider. It does\nnot execute scripts, run models, produce analyst reports or generate workbooks.\nThose operations take place in the Claude session where a brief is run, subject\nto the tools, subscriptions and data available in that session.\n\nThe research context entered in the workbench stays in the current browser tab\nuntil the user copies or downloads it. Required workbooks and source documents\nare attached separately in the destination session.\n`
)
await writeFile(
  path.join(output, 'provenance.json'),
  JSON.stringify(
    {
      upstreamRepository: financialSkillsSource,
      upstreamCommit,
      license: 'Apache-2.0',
      licenseSha256: hash(license),
      workflowIds: financialSkills.map((skill) => skill.id)
    },
    null,
    2
  ) + '\n'
)
console.log(
  `Imported ${financialSkills.length} workflows from ${upstreamCommit}.`
)
