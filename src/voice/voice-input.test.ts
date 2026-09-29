import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// MI-14: transcription must not block the event loop (no execSync) and the
// whisper CLI result must be read from where whisper actually writes it.

const childProcess = vi.hoisted(() => ({
    execSync: vi.fn(() => ''),
    execFile: vi.fn(),
}))
vi.mock('node:child_process', () => childProcess)

import { transcribe } from './voice-input.js'

beforeEach(() => { childProcess.execSync.mockClear(); childProcess.execFile.mockReset() })

describe('MI-14 voice transcription', () => {
    it('runs faster-whisper asynchronously with argv, never through execSync', async () => {
        const audio = join(mkdtempSync(join(tmpdir(), 'nova-mi14-')), 'voice $(id) x.ogg')
        writeFileSync(audio, 'x')
        childProcess.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
            setTimeout(() => callback(null, JSON.stringify({ text: 'hallo nova', language: 'de', duration: 1.2 })), 5)
        })
        const result = await transcribe(audio, { model: 'faster-whisper', pythonPath: 'python3' })
        expect(result.text).toBe('hallo nova')
        expect(childProcess.execSync).not.toHaveBeenCalled()
        const [file, args] = childProcess.execFile.mock.calls[0] as unknown as [string, string[]]
        expect(file).toBe('python3')
        expect(args).toContain(audio)
        expect(args[1]).not.toContain(audio)
    })

    it('falls back to whisper with --output_dir next to the audio and reads that file', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-mi14-'))
        const audio = join(dir, 'note.ogg')
        writeFileSync(audio, 'x')
        childProcess.execFile.mockImplementation((file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
            if (file !== 'whisper') return void setTimeout(() => callback(new Error('no faster-whisper'), ''), 1)
            const outputDir = args[args.indexOf('--output_dir') + 1]
            writeFileSync(join(outputDir, 'note.txt'), 'guten morgen\n')
            setTimeout(() => callback(null, ''), 1)
        })
        const result = await transcribe(audio, { model: 'faster-whisper', pythonPath: 'python3', language: 'de' })
        expect(result.text).toBe('guten morgen')
        expect(childProcess.execSync).not.toHaveBeenCalled()
        const whisperCall = childProcess.execFile.mock.calls.find(call => call[0] === 'whisper') as unknown as [string, string[]]
        expect(whisperCall[1]).toEqual([audio, '--output_format', 'txt', '--output_dir', dir, '--language', 'de'])
    })
})
