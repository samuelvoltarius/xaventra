/**
 * Live 2.82.0 (Spark): vLLM reserves GPU unified memory permanently
 * (--gpu-memory-utilization), RAM sits at ~92 %. With RAM warn at 90 % the L0
 * health monitor reported "Memory hoch: 92%" all day and Telegram from 7 am.
 * On a vLLM node the percentage is not the danger signal: available memory
 * below a reserve, growing swap and OOM kills are.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
    assessMemory, detectVllmProcess, isVllmNode, markVllmNode, parseMeminfo, parseResourceThresholds, setResourceThresholds,
} from './resource-thresholds.js'

const src = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')

afterEach(() => { setResourceThresholds(undefined); markVllmNode(null) })

// Spark-like: 128 GB unified memory, vLLM holds most of it, ~10 GB available, no swap growth.
const TOTAL_MB = 128_000
const spark = { usedPercent: 92, totalMB: TOTAL_MB, availableMB: 10_240, swapUsedMB: 300, oomKills: 0 }

describe('RAM-Schwelle am vLLM-Knoten', () => {
    it('92 % mit vLLM-Reservierung ist kein Befund', () => {
        expect(assessMemory(spark, { vllmNode: true }).level).toBe('ok')
    })

    it('Gegenprobe: ohne vLLM bleiben 92 % eine Warnung', () => {
        expect(assessMemory(spark, { vllmNode: false }).level).toBe('warn')
    })

    it('echte Gefahr am vLLM-Knoten: wenig verfügbar, Swap wächst, OOM-Kill', () => {
        expect(assessMemory({ ...spark, usedPercent: 97, availableMB: 3_000 }, { vllmNode: true }).level).toBe('warn')
        expect(assessMemory({ ...spark, usedPercent: 99, availableMB: 1_200 }, { vllmNode: true }).level).toBe('crit')
        const swapping = assessMemory({ ...spark, swapUsedMB: 2_500 }, { vllmNode: true, previous: spark })
        expect(swapping.level).toBe('warn')
        expect(swapping.reason).toMatch(/Swap/)
        const oom = assessMemory({ ...spark, oomKills: 1 }, { vllmNode: true, previous: spark })
        expect(oom.level).toBe('crit')
        expect(oom.reason).toMatch(/OOM/)
    })

    it('OOM-Kill ist auch ohne vLLM kritisch', () => {
        expect(assessMemory({ usedPercent: 50, totalMB: 16_000, oomKills: 3 }, { vllmNode: false, previous: { usedPercent: 50, totalMB: 16_000, oomKills: 2 } }).level).toBe('crit')
    })

    it('Reserve und Swap-Zuwachs sind in autonomy.thresholds einstellbar', () => {
        const t = parseResourceThresholds({ memory: { vllmMinAvailableMB: 16_000, vllmSwapGrowthMB: 100, vllmNode: true } })
        expect(t.memory).toMatchObject({ vllmMinAvailableMB: 16_000, vllmSwapGrowthMB: 100, vllmNode: true })
        expect(assessMemory(spark, { vllmNode: true }, t).level).toBe('warn')
    })

    it('vLLM-Knoten: Config-Vorgabe > Knotenprofil > laufender vLLM-Prozess', () => {
        const withVllm = () => ['/usr/bin/python3 -m vllm.entrypoints.openai.api_server --model qwen']
        const without = () => ['/usr/bin/node dist/daemon.js', 'sshd: user']
        expect(detectVllmProcess(withVllm)).toBe(true)
        expect(detectVllmProcess(without)).toBe(false)
        expect(isVllmNode({ listCommandLines: without })).toBe(false)
        markVllmNode(true)
        expect(isVllmNode({ listCommandLines: without })).toBe(true)
        setResourceThresholds({ thresholds: { memory: { vllmNode: false } } })
        expect(isVllmNode({ listCommandLines: withVllm })).toBe(false)
    })

    it('liest MemAvailable, Swap und OOM-Kills aus /proc', () => {
        const meminfo = 'MemTotal:       131072000 kB\nMemFree:          2048000 kB\nMemAvailable:   10485760 kB\nSwapTotal:       8388608 kB\nSwapFree:        8081408 kB\n'
        expect(parseMeminfo(meminfo, 'pgfault 1\noom_kill 4\n')).toEqual({ totalMB: 128000, availableMB: 10240, swapUsedMB: 300, oomKills: 4 })
    })

    it('L0, Knoten-Selbstprüfung und L15 nutzen die vLLM-bewusste Bewertung', () => {
        expect(src('layers/L0-health-monitor.ts')).toMatch(/assessLocalMemory\(/)
        expect(src('core/node-profile.ts')).toMatch(/assessLocalMemory\(|markVllmNode\(/)
        expect(src('layers/L15-self-check.ts')).not.toMatch(/memoryLevel\(health\.memory\?\.usedPercent\)/)
        expect(src('layers/L21-node-health.ts')).toMatch(/assessMemory\(/)
    })
})
