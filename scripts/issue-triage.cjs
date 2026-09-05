const { existsSync } = require('node:fs')
const { join } = require('node:path')

const MARKER = '<!-- xaventra-issue-triage:v1 -->'
// Fixed trusted paths, never file paths or commands supplied by an issue author.
const AREAS = [
  { name: 'Tools / execution', match: /\b(tool|tools|executor|execution|werkzeug|ausführ\w*)\b/i, paths: ['src/agents/nova-runner.ts', 'src/core/execution-kernel.ts'], test: 'npm test -- src/core/execution-kernel.test.ts' },
  { name: 'Memory / resume', match: /memory|memories|gedächtnis|vergisst|resume|checkpoint/i, paths: ['src/agents/session-checkpoints.ts', 'src/core/outcome-ledger.ts'], test: 'npm test -- src/agents/session-checkpoints.test.ts' },
  { name: 'Desktop', match: /desktop|electron|scroll|\bui\b/i, paths: ['desktop/main.cjs', 'src/dashboard/server.ts'], test: 'npm run test:desktop' },
  { name: 'Providers / routing', match: /model|provider|vllm|ollama|codex/i, paths: ['src/core/llm-factory.ts', 'src/llm/provider-manifest.ts'], test: 'npm test -- src/llm/provider-manifest.test.ts' },
  { name: 'Mesh / failover', match: /mesh|failover|lease|node|split.brain/i, paths: ['src/mesh/leader-election.ts', 'src/core/ha-state.ts'], test: 'npm test -- src/core/ha-state.test.ts' },
  { name: 'Channels / identity', match: /telegram|channel|owner|admin|login|permission/i, paths: ['src/core/message-pipeline.ts', 'src/users/multi-user-middleware.ts'], test: 'npm test -- src/users/owner-authorization.test.ts' },
  { name: 'Configuration / setup', match: /config|setup|install|start/i, paths: ['src/config/config-path.ts', 'src/daemon.ts'], test: 'npm test -- src/config/config-path.test.ts' },
]

function triageIssue(issue, root = process.cwd()) {
  const text = `${String(issue.title || '').slice(0, 500)}\n${String(issue.body || '').slice(0, 50_000)}`
  const areas = AREAS.filter(area => area.match.test(text)).map(area => ({
    name: area.name, paths: area.paths.filter(path => existsSync(join(root, path))), test: area.test,
  }))
  const missing = []
  if (!/\b\d+\.\d+\.\d+\b/.test(text)) missing.push('Xaventra version')
  if (!/windows|linux|macos|mac os|docker|raspberry|synology/i.test(text)) missing.push('OS / deployment type')
  if (!/steps|reproduc|schritte|nachstellen/i.test(text)) missing.push('minimal reproduction steps, expected result and actual result')
  return { areas, missing }
}

function renderTriage(result, sha) {
  const lines = [MARKER, '### Automated first-pass triage', '',
    'This is a keyword-based code-path suggestion, **not a reproduced bug, security verdict or completed fix**.',
    `Source revision: \`${/^[a-f0-9]{40}$/i.test(sha || '') ? sha : 'local check'}\`.`, '']
  for (const area of result.areas) {
    lines.push(`- ${area.name}: ${area.paths.map(path => `\`${path}\``).join(', ')}. Suggested existing check: \`${area.test}\`.`)
  }
  if (!result.areas.length) lines.push('No clear component match; maintainer review is needed.')
  if (result.missing.length) lines.push('', `Please include: ${result.missing.join('; ')}.`)
  lines.push('', 'Do not post tokens, private configuration, personal memory or unredacted logs. Suspected vulnerabilities belong in the private reporting channel described in SECURITY.md.',
    'Issue content is never executed. This hook does not run commands from reports, deploy, close issues, or approve changes.')
  return lines.join('\n')
}

async function run({ github, context, core }) {
  const dryRun = context.eventName === 'workflow_dispatch'
  const issue = dryRun ? { title: 'Tool and memory smoke', body: 'Version 2.78.0 on Linux. Reproduction steps provided.' } : context.payload.issue
  if (!issue || issue.pull_request || issue.state === 'closed' || issue.locked) return
  const body = renderTriage(triageIssue(issue), context.sha)
  await core.summary.addRaw(body).write()
  if (dryRun) return
  const params = { ...context.repo, issue_number: issue.number }
  const comments = await github.paginate(github.rest.issues.listComments, { ...params, per_page: 100 })
  const previous = comments.find(comment => comment.user?.login === 'github-actions[bot]' && comment.body?.startsWith(MARKER))
  if (previous?.body === body) return
  if (previous) await github.rest.issues.updateComment({ ...context.repo, comment_id: previous.id, body })
  else await github.rest.issues.createComment({ ...params, body })
}
module.exports = { MARKER, triageIssue, renderTriage, run }
