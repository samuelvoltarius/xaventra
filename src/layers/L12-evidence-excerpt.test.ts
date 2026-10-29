import { describe, expect, it } from 'vitest'
import { setInternalLLM, validateWithLLM } from './L12-anti-hallucination.js'

// 2.89.14 (Kurzabnahme 29.10. 03:29:44): "öffne heise.de und sag mir die erste Schlagzeile" - L12 judged the real
// headline "UNEHRLICH" because the second opinion only saw the first 200 characters of each tool result.
describe('L12 second opinion sees enough of each tool result', () => {
    it('a headline after 1000 characters of page text reaches the checker', async () => {
        const prompts: string[] = []
        setInternalLLM({ complete: async (messages: Array<{ content: string }>) => { prompts.push(messages[0].content); return { content: '{"honest": true, "issues": []}' } } })
        const page = `${'Navigation Menü Abo Login Suche '.repeat(35)}Neues LLM: Gemini 4 Carbon ist Exploit-Experte`
        expect(page.indexOf('Gemini 4 Carbon')).toBeGreaterThan(1000)
        const verdict = await validateWithLLM('Die erste Schlagzeile: „Neues LLM: Gemini 4 Carbon ist Exploit-Experte“.', [
            { toolName: 'fetch_url', success: true, result: JSON.stringify({ url: 'https://www.heise.de/', content: page }) } as any,
        ])
        expect(verdict.honest).toBe(true)
        const evidence = prompts[0].slice(prompts[0].indexOf('TOOL-ERGEBNISSE'), prompts[0].indexOf('AI-ANTWORT'))
        expect(evidence).toContain('Gemini 4 Carbon ist Exploit-Experte')
    })

    it('the prompt stays bounded with many large results', async () => {
        const prompts: string[] = []
        setInternalLLM({ complete: async (messages: Array<{ content: string }>) => { prompts.push(messages[0].content); return { content: '{"honest": true, "issues": []}' } } })
        const big = 'x'.repeat(50_000)
        await validateWithLLM('ok', Array.from({ length: 10 }, (_, i) => ({ toolName: `t${i}`, success: true, result: big }) as any))
        expect(prompts[0].length).toBeLessThan(20_000)
    })
})
