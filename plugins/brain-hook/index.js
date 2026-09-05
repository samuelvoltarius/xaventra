/**
 * Brain Hook Plugin — Nova Plugin
 *
 * Before every LLM call, fetches relevant context from:
 *   1. qmd  — local BM25+vector file search (knowledge base, notes, docs)
 *   2. Brain API — Graphiti episodic memory on Brutus server
 *
 * Context is injected as a system message prepended to the conversation.
 *
 * Config (nova.config.json → plugins.brain-hook):
 *   qmdBin       — path to qmd binary (default: "qmd")
 *   qmdIndex     — path to qmd index directory
 *   brainUrl     — Graphiti Brain API base URL (default: http://brutus:8765)
 *   minScore     — minimum relevance score to include a result (default: 0.65)
 *   maxResults   — max results from each source (default: 5)
 *   enabled      — set false to disable without uninstalling
 */

import { spawn } from 'node:child_process'

// ── Config defaults ──────────────────────────────────────────────────────────

const DEFAULTS = {
    qmdBin:     'qmd',
    qmdIndex:   '',           // optional: explicit index path
    brainUrl:   'http://brutus:8765',
    minScore:   0.65,
    maxResults: 5,
    enabled:    true,
}

// ── qmd client ───────────────────────────────────────────────────────────────

/**
 * Run a qmd vector search and return results above minScore.
 * qmd CLI: qmd vsearch "<query>" [--index <dir>] --json --top <n>
 */
async function qmdSearch(query, cfg) {
    return new Promise((resolve) => {
        const args = ['vsearch', query, '--json', '--top', String(cfg.maxResults)]
        if (cfg.qmdIndex) args.push('--index', cfg.qmdIndex)

        let stdout = ''
        let stderr = ''
        const proc = spawn(cfg.qmdBin, args, { timeout: 5000 })

        proc.stdout.on('data', d => { stdout += d })
        proc.stderr.on('data', d => { stderr += d })

        proc.on('close', (code) => {
            if (code !== 0) {
                // qmd not installed or index missing — silent fail
                resolve([])
                return
            }
            try {
                const raw = JSON.parse(stdout)
                const results = Array.isArray(raw) ? raw : (raw.results || [])
                resolve(
                    results
                        .filter(r => (r.score ?? 1) >= cfg.minScore)
                        .map(r => ({
                            source: 'qmd',
                            title:  r.title || r.path || r.file || 'Note',
                            score:  r.score ?? 1,
                            text:   r.content || r.text || r.snippet || '',
                        }))
                )
            } catch {
                resolve([])
            }
        })

        proc.on('error', () => resolve([]))
    })
}

// ── Brain API client ─────────────────────────────────────────────────────────

/**
 * Query the Graphiti Brain API (episodic memory on Brutus).
 * POST /search { query, limit, types }
 */
async function brainSearch(query, cfg) {
    const url = `${cfg.brainUrl}/search`
    try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 5000)

        const resp = await fetch(url, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                query,
                limit:  cfg.maxResults,
                types:  ['fact', 'decision', 'preference'],  // exclude transcripts
            }),
            signal: controller.signal,
        })
        clearTimeout(timer)

        if (!resp.ok) return []

        const data = await resp.json()
        const results = data.results || data.episodes || []

        return results
            .filter(r => (r.score ?? r.relevance ?? 1) >= cfg.minScore)
            .map(r => ({
                source: 'brain',
                title:  r.type ? `[${r.type}]` : '[memory]',
                score:  r.score ?? r.relevance ?? 1,
                text:   r.content || r.fact || r.text || '',
            }))
    } catch {
        // Brain server offline — silent fail
        return []
    }
}

// ── Context block builder ────────────────────────────────────────────────────

function buildContextBlock(results) {
    if (results.length === 0) return null

    const lines = ['## 🧠 Brain Context (retrieved)', '']

    // Group by source
    const bySource = {}
    for (const r of results) {
        if (!bySource[r.source]) bySource[r.source] = []
        bySource[r.source].push(r)
    }

    if (bySource.brain?.length) {
        lines.push('### Episodic Memory (Graphiti)')
        for (const r of bySource.brain) {
            lines.push(`- ${r.title} (score: ${r.score.toFixed(2)}): ${r.text.trim()}`)
        }
        lines.push('')
    }

    if (bySource.qmd?.length) {
        lines.push('### Knowledge Base (qmd)')
        for (const r of bySource.qmd) {
            const snippet = r.text.trim().slice(0, 400)
            lines.push(`**${r.title}** (score: ${r.score.toFixed(2)})`)
            lines.push(snippet)
            lines.push('')
        }
    }

    lines.push('---')
    lines.push('Use the context above if relevant. Ignore if unrelated to the current question.')

    return lines.join('\n')
}

// ── Extract query from messages ──────────────────────────────────────────────

function extractQuery(messages) {
    // Find the last user message to use as search query
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
            const text = messages[i].content || ''
            // Trim to 300 chars — enough context for a good embedding
            return text.slice(0, 300)
        }
    }
    return ''
}

// ── Plugin entry point ───────────────────────────────────────────────────────

export async function activate(ctx) {
    const rawConfig = ctx.getConfig()
    const pluginCfg = (rawConfig?.plugins?.['brain-hook']) || {}
    const cfg = { ...DEFAULTS, ...pluginCfg }

    if (!cfg.enabled) {
        ctx.log('Brain Hook disabled via config — skipping registration')
        return
    }

    ctx.log(`Brain Hook activated — brain: ${cfg.brainUrl}, minScore: ${cfg.minScore}`)

    ctx.registerHook('beforeLLMCall', async (payload) => {
        const { messages, userId, channel } = payload

        const query = extractQuery(messages)
        if (!query || query.length < 10) {
            // Query too short — not worth searching
            return payload
        }

        // Parallel fetch from both sources
        const [qmdResults, brainResults] = await Promise.all([
            qmdSearch(query, cfg),
            brainSearch(query, cfg),
        ])

        const allResults = [...brainResults, ...qmdResults]
            .sort((a, b) => b.score - a.score)
            .slice(0, cfg.maxResults * 2)  // combined cap

        if (allResults.length === 0) {
            return payload
        }

        const contextBlock = buildContextBlock(allResults)
        if (!contextBlock) return payload

        ctx.log(`Injecting ${allResults.length} context items (brain: ${brainResults.length}, qmd: ${qmdResults.length})`)

        // Prepend context as a system message at the start of the messages array
        return {
            ...payload,
            messages: [
                { role: 'system', content: contextBlock },
                ...messages,
            ],
        }
    })

    ctx.log('beforeLLMCall hook registered')
}

export async function deactivate() {
    // Nothing to clean up — hooks are cleared by PluginManager.shutdown()
}
