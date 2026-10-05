import { defineConfig } from 'vitest/config'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Short, unique fixture roots prevent Windows Git object paths exceeding 260
// characters in nested worktrees and keep concurrent runs isolated.
const testTempRoot = mkdtempSync(join(tmpdir(), 'xaventra-test-'))
process.env.TMP = testTempRoot
process.env.TEMP = testTempRoot

export default defineConfig({
    cacheDir: join(testTempRoot, 'vite-cache'),
    test: {
        globals: true,
        environment: 'node',
        // Bound worker pressure: process-/lease-timing tests must not compete
        // with dozens of unrelated cold imports and native backends by default.
        maxWorkers: 1,
        include: ['src/**/*.test.ts'],
        setupFiles: ['./test/vitest.setup.ts'],
    },
})
