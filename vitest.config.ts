import { defineConfig } from 'vitest/config'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const testTempRoot = join(process.cwd(), '.nova-test-tmp')
mkdirSync(testTempRoot, { recursive: true })
process.env.TMP = testTempRoot
process.env.TEMP = testTempRoot

export default defineConfig({
    cacheDir: join(testTempRoot, 'vite-cache'),
    test: {
        globals: true,
        environment: 'node',
        include: ['src/**/*.test.ts'],
        setupFiles: ['./test/vitest.setup.ts'],
    },
})
