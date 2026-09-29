import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const child = vi.hoisted(() => ({ spawn: vi.fn(), result: { code: 0, stdout: '', write: false } }))
vi.mock('node:child_process', async (original) => ({
    ...(await original() as object),
    spawn: (...args: any[]) => {
        child.spawn(...args)
        const proc: any = new EventEmitter()
        proc.stdout = new EventEmitter()
        proc.stderr = new EventEmitter()
        setTimeout(() => {
            if (child.result.write) writeFileSync(join(args[2].cwd, 'output.stl'), 'solid')
            proc.stdout.emit('data', Buffer.from(child.result.stdout))
            proc.emit('close', child.result.code)
        }, 0)
        return proc
    },
}))

let root = ''
let cad: typeof import('./cad-tool.js')
beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'cad-'))
    vi.spyOn(process, 'cwd').mockReturnValue(root)
    vi.resetModules()
    cad = await import('./cad-tool.js')
})
beforeEach(() => { child.spawn.mockClear(); child.result = { code: 0, stdout: 'SUCCESS:output.stl', write: true } })
const projects = () => join(root, '.nova-data', 'cad', 'projects')

describe('R2 T14: cad_generate keeps project names and descriptions out of paths, shells and code', () => {
    it.each(['../../../x', 'a;$(echo x|base64 -d|sh);', '..', 'a/b', ''])('refuses project name %j', async (projectName) => {
        const result = await cad.cadGenerateTool.handler({ description: 'cube 10mm', projectName }) as any
        expect(result.success).toBe(false)
        expect(child.spawn).not.toHaveBeenCalled()
        expect(existsSync(join(root, 'x'))).toBe(false)
    })
    it('runs python without a shell and embeds the description only as a string literal', async () => {
        const description = 'cube\\"""\nimport os; os.system("calc")\n"""'
        await cad.cadGenerateTool.handler({ description, projectName: 'p1' })
        const [file, args, options] = child.spawn.mock.calls[0] as [string, string[], any]
        expect(file).toBe('python')
        expect(options.shell).toBeUndefined()
        const script = readFileSync(args[0], 'utf8')
        expect(script).toContain(`DESCRIPTION = ${JSON.stringify(description)}`)
        expect(script.split('\n').filter(line => line.startsWith('import os; os.system'))).toHaveLength(0)
    })
})

describe('R2 T26: no success without a freshly exported file', () => {
    it('reports failure when the script failed, even with exit 0', async () => {
        child.result = { code: 0, stdout: 'ERROR:BuildPart has no attribute build', write: false }
        expect((await cad.cadGenerateTool.handler({ description: 'hex bolt', projectName: 'p2' }) as any).success).toBe(false)
    })
    it('does not report an old output file as the new result', async () => {
        const dir = join(projects(), 'p3')
        await cad.cadGenerateTool.handler({ description: 'cube', projectName: 'p3' })
        expect(readdirSync(dir)).toContain('output.stl')
        child.result = { code: 0, stdout: 'SUCCESS:output.stl', write: false }
        expect((await cad.cadGenerateTool.handler({ description: 'cube', projectName: 'p3' }) as any).success).toBe(false)
    })
    it('uses the build123d exporter and no non-existent BuildPart().build()', async () => {
        await cad.cadGenerateTool.handler({ description: 'hex', projectName: 'p4' })
        const script = readFileSync((child.spawn.mock.calls[0] as any)[1][0], 'utf8')
        expect(script).not.toContain('BuildPart().build()')
        expect(script).not.toContain('exporters.export')
        expect(script).toContain('export_stl(part.part, export_path)')
        expect(script).toContain('sys.exit(1)')
    })
})
