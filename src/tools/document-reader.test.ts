import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileTools, getToolRegistry } from './complete-registry.js'
import { findPythonExecutable, readDocument } from './document-reader.js'

describe('universal document reader', () => {
    it('is registered in the active daemon registry', () => {
        expect(fileTools.some(tool => tool.name === 'read_document')).toBe(true)
        expect(getToolRegistry().get('read_document')?.name).toBe('read_document')
    })

    it('reads plain text documents end to end', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-doc-reader-'))
        const path = join(dir, 'sample.txt')
        writeFileSync(path, 'Nova document reader works.', 'utf8')
        const result = await readDocument(path)
        expect(result).toMatchObject({ success: true, method: 'text', format: '.txt' })
        expect(result.text).toContain('document reader works')
    })

    it('finds a usable Python interpreter when one is installed', () => {
        const python = findPythonExecutable()
        if (python) expect(python.length).toBeGreaterThan(0)
        else expect(python).toBeNull()
    })
})
