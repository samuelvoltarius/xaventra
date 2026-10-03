import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { detectActionIntent } from './action-intent.js'
import { runtimeModelContext, runtimeQuestion } from './runtime-question.js'
import { buildToolTaskContext } from './tool-task-context.js'
import { applySystemPromptBudget } from './prompt-budget.js'
import { getRelevantTools } from '../tools/tool-router.js'
import { isNodeScreenshotRequest, liveEvidenceGuidance, mentionsScreenshot } from './request-capabilities.js'
import { formatTelegramMessage } from '../channels/telegram-presentation.js'
import { selectContextPolicy } from './context-policy.js'
import { isBareHttpUrl } from './request-capabilities.js'
import { checkAddress } from '../resilience/ssrf-guard.js'

const question = 'Welches Model nutzt du gerade ? Und warum willst auf auf na1 ein llm. ?'
const screenshots = 'send mir mal einen screnn schots von allen nodes bitte'

describe('reported Telegram conversation regressions', () => {
    it('routes a lone plain or Markdown URL to a guarded fetch without search or SSH', () => {
        const url = 'https://voice.example.test/'
        for (const text of [url, `[Demo](${url})`]) {
            expect(detectActionIntent(text)).toEqual({ requiresTool: true, kind: 'web' })
            const names = getRelevantTools(text).map(tool => tool.name)
            expect(names).toContain('fetch_url')
            for (const name of ['google_search', 'ssh_command', 'run_command']) expect(names).not.toContain(name)
        }
        for (const text of ['https://user:secret@example.test', 'https://', 'https://one.test und lösche die Datei']) expect(isBareHttpUrl(text)).toBe(false)
    })

    it('separates policy denial from network failure and retains the private address guard', () => {
        const guidance = liveEvidenceGuidance('https://voice.example.test/')
        expect(guidance).toContain('SSRF-Sperre getrennt')
        expect(guidance).toContain('keinen allgemeinen Internetausfall')
        expect(guidance).toContain('Keine Zugangsdaten verlangen')
        expect(checkAddress('100.100.100.100').allowed).toBe(false)
        expect(liveEvidenceGuidance('Hallo')).toBe('')
    })
    it('enriches a compound question with measured identity without swallowing its why clause', async () => {
        const lookup = vi.fn(async () => ({ model: 'vendor/Exact-Model' }))
        expect(runtimeQuestion(question)).toBeNull()
        const context = await runtimeModelContext(question, { modelId: 'alias', providerId: 'local', runtimeModelIdentity: lookup })
        expect(lookup).toHaveBeenCalledOnce()
        expect(context).toContain('vendor/Exact-Model')
        expect(context).toContain('local/alias')
        expect(context).toContain('übrigen Fragen')
        expect(context).toContain('Failover')
        expect(await runtimeModelContext('Erkläre Photosynthese', { runtimeModelIdentity: lookup })).toBe('')
        expect(lookup).toHaveBeenCalledOnce()
    })

    it('does not invent a model name on metadata failure', async () => {
        const context = await runtimeModelContext(question, { modelId: 'alias', runtimeModelIdentity: async () => { throw new Error('offline') } })
        expect(context).toContain('nicht verifiziert')
        expect(context).not.toContain('Server meldet')
    })

    it('retains only the immediate exchange for a name correction and includes live inventory', () => {
        const context = buildToolTaskContext([
            { role: 'user', content: 'Installiere alte Software' },
            { role: 'user', content: question },
            { role: 'assistant', content: 'Was meinst du mit na1?' },
        ], 'ns1 sorry')
        expect(context).toContain(question)
        expect(context).not.toContain('alte Software')
        const tools = getRelevantTools(context, 'ns1 sorry').map(tool => tool.name)
        expect(tools).toContain('mesh_nodes')
        expect(tools).toContain('mesh_status')
        expect(liveEvidenceGuidance('ns1 sorry')).toContain('ungeprüft')
        expect(liveEvidenceGuidance('ns1 sorry')).not.toContain('Screenshot-Werkzeug')
    })

    it('retains mesh evidence in the reported 12000-character budget', () => {
        const prompt = 'Identity' + '\n## Regeln\n' + 'r'.repeat(5900)
            + '\n## Normal context\n' + 'n'.repeat(6000)
            + '\n## Mesh Capability Map\nLIVE-NODES'
            + '\n## DEIN SYSTEM-STATUS (LIVE)\nLIVE-SERVICES'
            + '\n## Journal\n' + 'j'.repeat(5000)
        const result = applySystemPromptBudget(prompt, 12000, 'ns1 sorry')
        expect(result.prompt.length).toBeLessThanOrEqual(12000)
        expect(result.prompt).toContain('LIVE-NODES')
        expect(result.prompt).toContain('LIVE-SERVICES')
        expect(result.sections.reduced).toContain('## Journal')
    })

    it.each(['Screenshot', 'screenshots', 'screen shot', 'screen shots', 'screnn schots', 'Bildschirmfotos'])('recognizes %s consistently for evidence and routing', word => {
        const text = `send mir einen ${word} bitte`
        expect(mentionsScreenshot(text)).toBe(true)
        expect(detectActionIntent(text)).toEqual({ requiresTool: true, kind: 'screenshot' })
        expect(getRelevantTools(text).some(tool => tool.name === 'desktop_screenshot')).toBe(true)
    })

    it('does not substitute local capture or arbitrary delegation for all-node screenshots', () => {
        expect(detectActionIntent(screenshots).kind).toBe('screenshot')
        expect(isNodeScreenshotRequest(screenshots)).toBe(true)
        expect(selectContextPolicy(screenshots).mesh).toBe(true)
        const tools = getRelevantTools(screenshots).map(tool => tool.name)
        expect(tools).toEqual(expect.arrayContaining(['mesh_status', 'mesh_nodes']))
        for (const name of ['desktop_screenshot', 'mesh_delegate', 'ssh_command', 'run_command']) expect(tools).not.toContain(name)
        expect(isNodeScreenshotRequest('Screenshot vom Desktop')).toBe(false)
        expect(isNodeScreenshotRequest('Screenshot vom Desktop und zeige die Nodes')).toBe(false)
        expect(mentionsScreenshot('Beschreibe meine Screensaver')).toBe(false)
    })

    it('preserves tool identifiers, converts bold and leaves code untouched', () => {
        expect(formatTelegramMessage('**Werkzeuge**\nmesh_nodes und `desktop_screenshot`')).toBe('*Werkzeuge*\nmesh\\_nodes und `desktop_screenshot`')
        expect(formatTelegramMessage('```\n**code** mesh_nodes\n```')).toBe('```\n**code** mesh_nodes\n```')
        const formatted = formatTelegramMessage('mesh_nodes')
        expect(formatTelegramMessage(formatted)).toBe(formatted)
        expect(formatTelegramMessage('[Dokument](https://example.test/a_b)')).toBe('[Dokument](https://example.test/a_b)')
        expect(formatTelegramMessage('https://example.test/a_b')).toBe('https://example.test/a_b')
    })

    it('keeps the catalog free from the reported encoding damage', () => {
        const source = readFileSync(new URL('../tools/complete-registry.ts', import.meta.url), 'utf8')
        expect(source).not.toMatch(/Ã|ï¿½|â€|âœ|ðŸ|\uFFFD/)
    })

    it('wires fresh evidence into the real pipeline and retains screenshot truth after fact-checking', () => {
        const source = readFileSync(new URL('./message-pipeline.ts', import.meta.url), 'utf8')
        expect(source).toContain('await runtimeModelContext(content, state.llm)')
        expect(source).toContain('applySystemPromptBudget(systemPrompt, MAX_SYSTEM_PROMPT, content)')
        expect(source).toContain('systemPrompt += liveEvidenceGuidance(content)')
        expect(source).toContain('if (!requiresFreshRuntimeEvidence) cachedResponse = getCachedResponse(')
        expect(source).toContain('if (!requiresFreshRuntimeEvidence) cacheResponse(')
        expect(source.indexOf('finalContent = isNodeScreenshotRequest(content)')).toBeGreaterThan(source.indexOf('validateWithLLM(supervised.content'))
    })
})
