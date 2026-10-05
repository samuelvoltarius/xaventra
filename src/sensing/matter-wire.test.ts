import { it, expect } from 'vitest'
import { buildSync } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
it('builds real pinned SDK wildcard read and argument-free exact OnOff invoke/readback paths', () => {
    // Exercise the actual source against the real SDK in native Node ESM,
    // rather than routing thousands of SDK modules through Vitest's mock loader.
    // The child still has a stricter 15 s deadline; no mocks or relaxed oracle.
    const source = buildSync({ entryPoints: [fileURLToPath(new URL('./matter-wire.ts', import.meta.url))], bundle: true,
        packages: 'external', platform: 'node', format: 'esm', write: false }).outputFiles[0].text
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', source + `
        const refresh = await matterRefreshRequest();
        const switches = await Promise.all([true, false].map(on => matterSwitchRequests(7, on)));
        let invalidRejected = false;
        try { await matterSwitchRequests(0, true) } catch { invalidRejected = true }
        console.log(JSON.stringify({ refresh, switches, invalidRejected }));
    `], { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8', timeout: 15_000 })
    const result = JSON.parse(output.trim())
    expect(result.refresh).toMatchObject({ attributeRequests: [{}], isFabricFiltered: true })
    for (const [index, on] of [true, false].entries()) {
        const request = result.switches[index]
        expect(request.invoke.invokeRequests).toHaveLength(1)
        expect(request.invoke.invokeRequests[0].commandPath).toEqual({ endpointId: 7, clusterId: 6, commandId: on ? 1 : 0 })
        expect(request.read.attributeRequests).toEqual([{ endpointId: 7, clusterId: 6, attributeId: 0 }])
    }
    expect(result.invalidRejected).toBe(true)
}, 20_000)
