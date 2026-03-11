#!/usr/bin/env node
/**
 * claudia-bench
 *
 * Global benchmark recorder for the Claudia agent framework comparison.
 * No dependencies — plain Node.js, runs anywhere.
 *
 * Install:
 *   chmod +x /path/to/bench.js
 *   alias bench="node /path/to/bench.js"
 *   # or copy to /usr/local/bin/bench
 *
 * Data stored in ~/.bench/ — shared across all worktrees and agent runs.
 *
 * Usage:
 *   bench start <agent> <milestone>     begin a milestone run
 *   bench end                           close run (checklist + scores)
 *   bench log                           record one agent turn/message
 *   bench intervene "<note>"            record a human intervention
 *   bench tokens --in <n> | --out <n> | --all <n>  record token usage
 *   bench status                        show active run
 *   bench report                        summary table of all runs
 *   bench export                        write CSV to ~/.bench/exports/
 */

import fs from 'fs'
import path from 'path'
import readline from 'readline'
import os from 'os'
import { execSync } from 'child_process'

// ─── Config ──────────────────────────────────────────────────────────────────

const BENCH_DIR   = path.join(os.homedir(), '.bench')
const stateFile = (cwd = process.cwd()) => {
  const hash = cwd.split('').reduce((h,c) => (Math.imul(31,h) + c.charCodeAt(0)) | 0, 0).toString(16).replace('-','')
  return path.join(BENCH_DIR, `.active-run-${hash}.json`)
}
const RUNS_FILE   = path.join(BENCH_DIR, 'all-runs.jsonl')
const EXPORT_DIR  = path.join(BENCH_DIR, 'exports')

// ─── Milestone definitions ───────────────────────────────────────────────────

// ─── Project config ──────────────────────────────────────────────────────────
// Optional. Define projects with milestone IDs, names, and checklists in
// ~/.bench/projects.json. The pathRegex is matched against process.cwd() at
// bench start time to auto-detect which project you're in.
//
// If no match is found, or the milestone ID has no definition, bench falls
// back to freeform checklist entry at bench end.

const PROJECTS_FILE = path.join(BENCH_DIR, 'projects.json')

function loadProject(cwd) {
  if (!fs.existsSync(PROJECTS_FILE)) return null
  let config
  try { config = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')) }
  catch { return null }
  for (const project of (config.projects ?? [])) {
    if (project.pathRegex && new RegExp(project.pathRegex).test(cwd)) {
      return project
    }
  }
  return null
}

function getMilestoneDef(project, milestoneId) {
  if (!project?.milestones) return null
  return project.milestones[milestoneId] ?? null
}


const QUALITATIVE = [
  { key: 'specAdherence',     label: 'Spec adherence     (1–5)', hint: 'Did it follow the design doc, UI spec, and theme file?' },
  { key: 'themeUsage',        label: 'Theme file usage   (1–5)', hint: 'Used claudia-theme.ts or hardcoded values?' },
  { key: 'codeQuality',       label: 'Code quality       (1–5)', hint: 'Readable, well-typed, sensible state management?' },
  { key: 'autonomy',          label: 'Autonomy           (1–5)', hint: 'Completed without hand-holding? Questions were good?' },
  { key: 'hallucination',     label: 'Hallucination      (1=bad, 5=none)', hint: 'Invented APIs, wrong versions, confident wrongness?' },
  { key: 'legibilityForNext', label: 'Legibility         (1–5)', hint: 'Would the next agent understand and build on this?' },
  { key: 'satisfaction',      label: 'Overall satisfaction (1–5)', hint: 'How did it feel to work with this agent on this task?' },
]

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ensure = (dir) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }) }
const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
const writeJSON = (f, d) => { ensure(path.dirname(f)); fs.writeFileSync(f, JSON.stringify(d, null, 2)) }
const appendLine = (f, d) => { ensure(path.dirname(f)); fs.appendFileSync(f, JSON.stringify(d) + '\n') }
const readLines = (f) => fs.existsSync(f) ? fs.readFileSync(f,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)) : []
const now = () => Date.now()
const ts = () => new Date().toISOString()

function fmt(ms) {
  if (!ms) return '–'
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}h ${m % 60}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

function gitContext() {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: process.cwd(), stdio: ['pipe','pipe','pipe']
    }).toString().trim()
    const remote = execSync('git remote get-url origin', {
      cwd: process.cwd(), stdio: ['pipe','pipe','pipe']
    }).toString().trim()
      .replace(/.*[:/]([^/]+\/[^/]+?)(\.git)?$/, '$1') // extract owner/repo
    return { cwd: process.cwd(), branch, repo: remote }
  } catch {
    return { cwd: process.cwd(), branch: null, repo: null }
  }
}

// ANSI
const b  = (s) => `\x1b[1m${s}\x1b[0m`
const d  = (s) => `\x1b[2m${s}\x1b[0m`
const g  = (s) => `\x1b[32m${s}\x1b[0m`
const r  = (s) => `\x1b[31m${s}\x1b[0m`
const y  = (s) => `\x1b[33m${s}\x1b[0m`
const c  = (s) => `\x1b[36m${s}\x1b[0m`
const p  = (s) => process.stdout.write(s + '\n')

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => rl.question(question, a => { rl.close(); resolve(a.trim()) }))
}

const runPath = (agent, ms) => {
  const slug = agent.replace(/\s+/g, '-').toLowerCase()
  return path.join(BENCH_DIR, slug, `${ms}.json`)
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function start(args) {
  const [agent, milestone] = args
  if (!agent || !milestone) {
    p(r('Usage: bench start <agent> <milestone>'))
    p(d('  e.g. bench start "Claude Code" M2'))
    process.exit(1)
  }
  const id = milestone.toUpperCase()

  if (fs.existsSync(stateFile())) {
    const s = readJSON(stateFile())
    p(y(`⚠  Active run: ${s.agent} / ${s.milestone}`))
    const a = await ask('Abandon it and start new? (y/N) ')
    if (a.toLowerCase() !== 'y') process.exit(0)
  }

  const ctx = gitContext()
  const project = loadProject(ctx.cwd)
  const def = getMilestoneDef(project, id)

  const run = {
    agent, milestone: id, milestoneName: def?.name ?? id,
    projectName: project?.name ?? null,
    startTime: now(), startTs: ts(),
    worktree: ctx.cwd, branch: ctx.branch, repo: ctx.repo,
    endTime: null, endTs: null, durationMs: null,
    turns: 0,
    interventions: [],
    tokenLog: [],        // [{ ts, in, out, total? }]
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalTokens: 0,       // combined tokens when --all used
    checklistResults: {},
    qualitative: {},
    notes: '',
    status: 'active',
  }

  writeJSON(stateFile(), run)
  writeJSON(runPath(agent, id), run)

  p('')
  p(b(`▶  ${agent} — ${id}${def ? ': ' + def.name : ''}`))
  p(d(`   Started ${run.startTs}`))
  p(d(`   ${ctx.repo ?? path.basename(ctx.cwd)}  ${ctx.branch ? '@ ' + ctx.branch : '(no git branch)'}${project ? '  [' + project.name + ']' : ''}`))
  p('')
  p(d('  bench log                            record a turn'))
  p(d('  bench intervene "<note>"             record an intervention'))
  p(d('  bench tokens --in <n> | --out <n> | --all <n>  record token usage'))
  p(d('  bench end                            close with checklist + scores'))
  p('')
}

function log() {
  if (!fs.existsSync(stateFile())) { p(r('No active run.')); process.exit(1) }
  const s = readJSON(stateFile())
  s.turns++
  writeJSON(stateFile(), s)
  writeJSON(runPath(s.agent, s.milestone), s)
  p(d(`  turn ${s.turns} — ${ts()}`))
}

function intervene(args) {
  const note = args.join(' ')
  if (!note) { p(r('Usage: bench intervene "<note>"')); process.exit(1) }
  if (!fs.existsSync(stateFile())) { p(r('No active run.')); process.exit(1) }
  const s = readJSON(stateFile())
  s.interventions.push({ ts: ts(), note })
  writeJSON(stateFile(), s)
  writeJSON(runPath(s.agent, s.milestone), s)
  p(y(`  ⚡ [${s.interventions.length}] ${note}`))
}

function tokens(args) {
  // bench tokens --in <n>           record input tokens only
  // bench tokens --out <n>           record output tokens only
  // bench tokens --all <n>           record combined tokens (no breakdown)
  let tokIn = 0, tokOut = 0, tokTotal = 0
  const inIdx = args.indexOf('--in')
  const outIdx = args.indexOf('--out')
  const allIdx = args.indexOf('--all')
  if (inIdx !== -1)  tokIn   = parseInt(args[inIdx + 1])  || 0
  if (outIdx !== -1) tokOut  = parseInt(args[outIdx + 1]) || 0
  if (allIdx !== -1) tokTotal = parseInt(args[allIdx + 1]) || 0
  if (!tokIn && !tokOut && !tokTotal) { p(r('Usage: bench tokens --in <n> | --out <n> | --all <n>')); process.exit(1) }

  if (!fs.existsSync(stateFile())) { p(r('No active run.')); process.exit(1) }
  const s = readJSON(stateFile())
  s.totalTokens = s.totalTokens ?? 0
  s.tokenLog.push({ ts: ts(), in: tokIn, out: tokOut, total: tokTotal })
  s.totalTokensIn   += tokIn
  s.totalTokensOut  += tokOut
  s.totalTokens     += tokTotal
  writeJSON(stateFile(), s)
  writeJSON(runPath(s.agent, s.milestone), s)
  const sessionNum = s.tokenLog.length
  const total = s.totalTokensIn + s.totalTokensOut + s.totalTokens
  if (tokTotal) {
    p(d(`  tokens session ${sessionNum}: +${tokTotal.toLocaleString()} total  (running total: ${total.toLocaleString()})`))
  } else {
    p(d(`  tokens session ${sessionNum}: +${tokIn.toLocaleString()} in / +${tokOut.toLocaleString()} out  (running total: ${total.toLocaleString()})`))
  }
}

async function end() {
  if (!fs.existsSync(stateFile())) { p(r('No active run.')); process.exit(1) }
  const s = readJSON(stateFile())
  const project = loadProject(s.worktree ?? process.cwd())
  const def = getMilestoneDef(project, s.milestone)

  p('')
  p(b(`■  ${s.agent} — ${s.milestone}${def ? ': ' + def.name : ''}`))
  p(d(`   Started: ${s.startTs}`))
  p(d(`   Elapsed: ${fmt(now() - s.startTime)}`))
  const endTotal = (s.totalTokensIn ?? 0) + (s.totalTokensOut ?? 0) + (s.totalTokens ?? 0)
  p(d(`   Turns: ${s.turns}  |  Interventions: ${s.interventions.length}  |  Tokens: ${endTotal.toLocaleString()}`))
  p('')

  // Checklist — defined items if project config found, freeform otherwise
  p(b('Done-when checklist:'))
  const checklistItems = def?.checklist ?? null

  if (checklistItems) {
    p(d('  Y/n/skip for each item'))
    p('')
    for (const item of checklistItems) {
      const a = await ask(`  [ ] ${item}\n      (Y/n/skip) `)
      const v = a.toLowerCase()
      s.checklistResults[item] = v === 'n' ? 'fail' : v === 's' || v === 'skip' ? 'skip' : 'pass'
      const icon = s.checklistResults[item] === 'pass' ? g('✓') : s.checklistResults[item] === 'fail' ? r('✗') : d('–')
      p(`  ${icon} ${d(item)}`)
    }
  } else {
    p(d('  No milestone definition found — enter items you verified, blank line to finish'))
    p(d('  For each: type the item, press enter, then Y/n/skip'))
    p('')
    while (true) {
      const item = await ask('  [ ] ')
      if (!item) break
      const a = await ask('      (Y/n/skip) ')
      const v = a.toLowerCase()
      s.checklistResults[item] = v === 'n' ? 'fail' : v === 's' || v === 'skip' ? 'skip' : 'pass'
      const icon = s.checklistResults[item] === 'pass' ? g('✓') : s.checklistResults[item] === 'fail' ? r('✗') : d('–')
      p(`  ${icon} ${d(item)}`)
    }
  }

  const passed  = Object.values(s.checklistResults).filter(v => v === 'pass').length
  const failed  = Object.values(s.checklistResults).filter(v => v === 'fail').length
  const skipped = Object.values(s.checklistResults).filter(v => v === 'skip').length
  p('')
  p(`  ${g(passed + ' passed')}  ${failed > 0 ? r(failed + ' failed') : d('0 failed')}  ${skipped > 0 ? d(skipped + ' skipped') : ''}`)

  // Qualitative
  p('')
  p(b('Qualitative scores:'))
  for (const q of QUALITATIVE) {
    p(d(`  ${q.hint}`))
    const a = await ask(`  ${q.label}: `)
    const n = parseInt(a)
    s.qualitative[q.key] = isNaN(n) ? null : Math.min(5, Math.max(1, n))
  }

  // Notes
  p('')
  const notes = await ask('Notes (one line or enter to skip):\n  > ')
  s.notes = notes

  // Finalise
  s.endTime = now()
  s.endTs = ts()
  s.durationMs = s.endTime - s.startTime
  s.status = failed > 0 ? 'partial' : 'complete'
  const totalItems = Object.keys(s.checklistResults).length
  s.checklistSummary = { passed, failed, skipped, total: totalItems }

  writeJSON(runPath(s.agent, s.milestone), s)
  appendLine(RUNS_FILE, s)
  fs.unlinkSync(stateFile())

  p('')
  p(b(`✓  Saved to ~/.bench/`))
  p(d(`   ${s.agent} / ${s.milestone}  |  ${fmt(s.durationMs)}  |  ${s.status === 'complete' ? g('complete') : y('partial')}`))
  p('')
}

function status() {
  ensure(BENCH_DIR)
  const activeFiles = fs.readdirSync(BENCH_DIR).filter(f => f.startsWith('.active-run-'))
  if (!activeFiles.length) { p(d('No active runs.')); return }
  for (const file of activeFiles) {
    const s = readJSON(path.join(BENCH_DIR, file))
    p('')
    p(b(`Active: ${s.agent} — ${s.milestone}${s.milestoneName !== s.milestone ? ': ' + s.milestoneName : ''}`))
    p(d(`  ${s.repo ?? path.basename(s.worktree ?? '.')}  ${s.branch ? '@ ' + s.branch : ''}${s.projectName ? '  [' + s.projectName + ']' : ''}`))
    p(d(`  Started: ${s.startTs}  |  Elapsed: ${fmt(now() - s.startTime)}`))
    p(d(`  Turns: ${s.turns}  |  Interventions: ${s.interventions.length}`))
    const activeTotal = (s.totalTokensIn ?? 0) + (s.totalTokensOut ?? 0) + (s.totalTokens ?? 0)
    p(d(`  Tokens: ${activeTotal.toLocaleString()}  (in: ${s.totalTokensIn ?? 0} / out: ${s.totalTokensOut ?? 0} / total: ${s.totalTokens ?? 0})`))
    if (s.interventions.length) {
      p(d('  Interventions:'))
      s.interventions.forEach(i => p(d(`    [${i.ts}] ${i.note}`)))
    }
  }
  p('')
}

function report() {
  const runs = readLines(RUNS_FILE)
  if (!runs.length) { p(d('No completed runs yet.')); return }

  const byMs = {}
  for (const run of runs) {
    if (!byMs[run.milestone]) byMs[run.milestone] = []
    byMs[run.milestone].push(run)
  }

  p('')
  p(b('CLAUDIA BENCHMARK REPORT'))
  p(d('─'.repeat(100)))

  const W = { agent:20, dur:9, turns:7, int:5, tok:10, chk:7, spec:5, theme:6, auto:5, halu:5, leg:5, sat:4 }

  for (const [ms, msRuns] of Object.entries(byMs).sort()) {
    p('')
    p(b(`${ms}${msRuns[0]?.milestoneName && msRuns[0].milestoneName !== ms ? ' — ' + msRuns[0].milestoneName : ''}`))
    const hdr = [
      'Agent'.padEnd(W.agent), 'Time'.padEnd(W.dur), 'Turns'.padEnd(W.turns),
      'Int'.padEnd(W.int), 'Tokens'.padEnd(W.tok),
      'Check'.padEnd(W.chk), 'Spec'.padEnd(W.spec), 'Theme'.padEnd(W.theme),
      'Auto'.padEnd(W.auto), 'Halu'.padEnd(W.halu), 'Legib'.padEnd(W.leg), 'Sat'.padEnd(W.sat),
    ].join(' ')
    p(d(hdr))
    p(d('─'.repeat(100)))

    for (const run of msRuns) {
      const q = run.qualitative ?? {}
      const chk = run.checklistSummary ? `${run.checklistSummary.passed}/${run.checklistSummary.total}` : '–'
      const runTotal = (run.totalTokensIn ?? 0) + (run.totalTokensOut ?? 0) + (run.totalTokens ?? 0)
      const row = [
        run.agent.substring(0, W.agent-1).padEnd(W.agent),
        fmt(run.durationMs).padEnd(W.dur),
        String(run.turns ?? '–').padEnd(W.turns),
        String(run.interventions?.length ?? '–').padEnd(W.int),
        (runTotal ? (runTotal/1000).toFixed(1)+'k' : '–').padEnd(W.tok),
        chk.padEnd(W.chk),
        String(q.specAdherence     ?? '–').padEnd(W.spec),
        String(q.themeUsage        ?? '–').padEnd(W.theme),
        String(q.autonomy          ?? '–').padEnd(W.auto),
        String(q.hallucination     ?? '–').padEnd(W.halu),
        String(q.legibilityForNext ?? '–').padEnd(W.leg),
        String(q.satisfaction      ?? '–').padEnd(W.sat),
      ].join(' ')
      p(run.status === 'complete' ? row : y(row))
    }
  }

  // Cross-agent summary
  const agents = [...new Set(runs.map(r => r.agent))]
  if (agents.length > 1) {
    p('')
    p(d('─'.repeat(100)))
    p(b('CROSS-AGENT TOTALS'))
    for (const agent of agents) {
      const ar = runs.filter(r => r.agent === agent)
      const totalMs   = ar.reduce((s,r) => s + (r.durationMs ?? 0), 0)
      const totalTokens= ar.reduce((s,r) => s + (r.totalTokensIn ?? 0) + (r.totalTokensOut ?? 0) + (r.totalTokens ?? 0), 0)
      const totalInt  = ar.reduce((s,r) => s + (r.interventions?.length ?? 0), 0)
      const totalTurns= ar.reduce((s,r) => s + (r.turns ?? 0), 0)
      const avg = (key) => {
        const vals = ar.map(r => r.qualitative?.[key]).filter(v => v != null)
        return vals.length ? (vals.reduce((a,b) => a+b, 0) / vals.length).toFixed(1) : '–'
      }
      p('')
      p(`  ${b(agent)}  ${d(`(${ar.length} milestones)`)}`)
      p(`    Time: ${fmt(totalMs)}  |  Turns: ${totalTurns}  |  Interventions: ${totalInt}`)
      p(`    Tokens: ${(totalTokens/1000).toFixed(1)}k  (${ar.reduce((s,r)=>s+(r.tokenLog?.length??0),0)} token recordings)`)
      p(`    Scores — Spec:${avg('specAdherence')} Theme:${avg('themeUsage')} Auto:${avg('autonomy')} Halu:${avg('hallucination')} Legib:${avg('legibilityForNext')} Sat:${avg('satisfaction')}`)
    }
  }
  p('')
}

function exportCSV() {
  const runs = readLines(RUNS_FILE)
  if (!runs.length) { p(d('No completed runs yet.')); return }
  ensure(EXPORT_DIR)

  const headers = [
    'agent','milestone','milestoneName','projectName','status',
    'repo','branch','worktree',
    'startTs','endTs','durationMs','durationFormatted',
    'turns','interventionCount','tokenSessions','totalTokensIn','totalTokensOut','totalTokens',
    'checklistPassed','checklistFailed','checklistSkipped','checklistTotal',
    'specAdherence','themeUsage','codeQuality','autonomy',
    'hallucination','legibilityForNext','satisfaction',
    'notes',
  ]

  const rows = runs.map(r => [
    `"${r.agent}"`, r.milestone, `"${r.milestoneName}"`, `"${r.projectName ?? ''}"`, r.status,
    `"${r.repo ?? ''}"`, `"${r.branch ?? ''}"`, `"${r.worktree ?? ''}"`,
    r.startTs, r.endTs, r.durationMs ?? '', fmt(r.durationMs),
    r.turns ?? 0, r.interventions?.length ?? 0,
    r.tokenLog?.length ?? 0, r.totalTokensIn ?? 0, r.totalTokensOut ?? 0, r.totalTokens ?? 0,
    r.checklistSummary?.passed ?? '', r.checklistSummary?.failed ?? '',
    r.checklistSummary?.skipped ?? '', r.checklistSummary?.total ?? '',
    r.qualitative?.specAdherence ?? '', r.qualitative?.themeUsage ?? '',
    r.qualitative?.codeQuality ?? '', r.qualitative?.autonomy ?? '',
    r.qualitative?.hallucination ?? '', r.qualitative?.legibilityForNext ?? '',
    r.qualitative?.satisfaction ?? '',
    `"${(r.notes ?? '').replace(/"/g, '""')}"`,
  ])

  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n')
  const out = path.join(EXPORT_DIR, `export-${Date.now()}.csv`)
  fs.writeFileSync(out, csv)
  p(g(`✓ Exported: ${out}`))
  p(d(`  ${runs.length} runs`))
}

function help() {
  p('')
  p(b('claudia-bench — milestone benchmark recorder'))
  p(d('  Data stored in ~/.bench/'))
  p('')
  p('  bench start <agent> <milestone>        begin a milestone run')
  p('  bench end                              close run (interactive checklist + scores)')
  p('  bench log                              record one agent turn/message')
  p('  bench intervene "<note>"               record a human intervention')
  p('  bench tokens --in <n> | --out <n> | --all <n>  record token usage')
  p('  bench status                           show active run')
  p('  bench report                           summary table of all completed runs')
  p('  bench export                           write CSV to ~/.bench/exports/')
  p('')
  p(d('  Milestone IDs: any string — e.g. M2, auth-module, SPRINT-4'))
  p(d('  Define checklists in ~/.bench/projects.json (see docs)'))
  p('')
}

// ─── Entry ────────────────────────────────────────────────────────────────────

const [,, cmd, ...args] = process.argv
switch (cmd) {
  case 'start':     await start(args); break
  case 'end':       await end(); break
  case 'log':       log(); break
  case 'intervene': intervene(args); break
  case 'tokens':    tokens(args); break
  case 'status':    status(); break
  case 'report':    report(); break
  case 'export':    exportCSV(); break
  case 'help': case '--help': case '-h': help(); break
  default:
    p(r(`Unknown command: ${cmd ?? '(none)'}`))
    help()
    process.exit(1)
}
