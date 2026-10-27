export const financialSkillsSource =
  'https://github.com/anthropics/financial-services'

export const financialSkillCategories = [
  'All workflows',
  'Model & value',
  'Research & earnings',
  'Review & prepare'
]

// Metadata for the web adapter. Original instructions and supporting files are
// bundled separately, without edits, by scripts/sync-financial-skills.mjs.
export const financialSkills = [
  {
    id: 'dcf-model',
    name: 'DCF valuation',
    category: 'Model & value',
    vertical: 'financial-analysis',
    command: '/dcf',
    description:
      'Build cash-flow forecasts, WACC, an equity bridge and valuation sensitivities.',
    inputs: [
      'Historical financial statements',
      'Forecast drivers and capital structure',
      'Dated market inputs'
    ],
    outputs: [
      'Linked DCF model',
      'Bull, base and bear assumptions',
      'WACC / terminal-growth sensitivities'
    ],
    example:
      'Value the company using a five-year DCF. Explain the assumptions and show what changes the valuation.',
    valuationLink: true
  },
  {
    id: 'comps-analysis',
    name: 'Comparable companies',
    category: 'Model & value',
    vertical: 'financial-analysis',
    command: '/comps',
    description:
      'Compare operating performance and trading multiples across a defensible peer group.',
    inputs: [
      'Company and peer universe',
      'Dated prices and capital structure',
      'Historical and forward financials'
    ],
    outputs: [
      'Peer comparison table',
      'Multiple distributions and outliers',
      'Implied valuation range'
    ],
    example:
      'Select relevant listed peers, compare LTM and NTM multiples and explain the valuation premium or discount.',
    valuationLink: true
  },
  {
    id: '3-statement-model',
    name: 'Three-statement model',
    category: 'Model & value',
    vertical: 'financial-analysis',
    command: '/3-statement-model',
    description:
      'Link the income statement, balance sheet and cash-flow statement with balance checks.',
    inputs: [
      'Historical statements and filings',
      'Forecast assumptions',
      'Existing model template, if available'
    ],
    outputs: [
      'Linked financial statements',
      'Supporting forecast schedules',
      'Balance and cash-flow checks'
    ],
    example:
      'Build a linked three-statement forecast with explicit drivers and explain any missing inputs.'
  },
  {
    id: 'lbo-model',
    name: 'LBO model',
    category: 'Model & value',
    vertical: 'financial-analysis',
    command: '/lbo',
    description:
      'Frame acquisition financing, debt repayment and sponsor return sensitivities.',
    inputs: [
      'Entry valuation and financing assumptions',
      'Operating forecast',
      'Exit assumptions and holding period'
    ],
    outputs: [
      'Sources and uses',
      'Debt and cash-flow schedules',
      'IRR and MOIC sensitivities'
    ],
    example:
      'Build an LBO case with debt paydown, operating assumptions and an entry / exit multiple sensitivity.'
  },
  {
    id: 'model-update',
    name: 'Model update',
    category: 'Model & value',
    vertical: 'equity-research',
    command: '/model-update',
    description:
      'Bring an existing financial model up to date and trace changes in estimates.',
    inputs: [
      'Existing financial model',
      'Latest earnings release and filings',
      'Updated guidance or estimates'
    ],
    outputs: [
      'Updated actuals and forecasts',
      'Before / after estimate bridge',
      'Model checks and change log'
    ],
    example:
      'Update the model for the latest reported quarter. Separate new actuals from changes to forecast assumptions.'
  },
  {
    id: 'earnings-analysis',
    name: 'Earnings review',
    category: 'Research & earnings',
    vertical: 'equity-research',
    command: '/earnings',
    description:
      'Turn an earnings release and call transcript into an evidence-based quarterly update.',
    inputs: [
      'Earnings release and transcript',
      'Prior guidance and dated consensus',
      'Existing thesis or model'
    ],
    outputs: [
      'Quarterly earnings note',
      'Actuals versus expectations',
      'Thesis implications and open questions'
    ],
    example:
      'Review the latest earnings. Explain the beat or miss, guidance changes and the implications for the thesis.'
  },
  {
    id: 'earnings-preview',
    name: 'Earnings preview',
    category: 'Research & earnings',
    vertical: 'equity-research',
    command: '/earnings-preview',
    description:
      'Prepare the key metrics, expectations and scenarios to watch before a company reports.',
    inputs: [
      'Reporting quarter and confirmed earnings date',
      'Dated consensus estimates',
      'Prior results and guidance'
    ],
    outputs: [
      'Key metrics to watch',
      'Bull / base / bear scenarios',
      'Catalyst checklist'
    ],
    example:
      'Prepare an earnings preview with consensus, the three most important operating metrics and scenario triggers.'
  },
  {
    id: 'initiating-coverage',
    name: 'Initiating coverage',
    category: 'Research & earnings',
    vertical: 'equity-research',
    command: '/initiate',
    description:
      'Structure a full company initiation spanning the business, financials, valuation and risks.',
    inputs: [
      'Company filings and investor materials',
      'Financial history and peer data',
      'Research question and audience'
    ],
    outputs: [
      'Company research report',
      'Financial and valuation framework',
      'Evidence, risks and monitoring plan'
    ],
    example:
      'Initiate coverage with a business overview, industry context, financial drivers, valuation and falsifiable thesis.'
  },
  {
    id: 'sector-overview',
    name: 'Sector overview',
    category: 'Research & earnings',
    vertical: 'equity-research',
    command: '/sector',
    description:
      'Map an industry’s value chain, demand drivers, economics and listed-company landscape.',
    inputs: [
      'Sector and geographical scope',
      'Market and company sources',
      'Research horizon'
    ],
    outputs: [
      'Industry landscape',
      'Company and KPI comparison',
      'Themes, risks and opportunities'
    ],
    example:
      'Map the sector value chain, explain its profit pools and identify the operating metrics that matter.'
  },
  {
    id: 'competitive-analysis',
    name: 'Competitive landscape',
    category: 'Research & earnings',
    vertical: 'financial-analysis',
    command: '/competitive-analysis',
    description:
      'Assess competitors, business positioning and the evidence behind a potential moat.',
    inputs: [
      'Company and competitor list',
      'Product, market-share and pricing sources',
      'Strategic question'
    ],
    outputs: [
      'Competitor matrix',
      'Positioning and moat assessment',
      'Evidence gaps and strategic risks'
    ],
    example:
      'Compare the company with its main competitors across products, distribution, unit economics and competitive advantages.'
  },
  {
    id: 'idea-generation',
    name: 'Investment screening',
    category: 'Research & earnings',
    vertical: 'equity-research',
    command: '/screen',
    description:
      'Translate an investment theme into screening criteria and a research shortlist.',
    inputs: [
      'Investment universe and constraints',
      'Screening criteria',
      'Dated financial and market data'
    ],
    outputs: [
      'Transparent screening framework',
      'Candidate shortlist',
      'Follow-up diligence questions'
    ],
    example:
      'Create a transparent screen for companies with improving returns on capital, resilient cash flows and reasonable valuations.'
  },
  {
    id: 'morning-note',
    name: 'Morning research note',
    category: 'Research & earnings',
    vertical: 'equity-research',
    command: '/morning-note',
    description:
      'Prioritize sourced overnight developments and their implications for a coverage universe.',
    inputs: ['Coverage universe', 'Dated news and releases', 'Upcoming events'],
    outputs: [
      'Prioritized morning brief',
      'Company and sector implications',
      'Today’s watch list'
    ],
    example:
      'Summarize the most material developments for the coverage list. Distinguish facts from interpretation and flag stale sources.'
  },
  {
    id: 'thesis-tracker',
    name: 'Thesis tracker',
    category: 'Research & earnings',
    vertical: 'equity-research',
    command: '/thesis',
    description:
      'Test an investment thesis against new evidence, milestones and disconfirming signals.',
    inputs: [
      'Original thesis and key pillars',
      'New evidence with dates',
      'Catalysts and invalidation criteria'
    ],
    outputs: [
      'Thesis scorecard',
      'Evidence and change log',
      'Catalysts and invalidation triggers'
    ],
    example:
      'Update the thesis scorecard. Explain which pillars strengthened or weakened and what evidence would invalidate the thesis.'
  },
  {
    id: 'catalyst-calendar',
    name: 'Catalyst calendar',
    category: 'Research & earnings',
    vertical: 'equity-research',
    command: '/catalysts',
    description:
      'Organize upcoming company and industry events by timing, evidence and significance.',
    inputs: [
      'Coverage universe',
      'Confirmed event dates and sources',
      'Research horizon'
    ],
    outputs: [
      'Dated catalyst calendar',
      'Confirmed versus estimated timing',
      'Monitoring priorities'
    ],
    example:
      'Build a catalyst calendar for the next three months. Separate confirmed dates from estimates and cite each source.'
  },
  {
    id: 'audit-xls',
    name: 'Excel model audit',
    category: 'Review & prepare',
    vertical: 'financial-analysis',
    command: '/debug-model',
    description:
      'Review formula links, hardcodes, balance checks and inconsistencies in an Excel model.',
    inputs: [
      'Excel workbook',
      'Expected model logic',
      'Known issues or review priorities'
    ],
    outputs: [
      'Prioritized issue log',
      'Formula and hardcode findings',
      'Balance and consistency checks'
    ],
    example:
      'Audit the workbook for broken formulas, inconsistent assumptions, unexpected hardcodes and financial statement imbalances.'
  },
  {
    id: 'clean-data-xls',
    name: 'Financial data cleanup',
    category: 'Review & prepare',
    vertical: 'financial-analysis',
    command: 'Data cleanup',
    description:
      'Normalize financial tables while preserving units, periods and the source audit trail.',
    inputs: [
      'Source tables or workbook',
      'Units and reporting periods',
      'Desired output structure'
    ],
    outputs: [
      'Normalized tables',
      'Reconciliation and exception log',
      'Documented transformations'
    ],
    example:
      'Clean and normalize the tables. Preserve original values, document transformations and flag ambiguous units or periods.'
  },
  {
    id: 'ib-check-deck',
    name: 'Presentation quality check',
    category: 'Review & prepare',
    vertical: 'financial-analysis',
    command: 'Deck review',
    description:
      'Check a financial presentation for numerical, narrative and formatting inconsistencies.',
    inputs: [
      'Presentation and supporting sources',
      'Audience and purpose',
      'Review priorities'
    ],
    outputs: [
      'Prioritized corrections',
      'Cross-slide consistency checks',
      'Numerical and narrative findings'
    ],
    example:
      'Check the presentation for inconsistent numbers, unsupported statements, period mismatches and formatting errors.'
  },
  {
    id: 'deck-refresh',
    name: 'Presentation refresh',
    category: 'Review & prepare',
    vertical: 'financial-analysis',
    command: 'Deck refresh',
    description:
      'Plan updates to linked financial charts and tables while preserving the deck’s structure.',
    inputs: [
      'Existing presentation',
      'Updated source workbook or tables',
      'As-of date and refresh scope'
    ],
    outputs: [
      'Refreshed charts and tables',
      'Source-to-slide mapping',
      'Change log and quality checks'
    ],
    example:
      'Refresh the financial charts and tables from the updated source data. Preserve the design and reconcile every changed number.'
  }
]

export function findFinancialSkill(id) {
  return financialSkills.find((skill) => skill.id === id)
}

export function filterFinancialSkills(query = '', category = 'All workflows') {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  return financialSkills.filter(
    (skill) =>
      (category === 'All workflows' || skill.category === category) &&
      terms.every((term) =>
        [
          skill.name,
          skill.id,
          skill.description,
          skill.command,
          ...skill.inputs,
          ...skill.outputs
        ]
          .join(' ')
          .toLocaleLowerCase()
          .includes(term)
      )
  )
}
