import { describe, expect, it } from 'vitest'
import { runtimeQuestion } from './runtime-question.js'

describe('whole-request runtime introspection', () => {
    it('answers a model question but routes its additional why clause through the agent', () => {
        expect(runtimeQuestion('Welches Model nutzt du gerade ?')?.model).toBe(true)
        expect(runtimeQuestion('Welches Model nutzt du gerade ? Und warum willst auf auf na1 ein llm. ?')).toBeNull()
        expect(runtimeQuestion('Welches Modell nutzt du und installiere es auf ns1')).toBeNull()
        expect(runtimeQuestion('Warum nutzt du dieses Modell?')).toBeNull()
        expect(runtimeQuestion('Welche Knoten brauchen ein Update?')).toBeNull()
    })
    it('resolves the reported typo only immediately after this session model answer', () => {
        const question = 'Kannst du den genehmen Namen rausfinden'
        expect(runtimeQuestion(question, [{ role: 'assistant', content: 'Konfiguriertes Runtime-Modell: local/qwen.' }])?.model).toBe(true)
        expect(runtimeQuestion(question)).toBeNull()
        expect(runtimeQuestion(question, [{ role: 'assistant', content: 'Eine Datei heißt so.' }])).toBeNull()
        expect(runtimeQuestion(question + ' und ändere es', [{ role: 'assistant', content: 'Aktives Runtime-Modell: local/qwen.' }])).toBeNull()
    })
})
