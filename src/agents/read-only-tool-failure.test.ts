import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readOnlyFailureContinues } from '../core/action-lifecycle.js'
import { isSuccessfulToolResult } from '../tools/tool-result-quality.js'
import { loadSkillPackTool } from '../tools/tool-router.js'

describe('a failing catalog lookup does not stop the run', () => {
    it('lets catalog lookups fail softly', () => {
        for (const name of ['load_skill_pack', 'nova_capabilities', 'find_capability', 'list_skills'])
            expect(readOnlyFailureContinues(name), name).toBe(true)
    })

    it('keeps stopping (and escalating to the Doctor) for diagnostic reads, effects and unknown tools', () => {
        for (const name of ['health_status', 'read_file', 'nova_introspect', 'desktop_screenshot', 'run_command', 'write_file', 'build_skill', 'some_new_tool', ''])
            expect(readOnlyFailureContinues(name), name).toBe(false)
    })

    it('runner consults it at both failure sites (verification and thrown error)', () => {
        // runNovaAgent cannot be driven without a full model stack; pin the contract.
        const source = readFileSync(new URL('./nova-runner.ts', import.meta.url), 'utf8')
        expect(source).toContain('if (!verifiedSuccess && !recoveredSuccess && !readOnlyFailureContinues(call.name)) hasToolErrors = true')
        expect(source).toMatch(/if \(!readOnlyFailureContinues\(call\.name\)\) hasToolErrors = true\n\s*toolExecutions\.push\(\{\n\s*callId,\n\s*toolName: call\.name,\n\s*params: call\.arguments \|\| \{\},\n\s*result: String\(err\)/)
    })
})

describe('load_skill_pack with an unknown pack', () => {
    it('answers with the catalog instead of a failure (live: pack "system")', async () => {
        const result = await loadSkillPackTool.handler({ pack_name: 'system' })
        expect(isSuccessfulToolResult(result)).toBe(true)
        expect(JSON.stringify(result)).toContain('web-search')
    })
})
