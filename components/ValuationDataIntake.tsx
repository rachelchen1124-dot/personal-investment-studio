import * as React from 'react'

import { ValuationModelRunner } from '@/components/ValuationModelRunner'
import { proposeImport, restoreIntake } from '@/lib/valuation/capital-iq'
import {
  cellAddress,
  type Classification,
  fields,
  mapTemplate,
  normalizeManual,
  type Observation,
  parseDelimited,
  type SectionId,
  sections,
  templateCsv,
  type Unit,
  type Upload,
  validDate
} from '@/lib/valuation/manual-intake.mjs'
import styles from '@/styles/ValuationIntake.module.css'

type Mode = 'dcf' | 'rv' | 'both'
type Section = (typeof sections)[number]

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function UnitSelect({
  id,
  value,
  onChange
}: {
  id: string
  value: Unit
  onChange: (value: Unit) => void
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value as Unit)}
    >
      <option value=''>Choose a scale</option>
      <option value='units'>Units</option>
      <option value='thousands'>Thousands</option>
      <option value='millions'>Millions</option>
      <option value='billions'>Billions</option>
    </select>
  )
}

function UploadZone({
  section,
  number,
  files,
  mapped,
  mode,
  busy,
  onFiles,
  onPaste,
  onReview,
  onRemove
}: {
  section: Section
  number: number
  files: Upload[]
  mapped: Map<string, number>
  mode: Mode
  busy: boolean
  onFiles: (category: SectionId, files: FileList) => Promise<void>
  onPaste: (category: SectionId) => void
  onReview: (id: string) => void
  onRemove: (id: string) => void
}) {
  const input = React.useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = React.useState(false)
  const label =
    section.id === 'peers' && mode === 'dcf'
      ? 'Not needed for DCF'
      : section.id === 'forward' && mode === 'dcf'
        ? 'Optional for DCF'
        : section.label

  return (
    <section
      className={styles.uploadCard}
      aria-labelledby={'upload-' + section.id}
    >
      <div className={styles.cardHeading}>
        <span className={styles.stepNumber}>{number}</span>
        <div>
          <h2 id={'upload-' + section.id}>{section.title}</h2>
          <span className={styles.badge}>{label}</span>
        </div>
      </div>
      <p>{section.description}</p>
      <p className={styles.periodHint}>{section.periods}</p>
      <details className={styles.hints} open={files.length === 0}>
        <summary>What should I download?</summary>
        <ul>
          {section.hints.map((hint) => (
            <li key={hint}>{hint}</li>
          ))}
        </ul>
        <p>{section.note}</p>
      </details>
      <div
        className={dragging ? styles.dropActive : styles.drop}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          if (!busy) void onFiles(section.id, event.dataTransfer.files)
        }}
      >
        <strong>Drop {section.title.toLowerCase()} here</strong>
        <span>XLSX, CSV or TSV · multiple files welcome</span>
        <div className={styles.actions}>
          <button
            type='button'
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            Choose files
          </button>
          <button
            type='button'
            disabled={busy}
            onClick={() => onPaste(section.id)}
          >
            Paste values
          </button>
        </div>
        <input
          ref={input}
          type='file'
          accept='.xlsx,.csv,.tsv,.txt'
          multiple
          hidden
          aria-label={'Choose ' + section.title.toLowerCase()}
          onChange={(event) => {
            const list = event.currentTarget.files
            if (list) void onFiles(section.id, list)
            event.currentTarget.value = ''
          }}
        />
      </div>
      <button
        type='button'
        className={styles.textButton}
        onClick={() =>
          download(
            section.id + '-template.csv',
            templateCsv(section.id),
            'text/csv;charset=utf-8'
          )
        }
      >
        Download this section&apos;s template ↓
      </button>
      <ul className={styles.fileList}>
        {files.map((file) => (
          <li key={file.id}>
            <div>
              <strong>{file.name}</strong>
              <small>
                {file.sheets.length} sheet(s) · {mapped.get(file.id) || 0}{' '}
                mapped inputs
                {' · '}
                {file.reviewed ? 'Reviewed' : 'Review needed'}
              </small>
            </div>
            <button type='button' onClick={() => onReview(file.id)}>
              Review
            </button>
            <button
              type='button'
              aria-label={'Remove ' + file.name}
              onClick={() => onRemove(file.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function ValuationDataIntake() {
  const [company, setCompany] = React.useState('')
  const [issuerId, setIssuerId] = React.useState('')
  const [valuationDate, setValuationDate] = React.useState('')
  const [mode, setMode] = React.useState<Mode>('both')
  const [uploads, setUploads] = React.useState<Upload[]>([])
  const [observations, setObservations] = React.useState<Observation[]>([])
  const [stage, setStage] = React.useState<
    'upload' | 'map' | 'review' | 'model'
  >('upload')
  const [importNotes, setImportNotes] = React.useState<
    Record<string, string[]>
  >({})
  const restoreInput = React.useRef<HTMLInputElement>(null)
  const [selectedId, setSelectedId] = React.useState('')
  const [sheetName, setSheetName] = React.useState('')
  const [headerRow, setHeaderRow] = React.useState(1)
  const [rowPage, setRowPage] = React.useState(0)
  const [columnPage, setColumnPage] = React.useState(0)
  const [reviewPage, setReviewPage] = React.useState(0)
  const [message, setMessage] = React.useState('')
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const busyRef = React.useRef(false)
  const [pasteCategory, setPasteCategory] = React.useState<SectionId | null>(
    null
  )
  const [pasteText, setPasteText] = React.useState('')
  const [editor, setEditor] = React.useState<Observation | null>(null)
  const pasteDialog = React.useRef<HTMLDialogElement>(null)
  const editDialog = React.useRef<HTMLDialogElement>(null)
  const editing = editor !== null
  const pasting = pasteCategory !== null

  React.useEffect(() => {
    const today = new Date()
    setValuationDate(
      [
        today.getFullYear(),
        String(today.getMonth() + 1).padStart(2, '0'),
        String(today.getDate()).padStart(2, '0')
      ].join('-')
    )
  }, [])
  React.useEffect(() => {
    if (editing) editDialog.current?.showModal()
    else editDialog.current?.close()
  }, [editing])
  React.useEffect(() => {
    if (pasting) pasteDialog.current?.showModal()
    else pasteDialog.current?.close()
  }, [pasting])

  const fileMap = React.useMemo(
    () => new Map(uploads.map((file) => [file.id, file])),
    [uploads]
  )
  const mappedCounts = React.useMemo(() => {
    const counts = new Map<string, number>()
    for (const observation of observations) {
      counts.set(observation.fileId, (counts.get(observation.fileId) || 0) + 1)
    }
    return counts
  }, [observations])
  const mappedCells = React.useMemo(
    () =>
      new Set(
        observations.map((item) =>
          [item.fileId, item.sheet, item.row, item.column].join('|')
        )
      ),
    [observations]
  )
  const records = React.useMemo(() => {
    const normalized = observations.map((observation) =>
      normalizeManual(observation, fileMap.get(observation.fileId)!, {
        valuationDate
      })
    )
    const groups = new Map<string, number[]>()
    for (const [index, record] of normalized.entries()) {
      const key = [
        record.issuerId,
        record.field,
        record.classification,
        record.period.basis,
        record.period.endDate,
        record.source.section
      ].join('|')
      const indices = groups.get(key) || []
      indices.push(index)
      groups.set(key, indices)
    }
    for (const indices of groups.values()) {
      if (indices.length < 2) continue
      const definitions = new Set(
        indices.map((index) =>
          JSON.stringify([
            normalized[index]!.value,
            normalized[index]!.currency,
            normalized[index]!.definition
          ])
        )
      )
      if (definitions.size > 1) {
        for (const index of indices)
          normalized[index]!.issues.push({
            code: 'CONFLICTING_INPUTS',
            message:
              'Competing values or definitions require an explicit reconciliation.'
          })
      }
    }
    return normalized
  }, [observations, fileMap, valuationDate])
  const selected = fileMap.get(selectedId) || uploads[0]
  const sheet =
    selected?.sheets.find((item) => item.name === sheetName) ||
    selected?.sheets[0]
  const rowCount = sheet?.rows.length || 0
  const columnCount = Math.max(
    1,
    ...(sheet?.rows.map((row) => row.length) || [1])
  )
  const requiredSections: SectionId[] =
    mode === 'dcf'
      ? ['historicals', 'capital']
      : ['historicals', 'capital', 'peers']
  const presentSections = new Set(uploads.map((file) => file.category))
  const missingSections = requiredSections.filter(
    (category) => !presentSections.has(category)
  )
  const issueCount = records.filter((record) => record.issues.length > 0).length
  const contextComplete =
    company.trim() && issuerId.trim() && validDate(valuationDate)
  const incompleteFiles = uploads.filter(
    (file) => !file.reviewed || !mappedCounts.get(file.id)
  )
  const intakeClear = Boolean(
    contextComplete &&
    !missingSections.length &&
    !incompleteFiles.length &&
    observations.length &&
    !issueCount
  )

  function updateFile(id: string, patch: Partial<Upload>) {
    setUploads((current) =>
      current.map((file) =>
        file.id === id
          ? { ...file, ...patch, reviewed: patch.reviewed ?? false }
          : file
      )
    )
  }

  function reviewFile(id: string) {
    setSelectedId(id)
    setSheetName('')
    setHeaderRow(1)
    setRowPage(0)
    setColumnPage(0)
    setStage('map')
  }

  function addTemplateMappings(file: Upload, selectedHeader = 0) {
    const native = selectedHeader === 0 ? proposeImport(file, issuerId) : null
    if (native?.recognized) {
      setUploads((current) =>
        current.map((item) => (item.id === file.id ? native.file : item))
      )
      setImportNotes((current) => ({ ...current, [file.id]: native.notes }))
      if (native.company) setCompany((current) => current || native.company)
      if (native.company && native.issuerId)
        setIssuerId((current) => current || native.issuerId)
    }
    const proposed = native?.recognized
      ? native.observations
      : file.sheets.flatMap((item) =>
          mapTemplate(item, selectedHeader).map((observation) => ({
            ...observation,
            id: crypto.randomUUID(),
            fileId: file.id
          }))
        )
    setObservations((current) => {
      const occupied = new Set(
        current.map((item) =>
          [item.fileId, item.sheet, item.row, item.column].join('|')
        )
      )
      return [
        ...current,
        ...proposed.filter(
          (item) =>
            !occupied.has(
              [item.fileId, item.sheet, item.row, item.column].join('|')
            )
        )
      ]
    })
    return proposed.length
  }

  async function addFiles(category: SectionId, list: FileList) {
    if (busyRef.current) return
    const incoming = Array.from(list)
    if (uploads.length + incoming.length > 12) {
      setError('Use up to 12 files in one intake pack.')
      return
    }
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      let totalCells = uploads.reduce(
        (total, file) =>
          total +
          file.sheets.reduce(
            (count, item) =>
              count + item.rows.reduce((sum, row) => sum + row.length, 0),
            0
          ),
        0
      )
      for (const input of incoming) {
        try {
          setMessage('Reading ' + input.name + '…')
          if (input.size > 10 * 1024 * 1024) {
            throw new Error('Use files smaller than 10 MB.')
          }
          if (!/\.(xlsx|csv|tsv|txt)$/i.test(input.name)) {
            throw new Error(
              'Use XLSX, CSV or TSV; save older XLS workbooks as XLSX first.'
            )
          }
          const buffer = await input.arrayBuffer()
          const sheets = /\.xlsx$/i.test(input.name)
            ? await (
                await import('@/lib/valuation/read-workbook')
              ).readXlsx(buffer)
            : [
                {
                  name: 'Table',
                  rows: parseDelimited(new TextDecoder().decode(buffer))
                }
              ]
          if (!sheets.some((item) => item.rows.length)) {
            throw new Error('No table values were found in this file.')
          }
          const cellCount = sheets.reduce(
            (count, item) =>
              count + item.rows.reduce((sum, row) => sum + row.length, 0),
            0
          )
          if (totalCells + cellCount > 200_000) {
            throw new Error(
              'This pack exceeds 200,000 cells. Export smaller tables.'
            )
          }
          const digest = await crypto.subtle.digest('SHA-256', buffer)
          const file: Upload = {
            id: crypto.randomUUID(),
            name: input.name,
            category,
            provider: '',
            availableAt: '',
            currency: '',
            amountUnit: '',
            shareUnit: '',
            importedAt: new Date().toISOString(),
            sha256: Array.from(new Uint8Array(digest))
              .map((byte) => byte.toString(16).padStart(2, '0'))
              .join(''),
            reviewed: false,
            sheets
          }
          totalCells += cellCount
          setUploads((current) => [...current, file])
          const mapped = addTemplateMappings(file)
          setSelectedId(file.id)
          setMessage(
            input.name +
              ' read. ' +
              mapped +
              ' inputs mapped. Review detected units, source details and model assumptions before calculating.'
          )
        } catch (err) {
          setError(
            input.name +
              ': ' +
              (err instanceof Error ? err.message : 'Unable to read file.')
          )
        }
      }
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  function addPaste(event: React.FormEvent) {
    event.preventDefault()
    if (!pasteCategory) return
    try {
      const rows = parseDelimited(pasteText)
      const file: Upload = {
        id: crypto.randomUUID(),
        name:
          'Pasted ' + sections.find((item) => item.id === pasteCategory)!.title,
        category: pasteCategory,
        provider: '',
        availableAt: '',
        currency: '',
        amountUnit: '',
        shareUnit: '',
        importedAt: new Date().toISOString(),
        sha256: '',
        reviewed: false,
        sheets: [{ name: 'Pasted table', rows }]
      }
      if (uploads.length >= 12)
        throw new Error('Use up to 12 files in one pack.')
      const existingCells = uploads.reduce(
        (total, item) =>
          total +
          item.sheets.reduce(
            (count, itemSheet) =>
              count + itemSheet.rows.reduce((sum, row) => sum + row.length, 0),
            0
          ),
        0
      )
      if (
        existingCells + rows.reduce((sum, row) => sum + row.length, 0) >
        200_000
      ) {
        throw new Error(
          'This pack exceeds 200,000 cells. Paste a smaller table.'
        )
      }
      setUploads((current) => [...current, file])
      addTemplateMappings(file)
      setPasteCategory(null)
      setPasteText('')
      reviewFile(file.id)
      setError('')
      setMessage(
        'Table added. Source references are relative to the pasted table.'
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to read table.')
    }
  }

  function mapCell(row: number, column: number) {
    if (!selected || !sheet) return
    const existing = observations.find(
      (item) =>
        item.fileId === selected.id &&
        item.sheet === sheet.name &&
        item.row === row &&
        item.column === column
    )
    const label = sheet.rows[row]?.[0]?.trim().toLowerCase()
    const field =
      Object.keys(fields).find(
        (key) =>
          key.toLowerCase() === label || fields[key]!.toLowerCase() === label
      ) || ''
    setEditor(
      existing
        ? { ...existing }
        : {
            id: crypto.randomUUID(),
            fileId: selected.id,
            field,
            rawValue: sheet.rows[row]?.[column] || '',
            issuerId,
            basis: '',
            endDate: '',
            classification: selected.category === 'forward' ? 'consensus' : '',
            currency: '',
            unit: '',
            availableAt: '',
            definition: '',
            sign: 'as-reported',
            sheet: sheet.name,
            row,
            column
          }
    )
  }

  function saveMapping(event: React.FormEvent) {
    event.preventDefault()
    if (!editor) return
    setObservations((current) =>
      current.some((item) => item.id === editor.id)
        ? current.map((item) => (item.id === editor.id ? editor : item))
        : [...current, editor]
    )
    updateFile(editor.fileId, {})
    setEditor(null)
    setMessage('Mapping saved. Confirm the file again after reviewing changes.')
  }

  function exportPack() {
    const pack = {
      schema: 'valuation-manual-intake-v1',
      context: { company, issuerId, valuationDate, mode },
      createdAt: new Date().toISOString(),
      status: intakeClear ? 'intake-reviewed' : 'intake-draft',
      readyForModelExecution: false,
      files: uploads,
      originalObservations: observations,
      records,
      missingUploadSections: missingSections,
      remaining: [
        'Review source-to-model reconciliation and all flagged inputs.',
        'Open Build valuation to confirm the equity bridge and DCF assumptions, then Calculate DCF.',
        'Review and select peers in Build valuation, then Calculate relative valuation. Download the valuation report from the results.'
      ]
    }
    download(
      'valuation-data-pack.json',
      JSON.stringify(pack, null, 2),
      'application/json'
    )
    setMessage(
      'Backup downloaded. To calculate and view results on this page, open Build valuation.'
    )
  }

  async function restoreFile(input: File) {
    setError('')
    try {
      if (input.size > 10 * 1024 * 1024)
        throw new Error('Use an intake JSON smaller than 10 MB.')
      const restored = restoreIntake(JSON.parse(await input.text()))
      const proposals = restored.files.map((file) =>
        proposeImport(file, restored.context.issuerId)
      )
      setUploads(proposals.map((proposal) => proposal.file))
      const occupied = new Set(
        restored.observations.map((item) =>
          [item.fileId, item.sheet, item.row, item.column].join('|')
        )
      )
      setObservations([
        ...restored.observations,
        ...proposals
          .flatMap((proposal) => proposal.observations)
          .filter(
            (item) =>
              !occupied.has(
                [item.fileId, item.sheet, item.row, item.column].join('|')
              )
          )
      ])
      setImportNotes(
        Object.fromEntries(
          proposals.map((proposal) => [proposal.file.id, proposal.notes])
        )
      )
      setCompany(restored.context.company)
      setIssuerId(restored.context.issuerId)
      setValuationDate(restored.context.valuationDate)
      setMode(restored.context.mode)
      setSelectedId(proposals[0]?.file.id || '')
      setSheetName('')
      setRowPage(0)
      setColumnPage(0)
      setReviewPage(0)
      setStage('review')
      setMessage(
        `Restored ${restored.files.length} workbooks and mapped ${proposals.reduce((sum, proposal) => sum + proposal.observations.length, 0)} financial observations. Review currency proposals and model assumptions, then build your valuation.`
      )
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Unable to reopen this intake JSON.'
      )
    }
  }

  const detectedCurrency = uploads.find((file) =>
    /^[A-Z]{3}$/.test(file.currency)
  )?.currency
  const modelKey = JSON.stringify([
    company,
    issuerId,
    valuationDate,
    mode,
    records
  ])

  return (
    <div className={styles.workspace + ' ph-no-capture ph-mask'}>
      <section className={styles.context} aria-label='Valuation context'>
        <label>
          Company
          <input
            value={company}
            onChange={(event) => setCompany(event.target.value)}
            placeholder='Company name'
          />
        </label>
        <label>
          Security identifier
          <input
            value={issuerId}
            onChange={(event) => setIssuerId(event.target.value)}
            placeholder='Ticker, exchange and share class'
          />
        </label>
        <label>
          Valuation date
          <input
            type='date'
            value={valuationDate}
            onChange={(event) => setValuationDate(event.target.value)}
          />
        </label>
        <label>
          Valuation method
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value as Mode)}
          >
            <option value='both'>DCF and relative valuation</option>
            <option value='dcf'>DCF only</option>
            <option value='rv'>Relative valuation only</option>
          </select>
        </label>
      </section>

      <div className={styles.restore}>
        <p>
          Already downloaded a data pack? Reopen it to recover your workbooks
          and rebuild the mappings.
        </p>
        <button
          type='button'
          disabled={busy}
          onClick={() => restoreInput.current?.click()}
        >
          Reopen intake JSON
        </button>
        <input
          ref={restoreInput}
          type='file'
          accept='.json'
          hidden
          aria-label='Reopen intake JSON'
          onChange={(event) => {
            const input = event.currentTarget.files?.[0]
            if (input) void restoreFile(input)
            event.currentTarget.value = ''
          }}
        />
      </div>

      <nav className={styles.stages} aria-label='Data intake steps'>
        {(['upload', 'map', 'review', 'model'] as const).map((item, index) => (
          <button
            key={item}
            type='button'
            aria-current={stage === item ? 'step' : undefined}
            onClick={() => setStage(item)}
          >
            <span>{index + 1}</span>
            {item === 'upload'
              ? 'Add data'
              : item === 'map'
                ? 'Map and confirm'
                : item === 'review'
                  ? 'Review data'
                  : 'Build valuation'}
          </button>
        ))}
      </nav>
      {message ? (
        <p className={styles.status} role='status'>
          {message}
        </p>
      ) : null}
      {error ? (
        <p className={styles.error} role='alert'>
          {error}
        </p>
      ) : null}
      {detectedCurrency && uploads.some((file) => !file.currency) ? (
        <div className={styles.notice}>
          <p>
            Some exports omit a currency label. {detectedCurrency} was detected
            in the target statements. Confirm the peer and consensus exports use
            the same currency before applying it; no FX conversion is performed.
          </p>
          <button
            type='button'
            onClick={() =>
              setUploads((current) =>
                current.map((file) =>
                  file.currency
                    ? file
                    : { ...file, currency: detectedCurrency, reviewed: false }
                )
              )
            }
          >
            Apply {detectedCurrency} to files without a currency
          </button>
        </div>
      ) : null}

      {stage === 'upload' ? (
        <>
          <div className={styles.orderHint}>
            <strong>Download in this order</strong>
            <p>
              Start with historical financials and capital structure. Add peers
              for relative valuation. Forward estimates are optional for DCF and
              trailing relative valuation.
            </p>
            <small>
              {requiredSections.length - missingSections.length} of{' '}
              {requiredSections.length} requested upload sections added. Files
              still need mapping and source review.
            </small>
          </div>
          {mode !== 'dcf' ? (
            <aside
              className={styles.notice}
              aria-label='Forward relative valuation requirements'
            >
              <strong>
                Using forward multiples? Include target and peer forecasts.
              </strong>
              <p>
                Provide the forecast metric for the target and at least three
                peers on the same FY, CY or NTM basis and period end. For
                example, FY2027 EV/EBITDA needs FY2027 EBITDA for every company.
              </p>
              <p>
                Include each issuer&apos;s identifier, period end, estimate
                as-of date, currency, units and metric definition. Add these
                forecasts in Peer Data or Forward Estimates; one upload is
                enough if your peer screen already includes them. A forward
                multiple alone does not supply the underlying forecast and its
                period.
              </p>
            </aside>
          ) : null}
          <div className={styles.uploadGrid}>
            {sections.map((section, index) => (
              <UploadZone
                key={section.id}
                section={section}
                number={index + 1}
                files={uploads.filter((file) => file.category === section.id)}
                mapped={mappedCounts}
                mode={mode}
                busy={busy}
                onFiles={addFiles}
                onPaste={setPasteCategory}
                onReview={reviewFile}
                onRemove={(id) => {
                  setUploads((current) =>
                    current.filter((file) => file.id !== id)
                  )
                  setObservations((current) =>
                    current.filter((item) => item.fileId !== id)
                  )
                }}
              />
            ))}
          </div>
          <div className={styles.bottomActions}>
            <p>
              Keep currency, amount scale, share scale, fiscal periods and
              source dates in your exports.
            </p>
            <button
              type='button'
              className={styles.primary}
              disabled={!uploads.length || busy}
              onClick={() => setStage('map')}
            >
              Review files →
            </button>
          </div>
        </>
      ) : null}

      {stage === 'map' ? (
        <section className={styles.mapping} aria-labelledby='mapping-title'>
          <h2 id='mapping-title'>Map values to the model</h2>
          <p>
            Native Capital IQ statements, consensus and SP/IQ peer screens are
            recognized automatically. Review the proposals below. For other
            layouts, use the Field / Value template or select a source cell to
            map it.
          </p>
          {!selected || !sheet ? (
            <p>Add an export or paste a table to begin.</p>
          ) : (
            <>
              <div className={styles.fileTabs}>
                {uploads.map((file) => (
                  <button
                    key={file.id}
                    type='button'
                    aria-pressed={file.id === selected.id}
                    onClick={() => reviewFile(file.id)}
                  >
                    {file.name}
                  </button>
                ))}
              </div>
              <div className={styles.metadata}>
                <label>
                  Source
                  <select
                    value={selected.provider}
                    onChange={(event) =>
                      updateFile(selected.id, { provider: event.target.value })
                    }
                  >
                    <option value=''>Choose provider</option>
                    <option>Bloomberg</option>
                    <option>Capital IQ</option>
                    <option>FactSet</option>
                    <option value='SEC'>Issuer filing</option>
                    <option>Analyst</option>
                  </select>
                </label>
                <label>
                  Available as of / snapshot date
                  <input
                    type='date'
                    value={selected.availableAt}
                    onChange={(event) =>
                      updateFile(selected.id, {
                        availableAt: event.target.value
                      })
                    }
                  />
                </label>
                <label>
                  Source currency
                  <input
                    value={selected.currency}
                    maxLength={3}
                    placeholder='USD'
                    onChange={(event) =>
                      updateFile(selected.id, {
                        currency: event.target.value.toUpperCase()
                      })
                    }
                  />
                </label>
                <label htmlFor='financial-scale'>
                  Financial amount scale
                  <UnitSelect
                    id='financial-scale'
                    value={selected.amountUnit}
                    onChange={(amountUnit) =>
                      updateFile(selected.id, { amountUnit })
                    }
                  />
                </label>
                <label htmlFor='share-scale'>
                  Share-count scale
                  <UnitSelect
                    id='share-scale'
                    value={selected.shareUnit}
                    onChange={(shareUnit) =>
                      updateFile(selected.id, { shareUnit })
                    }
                  />
                </label>
              </div>
              <p className={styles.caption}>
                The source date is separate from the financial period end.
                Historical valuations need point-in-time exports; a current
                export can contain later revisions. Prices stay per share, share
                counts use their own scale, and no currency conversion is
                inferred.
              </p>
              {importNotes[selected.id]?.map((note) => (
                <p key={note} className={styles.notice}>
                  {note}
                </p>
              ))}
              {sheet.cachedFormulaCells?.length ? (
                <p className={styles.notice}>
                  This sheet contains saved formula results. Confirm they were
                  refreshed and saved before export. Formulae are not executed
                  here, and missing results stay missing.
                </p>
              ) : null}
              <div className={styles.sheetControls}>
                <label>
                  Worksheet
                  <select
                    value={sheet.name}
                    onChange={(event) => {
                      setSheetName(event.target.value)
                      setRowPage(0)
                      setColumnPage(0)
                    }}
                  >
                    {selected.sheets.map((item) => (
                      <option key={item.name}>{item.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Template header row
                  <input
                    type='number'
                    min={1}
                    max={Math.max(1, rowCount)}
                    value={headerRow}
                    onChange={(event) =>
                      setHeaderRow(Math.max(1, Number(event.target.value) || 1))
                    }
                  />
                </label>
                <button
                  type='button'
                  onClick={() => {
                    const proposed = mapTemplate(sheet, headerRow - 1)
                    if (!proposed.length) {
                      setMessage(
                        'No canonical Field / Value columns found at this row. Select source cells to map them.'
                      )
                      return
                    }
                    const temporary = { ...selected, sheets: [sheet] }
                    addTemplateMappings(temporary, headerRow - 1)
                    updateFile(selected.id, {})
                    setMessage(
                      'Template mappings proposed. Review definitions, identifiers and dates before confirming.'
                    )
                  }}
                >
                  Propose template mappings
                </button>
              </div>
              <div className={styles.tableWrap}>
                <table className={styles.sourceTable}>
                  <caption>
                    {selected.name} · {sheet.name}. Select a cell to map or edit
                    it.
                  </caption>
                  <thead>
                    <tr>
                      <th scope='col'>Row</th>
                      {Array.from(
                        {
                          length: Math.min(
                            8,
                            Math.max(0, columnCount - columnPage * 8)
                          )
                        },
                        (_, index) => (
                          <th scope='col' key={index}>
                            {cellAddress(0, columnPage * 8 + index).replaceAll(
                              /\d/g,
                              ''
                            )}
                          </th>
                        )
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {sheet.rows
                      .slice(rowPage * 20, rowPage * 20 + 20)
                      .map((row, index) => {
                        const sourceRow = rowPage * 20 + index
                        return (
                          <tr key={sourceRow}>
                            <th scope='row'>{sourceRow + 1}</th>
                            {Array.from(
                              {
                                length: Math.min(
                                  8,
                                  Math.max(0, columnCount - columnPage * 8)
                                )
                              },
                              (_, offset) => {
                                const column = columnPage * 8 + offset
                                const mapped = mappedCells.has(
                                  [
                                    selected.id,
                                    sheet.name,
                                    sourceRow,
                                    column
                                  ].join('|')
                                )
                                return (
                                  <td key={column}>
                                    <button
                                      type='button'
                                      className={
                                        mapped
                                          ? styles.mappedCell
                                          : styles.sourceCell
                                      }
                                      aria-label={
                                        'Map ' +
                                        cellAddress(sourceRow, column) +
                                        ': ' +
                                        (row[column] || 'empty')
                                      }
                                      onClick={() => mapCell(sourceRow, column)}
                                    >
                                      {row[column] || '—'}
                                    </button>
                                  </td>
                                )
                              }
                            )}
                          </tr>
                        )
                      })}
                  </tbody>
                </table>
              </div>
              <div className={styles.sheetControls}>
                <button
                  type='button'
                  disabled={rowPage === 0}
                  onClick={() => setRowPage((page) => page - 1)}
                >
                  Previous rows
                </button>
                <span>
                  Rows {rowCount ? rowPage * 20 + 1 : 0}–
                  {Math.min(rowCount, rowPage * 20 + 20)} of {rowCount}
                </span>
                <button
                  type='button'
                  disabled={(rowPage + 1) * 20 >= rowCount}
                  onClick={() => setRowPage((page) => page + 1)}
                >
                  Next rows
                </button>
                <button
                  type='button'
                  disabled={columnPage === 0}
                  onClick={() => setColumnPage((page) => page - 1)}
                >
                  Previous columns
                </button>
                <button
                  type='button'
                  disabled={(columnPage + 1) * 8 >= columnCount}
                  onClick={() => setColumnPage((page) => page + 1)}
                >
                  Next columns
                </button>
              </div>
              <label className={styles.confirm}>
                <input
                  type='checkbox'
                  checked={selected.reviewed}
                  disabled={!mappedCounts.get(selected.id)}
                  onChange={(event) =>
                    updateFile(selected.id, { reviewed: event.target.checked })
                  }
                />
                I have reviewed the source metadata, field mappings, dates,
                units, security identifiers and accounting definitions for this
                file.
              </label>
            </>
          )}
          <div className={styles.bottomActions}>
            <button type='button' onClick={() => setStage('upload')}>
              Add more files
            </button>
            <button
              type='button'
              className={styles.primary}
              onClick={() => setStage('review')}
            >
              Review data →
            </button>
          </div>
        </section>
      ) : null}

      {stage === 'review' ? (
        <section className={styles.mapping} aria-labelledby='pack-title'>
          <h2 id='pack-title'>Review your imported data</h2>
          <p>
            {records.length
              ? 'Financial values have been mapped. Review the source units and periods, then continue to the model assumptions and calculation.'
              : 'No financial values have been mapped. The raw files alone cannot generate a valuation. Review the layout or use a section template.'}
          </p>
          <ul className={styles.reviewSummary}>
            {!contextComplete ? (
              <li>
                Complete the company, security identifier and valuation date.
              </li>
            ) : null}
            {missingSections.map((category) => (
              <li key={category}>
                No{' '}
                {sections
                  .find((item) => item.id === category)!
                  .title.toLowerCase()}{' '}
                file has been added.
              </li>
            ))}
            {incompleteFiles.map((file) => (
              <li key={file.id}>
                {file.name}:{' '}
                {!mappedCounts.get(file.id)
                  ? 'map source values'
                  : 'confirm the file review'}
                .
              </li>
            ))}
            <li>
              {records.length} mapped input(s), including {issueCount} with
              unresolved checks. Source review can be confirmed together on
              Build valuation; currency, units and other substantive gaps must
              be resolved first.
            </li>
            <li>
              Build valuation will show the annual base, equity bridge, editable
              DCF assumptions and peer selection. Each model runs independently.
            </li>
          </ul>
          {Object.entries(importNotes).map(([id, notes]) => (
            <details key={id} className={styles.hints}>
              <summary>{fileMap.get(id)?.name}: import notes</summary>
              {notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </details>
          ))}
          <div className={styles.bottomActions}>
            <button type='button' onClick={() => setStage('map')}>
              Review source mappings
            </button>
            <button
              type='button'
              className={styles.primary}
              disabled={!records.length}
              onClick={() => setStage('model')}
            >
              Build valuation →
            </button>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.reviewTable}>
              <thead>
                <tr>
                  <th scope='col'>Input / issuer</th>
                  <th scope='col'>Normalized value</th>
                  <th scope='col'>Period / source</th>
                  <th scope='col'>Checks</th>
                  <th scope='col'>Actions</th>
                </tr>
              </thead>
              <tbody>
                {records
                  .slice(reviewPage * 25, reviewPage * 25 + 25)
                  .map((record, index) => {
                    const observation = observations[reviewPage * 25 + index]!
                    return (
                      <tr key={observation.id}>
                        <td>
                          {fields[record.field]}
                          <small>
                            {record.issuerId || 'Identifier missing'}
                          </small>
                        </td>
                        <td>
                          {record.value ?? 'Missing'}
                          <small>
                            {record.field === 'price'
                              ? record.currency + ' per share'
                              : record.currency
                                ? record.currency + ' millions'
                                : 'Million shares'}
                          </small>
                        </td>
                        <td>
                          {record.period.basis} ·{' '}
                          {record.period.endDate || 'End date needed'}
                          <small>{record.source.locator}</small>
                          <small>
                            {record.classification} · source{' '}
                            {record.source.asOf || 'date needed'}
                          </small>
                        </td>
                        <td>
                          {record.issues.length ? (
                            <ul>
                              {record.issues.map((issue) => (
                                <li key={issue.code}>{issue.message}</li>
                              ))}
                            </ul>
                          ) : (
                            'Intake checks clear'
                          )}
                        </td>
                        <td>
                          <button
                            type='button'
                            onClick={() => setEditor({ ...observation })}
                          >
                            Edit
                          </button>
                          <button
                            type='button'
                            onClick={() => {
                              setObservations((current) =>
                                current.filter(
                                  (item) => item.id !== observation.id
                                )
                              )
                              updateFile(observation.fileId, {})
                              setReviewPage(0)
                            }}
                          >
                            Remove mapping
                          </button>
                        </td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          </div>
          <div className={styles.sheetControls}>
            <button
              type='button'
              disabled={reviewPage === 0}
              onClick={() => setReviewPage((page) => page - 1)}
            >
              Previous inputs
            </button>
            <span>{records.length} total mapped inputs</span>
            <button
              type='button'
              disabled={(reviewPage + 1) * 25 >= records.length}
              onClick={() => setReviewPage((page) => page + 1)}
            >
              Next inputs
            </button>
          </div>
          <details className={styles.hints}>
            <summary>Save an intake backup (JSON)</summary>
            <p>
              This backup preserves source tables and mappings. It is separate
              from the valuation report, which is available after calculation.
            </p>
            <button
              type='button'
              disabled={!uploads.length}
              onClick={exportPack}
            >
              {intakeClear
                ? 'Download reviewed intake backup'
                : 'Download draft intake backup'}{' '}
              ↓
            </button>
          </details>
        </section>
      ) : null}
      <div hidden={stage !== 'model'}>
        <ValuationModelRunner
          key={modelKey}
          records={records}
          files={uploads}
          context={{ company, issuerId, valuationDate, mode }}
          onReview={() => setStage('review')}
        />
      </div>
      <p className={styles.privacy}>
        Files and calculations stay in your browser. Review data and
        assumptions, run either valuation, then download the report. Save an
        intake JSON backup to reopen the source tables later.
      </p>

      <dialog
        ref={pasteDialog}
        className={styles.dialog}
        aria-labelledby='paste-title'
        onClose={() => setPasteCategory(null)}
      >
        <form onSubmit={addPaste}>
          <h2 id='paste-title'>
            Paste{' '}
            {sections
              .find((item) => item.id === pasteCategory)
              ?.title.toLowerCase()}
          </h2>
          <p>
            Include the column headings. References will point to this pasted
            table.
          </p>
          <label>
            Table values
            <textarea
              value={pasteText}
              onChange={(event) => setPasteText(event.target.value)}
              required
              rows={10}
            />
          </label>
          {error ? (
            <p className={styles.error} role='alert'>
              {error}
            </p>
          ) : null}
          <div className={styles.actions}>
            <button type='button' onClick={() => setPasteCategory(null)}>
              Cancel
            </button>
            <button type='submit' className={styles.primary}>
              Add table
            </button>
          </div>
        </form>
      </dialog>

      <dialog
        ref={editDialog}
        className={styles.dialog}
        aria-labelledby='edit-title'
        onClose={() => setEditor(null)}
      >
        {editor ? (
          <form onSubmit={saveMapping}>
            <h2 id='edit-title'>Map a source value</h2>
            <p>
              {fileMap.get(editor.fileId)?.name} · {editor.sheet}!
              {cellAddress(editor.row, editor.column)}
            </p>
            <div className={styles.editorGrid}>
              <label>
                Source value
                <input value={editor.rawValue} readOnly />
              </label>
              <label>
                Model field
                <select
                  value={editor.field}
                  required
                  onChange={(event) =>
                    setEditor({ ...editor, field: event.target.value })
                  }
                >
                  <option value=''>Choose field</option>
                  {Object.entries(fields).map(([key, title]) => (
                    <option key={key} value={key}>
                      {title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Issuer / security identifier
                <input
                  value={editor.issuerId}
                  required
                  onChange={(event) =>
                    setEditor({ ...editor, issuerId: event.target.value })
                  }
                />
              </label>
              <label>
                Classification
                <select
                  value={editor.classification}
                  required
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      classification: event.target.value as Classification
                    })
                  }
                >
                  <option value=''>Choose</option>
                  <option value='reported'>Reported actual</option>
                  <option value='consensus'>Consensus estimate</option>
                  <option value='market'>Market snapshot</option>
                  <option value='analyst'>Analyst input</option>
                </select>
              </label>
              <label>
                Period basis
                <select
                  value={editor.basis}
                  required
                  onChange={(event) =>
                    setEditor({ ...editor, basis: event.target.value })
                  }
                >
                  <option value=''>Choose</option>
                  {[
                    'FY',
                    'QTR',
                    'SEMI',
                    'YTD',
                    'LTM',
                    'NTM',
                    'CY',
                    'instant'
                  ].map((basis) => (
                    <option key={basis} value={basis}>
                      {basis === 'instant' ? 'Point in time' : basis}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Financial period end / observation date
                <input
                  type='date'
                  required
                  value={editor.endDate}
                  onChange={(event) =>
                    setEditor({ ...editor, endDate: event.target.value })
                  }
                />
              </label>
              {editor.basis === 'YTD' ? (
                <label>
                  YTD duration
                  <select
                    required
                    value={editor.months || ''}
                    onChange={(event) =>
                      setEditor({
                        ...editor,
                        months: Number(event.target.value)
                      })
                    }
                  >
                    <option value=''>Choose</option>
                    <option value={3}>3 months</option>
                    <option value={6}>6 months</option>
                    <option value={9}>9 months</option>
                  </select>
                </label>
              ) : null}
              <label htmlFor='row-scale'>
                Row scale override
                <UnitSelect
                  id='row-scale'
                  value={editor.unit}
                  onChange={(unit) => setEditor({ ...editor, unit })}
                />
              </label>
              <label>
                Row currency override
                <input
                  maxLength={3}
                  value={editor.currency}
                  placeholder='Use file currency'
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      currency: event.target.value.toUpperCase()
                    })
                  }
                />
              </label>
              <label>
                Row source-date override
                <input
                  type='date'
                  value={editor.availableAt}
                  onChange={(event) =>
                    setEditor({ ...editor, availableAt: event.target.value })
                  }
                />
              </label>
              <label>
                Capex sign
                <select
                  value={editor.sign}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      sign: event.target.value as Observation['sign']
                    })
                  }
                >
                  <option value='as-reported'>Keep the source sign</option>
                  <option value='negative-capex'>
                    Negative cash outflow → positive investment
                  </option>
                </select>
              </label>
            </div>
            <label>
              Definition / source reconciliation
              <textarea
                required
                rows={3}
                value={editor.definition}
                onChange={(event) =>
                  setEditor({ ...editor, definition: event.target.value })
                }
                placeholder='Accounting definition, SBC and lease treatment, dilution reconciliation or other evidence.'
              />
            </label>
            <p className={styles.caption}>
              Retain the original share-count basis. Economic dilution needs
              explicit evidence. Missing source values remain missing.
            </p>
            <div className={styles.actions}>
              <button type='button' onClick={() => setEditor(null)}>
                Cancel
              </button>
              <button type='submit' className={styles.primary}>
                Save mapping
              </button>
            </div>
          </form>
        ) : null}
      </dialog>
    </div>
  )
}
