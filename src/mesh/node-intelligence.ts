/**
 * Node Intelligence
 *
 * Nova entdeckt jeden Node selbst — kein hardcoding von OS-Typen oder Befehlen.
 * Beim ersten Kontakt probiert sie verschiedene Befehle aus, lernt was funktioniert,
 * und speichert ein "Playbook" pro Node das sie beim nächsten Mal direkt benutzt.
 *
 * Prinzip: Probe → Lernen → Speichern → Wiederverwenden
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { exec } from 'node:child_process'

const INTEL_DIR = join(process.cwd(), '.nova-data', 'node-intel')

// ============================================
// Types
// ============================================

export interface NodePlaybook {
    nodeId: string             // hostname oder IP
    discoveredAt: number
    lastUpdated: number
    os: string                 // was sie selbst herausgefunden hat
    arch: string
    hardware: {
        cpu?: string
        cores?: number
        ram_gb?: number
        chip?: string          // Apple Silicon, etc.
        memory_type?: string   // unified, ddr4, ddr5, lpddr5
        storage_gb?: number
        storage_type?: string  // ssd, nvme, hdd, sd
        gpu?: string           // NVIDIA/AMD GPU model
        gpu_vram_gb?: number
        gpu_type?: string      // cuda, metal, rocm, integrated
        cuda_version?: string
        metal?: boolean        // Apple Metal support
    }
    software: {
        [tool: string]: boolean | string  // ollama: true, python: '3.11', etc.
    }
    ollamaModels?: string[]    // Welche Modelle liegen auf diesem Node
    commands: {
        getCpuCores: string
        getLoadAvg: string
        getMemory: string
        getDisk: string
        getTemp: string
        checkProcess: string
        getChip?: string
    }
    healthCmd: string
    probeLog: string[]
}

// ============================================
// SSH Helper
// ============================================

function sshTry(host: string, cmd: string, timeoutMs = 5000): Promise<string | null> {
    return new Promise(resolve => {
        // BatchMode=yes intentionally disables password prompts.
        // Key-based SSH required for background discovery — add the node's public key
        // to ~/.ssh/authorized_keys on the target host to enable auto-discovery.
        const full = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=4 -o BatchMode=yes ${host} "${cmd}"`
        exec(full, { timeout: timeoutMs }, (err, stdout) => {
            if (err) {
                const msg = err.message || ''
                // Surface auth failures clearly so they don't look like connectivity issues
                if (msg.includes('Permission denied') || msg.includes('publickey') || msg.includes('authentication')) {
                    console.debug(`[NodeIntel] 🔑 ${host}: Key-based SSH required for background discovery (BatchMode=yes — password auth disabled). Add SSH key to authorized_keys on target host.`)
                }
                resolve(null)
            } else {
                resolve(stdout.trim())
            }
        })
    })
}

// ============================================
// Discovery Probes
// Nova probiert verschiedene Befehle aus und merkt sich was klappt
// ============================================

const PROBE_OS = [
    { cmd: 'uname -s',           parse: (r: string) => r.includes('Darwin') ? 'macOS' : r.includes('Linux') ? 'Linux' : r },
    { cmd: 'uname -o',           parse: (r: string) => r },
    { cmd: 'cat /etc/os-release | head -2', parse: (r: string) => r.split('\n')[0].replace('NAME=','').replace(/"/g,'') },
]

const PROBE_ARCH = [
    { cmd: 'uname -m', parse: (r: string) => r },
    { cmd: 'arch',     parse: (r: string) => r },
]

const PROBE_CPU_CORES = [
    { cmd: 'nproc',                        check: (r: string) => /^\d+$/.test(r) },
    { cmd: 'sysctl -n hw.logicalcpu',      check: (r: string) => /^\d+$/.test(r) },
    { cmd: 'grep -c processor /proc/cpuinfo', check: (r: string) => /^\d+$/.test(r) },
]

const PROBE_LOAD = [
    { cmd: 'cat /proc/loadavg | cut -d" " -f1-3',  check: (r: string) => r.includes('.') },
    { cmd: 'sysctl -n vm.loadavg | awk \'{print $2,$3,$4}\'', check: (r: string) => r.includes('.') },
    { cmd: 'uptime | grep -oE "[0-9]+\\.[0-9]+(, [0-9]+\\.[0-9]+)+"', check: (r: string) => r.length > 0 },
]

const PROBE_MEMORY = [
    { cmd: 'free -m | awk \'/Mem:/{print $2, $3}\'',  check: (r: string) => /\d+ \d+/.test(r), unit: 'MB' },
    { cmd: 'sysctl -n hw.memsize | awk \'{print int($1/1073741824)}\'', check: (r: string) => /^\d+$/.test(r), unit: 'GB_total' },
    { cmd: 'vm_stat | awk \'/Pages free/{f=$3} /Pages active/{a=$3} END{print int((f+a)*4096/1048576), int((a)*4096/1048576)}\'', check: (r: string) => /\d+ \d+/.test(r), unit: 'MB' },
]

const PROBE_DISK = [
    { cmd: 'df -BG / | awk \'NR==2{print $2, $3}\'',   check: (r: string) => /\d+G \d+G/.test(r) },
    { cmd: 'df -g /  | awk \'NR==2{print $2, $3}\'',   check: (r: string) => /\d+ \d+/.test(r) },
    { cmd: 'df -h /  | awk \'NR==2{print $2, $3}\'',   check: (r: string) => r.length > 0 },
]

const PROBE_TEMP = [
    { cmd: 'cat /sys/class/thermal/thermal_zone0/temp', check: (r: string) => /^\d+$/.test(r) },
    { cmd: 'osx-cpu-temp 2>/dev/null || echo "N/A"',   check: (r: string) => r !== 'N/A' },
    { cmd: 'echo "N/A"', check: (_: string) => true },
]

const PROBE_CHIP = [
    { cmd: 'sysctl -n machdep.cpu.brand_string',                                    check: (r: string) => r.length > 3 },
    { cmd: 'system_profiler SPHardwareDataType 2>/dev/null | grep "Chip:" | awk -F": " \'{print $2}\'', check: (r: string) => r.length > 3 },
    { cmd: 'cat /proc/cpuinfo | grep "model name" | head -1 | cut -d: -f2',        check: (r: string) => r.length > 3 },
    { cmd: 'lscpu | grep "Model name" | cut -d: -f2',                              check: (r: string) => r.length > 3 },
]

const PROBE_PROCESS = [
    { cmd: 'pgrep -f daemon.js > /dev/null && echo running || echo stopped', check: (r: string) => ['running','stopped'].includes(r) },
    { cmd: 'ps aux | grep daemon.js | grep -v grep | wc -l | awk \'{print ($1>0?"running":"stopped")}\'', check: (r: string) => r.length > 0 },
]

const PROBE_SOFTWARE: Array<{ name: string, cmd: string }> = [
    { name: 'ollama',        cmd: 'which ollama' },
    { name: 'python',        cmd: 'which python3 || which python' },
    { name: 'node',          cmd: 'which node' },
    { name: 'docker',        cmd: 'which docker' },
    { name: 'git',           cmd: 'which git' },
    { name: 'ffmpeg',        cmd: 'which ffmpeg' },
    { name: 'faster_whisper',cmd: 'python3 -c "import faster_whisper" 2>/dev/null && echo yes || echo no' },
    { name: 'comfyui',       cmd: 'test -d ~/ComfyUI && echo yes || echo no' },
    { name: 'stable_diffusion', cmd: 'test -d ~/stable-diffusion-webui && echo yes || echo no' },
    { name: 'whisper',       cmd: 'python3 -c "import whisper" 2>/dev/null && echo yes || echo no' },
    { name: 'torch',         cmd: 'python3 -c "import torch; print(torch.__version__)" 2>/dev/null || echo no' },
    { name: 'llama_cpp',     cmd: 'which llama-server || which llama.cpp || test -f ~/llama.cpp/main && echo yes || echo no' },
]

// GPU Probes — NVIDIA, Apple Metal, AMD
const PROBE_GPU_NVIDIA = [
    { cmd: 'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null', check: (r: string) => r.includes(',') },
]
const PROBE_GPU_APPLE = [
    { cmd: 'system_profiler SPDisplaysDataType 2>/dev/null | grep -E "Chipset Model|VRAM"', check: (r: string) => r.length > 3 },
]
const PROBE_GPU_AMD = [
    { cmd: 'rocm-smi --showmeminfo vram 2>/dev/null | grep -i "vram total"', check: (r: string) => r.length > 3 },
    { cmd: 'lspci 2>/dev/null | grep -i "vga\\|3d\\|display" | grep -i amd', check: (r: string) => r.length > 3 },
]
const PROBE_CUDA_VERSION = [
    { cmd: 'nvcc --version 2>/dev/null | grep release | awk \'{print $6}\' | tr -d ,', check: (r: string) => /\d+\.\d+/.test(r) },
    { cmd: 'nvidia-smi 2>/dev/null | grep "CUDA Version" | awk \'{print $9}\'', check: (r: string) => /\d+\.\d+/.test(r) },
]
const PROBE_STORAGE_TYPE = [
    { cmd: 'lsblk -d -o NAME,ROTA 2>/dev/null | grep -v NAME | awk \'NR==1{print ($2=="0"?"nvme/ssd":"hdd")}\'', check: (r: string) => r.length > 0 },
    { cmd: 'diskutil info / 2>/dev/null | grep "Medium Type" | awk -F: \'{print $2}\'', check: (r: string) => r.length > 0 },
]
const PROBE_OLLAMA_MODELS = [
    { cmd: 'ollama list 2>/dev/null | tail -n +2 | awk \'{print $1}\'', check: (r: string) => r.length > 0 },
]
const PROBE_MEMORY_TYPE = [
    // Apple unified memory — if it's Apple Silicon it's always unified
    { cmd: 'sysctl -n hw.memorytype 2>/dev/null || (uname -m | grep -q arm64 && system_profiler SPHardwareDataType 2>/dev/null | grep -q "Apple" && echo unified)', check: (r: string) => r.length > 0 },
    { cmd: 'dmidecode -t memory 2>/dev/null | grep -i "type:" | grep -v "Unknown\\|None" | head -1 | awk \'{print $2}\'', check: (r: string) => r.length > 2 },
]

// ============================================
// Node Intelligence Engine
// ============================================

export class NodeIntelligence {

    /**
     * Gibt das gespeicherte Playbook zurück, oder entdeckt den Node neu
     */
    static async getOrDiscover(host: string, name: string): Promise<NodePlaybook> {
        const existing = this.load(name)

        // Playbook älter als 7 Tage → neu entdecken
        const STALE_MS = 7 * 24 * 60 * 60 * 1000
        if (existing && (Date.now() - existing.lastUpdated) < STALE_MS) {
            return existing
        }

        console.log(`[NodeIntel] 🔍 ${name}: Entdecke Node... (${existing ? 'Aktualisierung' : 'Erstmalig'})`)
        return this.discover(host, name)
    }

    /**
     * Nova entdeckt einen Node komplett selbst
     */
    static async discover(host: string, name: string): Promise<NodePlaybook> {
        const log: string[] = []
        const playbook: NodePlaybook = {
            nodeId: name,
            discoveredAt: Date.now(),
            lastUpdated: Date.now(),
            os: 'unknown',
            arch: 'unknown',
            hardware: {},
            software: {},
            commands: {
                getCpuCores: 'nproc',
                getLoadAvg: 'cat /proc/loadavg',
                getMemory: 'free -m',
                getDisk: 'df -BG /',
                getTemp: 'echo N/A',
                checkProcess: 'pgrep -f daemon.js > /dev/null && echo running || echo stopped',
            },
            healthCmd: '',
            probeLog: [],
        }

        // OS
        for (const probe of PROBE_OS) {
            const r = await sshTry(host, probe.cmd)
            if (r) { playbook.os = probe.parse(r); log.push(`OS: "${playbook.os}" via "${probe.cmd}"`); break }
        }

        // Arch
        for (const probe of PROBE_ARCH) {
            const r = await sshTry(host, probe.cmd)
            if (r) { playbook.arch = probe.parse(r); log.push(`Arch: ${playbook.arch}`); break }
        }

        // Chip/CPU model
        for (const probe of PROBE_CHIP) {
            const r = await sshTry(host, probe.cmd)
            if (r && probe.check(r)) {
                playbook.hardware.chip = r.trim()
                log.push(`Chip: ${playbook.hardware.chip}`)
                break
            }
        }

        // CPU Cores
        for (const probe of PROBE_CPU_CORES) {
            const r = await sshTry(host, probe.cmd)
            if (r && probe.check(r)) {
                playbook.commands.getCpuCores = probe.cmd
                playbook.hardware.cores = parseInt(r)
                log.push(`CPU cores: ${playbook.hardware.cores} via "${probe.cmd}"`)
                break
            }
        }

        // Load Average
        for (const probe of PROBE_LOAD) {
            const r = await sshTry(host, probe.cmd)
            if (r && probe.check(r)) {
                playbook.commands.getLoadAvg = probe.cmd
                log.push(`Load cmd: "${probe.cmd}"`)
                break
            }
        }

        // Memory
        for (const probe of PROBE_MEMORY) {
            const r = await sshTry(host, probe.cmd)
            if (r && probe.check(r)) {
                playbook.commands.getMemory = probe.cmd
                if (probe.unit === 'GB_total') {
                    playbook.hardware.ram_gb = parseInt(r)
                } else {
                    playbook.hardware.ram_gb = Math.round(parseInt(r.split(' ')[0]) / 1024)
                }
                log.push(`RAM: ~${playbook.hardware.ram_gb}GB via "${probe.cmd}"`)
                break
            }
        }

        // Disk
        for (const probe of PROBE_DISK) {
            const r = await sshTry(host, probe.cmd)
            if (r && probe.check(r)) {
                playbook.commands.getDisk = probe.cmd
                log.push(`Disk cmd: "${probe.cmd}"`)
                break
            }
        }

        // Temperature
        for (const probe of PROBE_TEMP) {
            const r = await sshTry(host, probe.cmd)
            if (r && probe.check(r)) {
                playbook.commands.getTemp = probe.cmd
                log.push(`Temp cmd: "${probe.cmd}"`)
                break
            }
        }

        // Process check
        for (const probe of PROBE_PROCESS) {
            const r = await sshTry(host, probe.cmd)
            if (r && probe.check(r)) {
                playbook.commands.checkProcess = probe.cmd
                log.push(`Process check: "${probe.cmd}"`)
                break
            }
        }

        // Software
        for (const sw of PROBE_SOFTWARE) {
            const r = await sshTry(host, sw.cmd)
            const found = !!(r && r.length > 0 && r !== 'no')
            // For python/torch, store version string if available
            if (found && (sw.name === 'python' || sw.name === 'torch') && r && r.length < 20 && /\d/.test(r)) {
                playbook.software[sw.name] = r.trim()
            } else {
                playbook.software[sw.name] = found
            }
            if (found) log.push(`Software: ${sw.name} ✓`)
        }

        // GPU — NVIDIA
        for (const probe of PROBE_GPU_NVIDIA) {
            const r = await sshTry(host, probe.cmd)
            if (r && probe.check(r)) {
                const parts = r.split(',').map(s => s.trim())
                playbook.hardware.gpu = parts[0]
                const vramMb = parseInt(parts[1]) || 0
                playbook.hardware.gpu_vram_gb = Math.round(vramMb / 1024)
                playbook.hardware.gpu_type = 'cuda'
                log.push(`GPU (NVIDIA): ${playbook.hardware.gpu} ${playbook.hardware.gpu_vram_gb}GB VRAM`)
                break
            }
        }

        // GPU — Apple Metal (only if no NVIDIA found)
        if (!playbook.hardware.gpu) {
            for (const probe of PROBE_GPU_APPLE) {
                const r = await sshTry(host, probe.cmd)
                if (r && probe.check(r)) {
                    playbook.hardware.gpu_type = 'metal'
                    playbook.hardware.metal = true
                    // Extract VRAM if present (discrete GPU), unified memory GPUs don't list VRAM separately
                    const vramMatch = r.match(/VRAM[^:]*:\s*(\d+)\s*(MB|GB)/i)
                    if (vramMatch) {
                        const val = parseInt(vramMatch[1])
                        playbook.hardware.gpu_vram_gb = vramMatch[2] === 'GB' ? val : Math.round(val / 1024)
                    }
                    log.push(`GPU (Apple Metal)${playbook.hardware.gpu_vram_gb ? ` ${playbook.hardware.gpu_vram_gb}GB` : ' unified'}`)
                    break
                }
            }
            // Apple Silicon always has Metal, even if system_profiler didn't fire
            if (!playbook.hardware.metal && playbook.arch === 'arm64' && playbook.os === 'macOS') {
                playbook.hardware.gpu_type = 'metal'
                playbook.hardware.metal = true
                log.push('GPU (Apple Metal): unified — ARM64 macOS')
            }
        }

        // GPU — AMD (only if no other GPU found)
        if (!playbook.hardware.gpu_type) {
            for (const probe of PROBE_GPU_AMD) {
                const r = await sshTry(host, probe.cmd)
                if (r && probe.check(r)) {
                    playbook.hardware.gpu_type = 'rocm'
                    log.push(`GPU (AMD/ROCm): ${r.trim().slice(0, 60)}`)
                    break
                }
            }
        }

        // CUDA version
        if (playbook.hardware.gpu_type === 'cuda') {
            for (const probe of PROBE_CUDA_VERSION) {
                const r = await sshTry(host, probe.cmd)
                if (r && probe.check(r)) {
                    playbook.hardware.cuda_version = r.trim()
                    log.push(`CUDA: ${playbook.hardware.cuda_version}`)
                    break
                }
            }
        }

        // Storage type
        for (const probe of PROBE_STORAGE_TYPE) {
            const r = await sshTry(host, probe.cmd)
            if (r && probe.check(r)) {
                playbook.hardware.storage_type = r.trim().toLowerCase()
                log.push(`Storage: ${playbook.hardware.storage_type}`)
                break
            }
        }

        // Memory type (unified vs DDR)
        for (const probe of PROBE_MEMORY_TYPE) {
            const r = await sshTry(host, probe.cmd)
            if (r && probe.check(r)) {
                const raw = r.trim().toLowerCase()
                playbook.hardware.memory_type = raw.includes('unified') ? 'unified' :
                    raw.includes('lpddr') ? raw.slice(0, 6) :
                    raw.includes('ddr') ? raw.slice(0, 4) : raw
                log.push(`Memory type: ${playbook.hardware.memory_type}`)
                break
            }
        }
        // Apple Silicon = always unified
        if (!playbook.hardware.memory_type && playbook.hardware.metal) {
            playbook.hardware.memory_type = 'unified'
        }

        // Ollama models (if ollama is installed)
        if (playbook.software['ollama']) {
            for (const probe of PROBE_OLLAMA_MODELS) {
                const r = await sshTry(host, probe.cmd, 8000)
                if (r && probe.check(r)) {
                    playbook.ollamaModels = r.split('\n').map(s => s.trim()).filter(Boolean)
                    log.push(`Ollama models: ${playbook.ollamaModels.join(', ')}`)
                    break
                }
            }
        }

        // Baue fertigen Health-Check-Befehl aus dem was funktioniert
        playbook.healthCmd = [
            `echo "===UPTIME==="; uptime`,
            `echo "===CPU==="; ${playbook.commands.getCpuCores}; ${playbook.commands.getLoadAvg}`,
            `echo "===MEM==="; ${playbook.commands.getMemory}`,
            `echo "===DISK==="; ${playbook.commands.getDisk}`,
            `echo "===TEMP==="; ${playbook.commands.getTemp}`,
            `echo "===DAEMON==="; ${playbook.commands.checkProcess}`,
        ].join('; ')

        playbook.probeLog = log

        // Don't overwrite a good playbook if node was unreachable (no probes worked)
        if (log.length === 0) {
            const existing = this.load(name)
            if (existing) {
                console.log(`[NodeIntel] ⚠️ ${name}: Keine Probes erfolgreich — behalte vorhandenes Playbook`)
                return existing
            }
            console.log(`[NodeIntel] ⚠️ ${name}: Nicht erreichbar — kein Playbook gespeichert`)
            return playbook
        }

        this.save(playbook)

        console.log(`[NodeIntel] ✅ ${name}: ${log.length} Fakten entdeckt — OS: ${playbook.os}, Arch: ${playbook.arch}, RAM: ${playbook.hardware.ram_gb ?? '?'}GB, Chip: ${playbook.hardware.chip ?? '?'}`)
        return playbook
    }

    // ============================================
    // Persistence
    // ============================================

    static load(name: string): NodePlaybook | null {
        const path = join(INTEL_DIR, `${name.toLowerCase().replace(/\s+/g, '-')}.json`)
        try {
            if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf-8'))
        } catch { /* ignore */ }
        return null
    }

    static save(playbook: NodePlaybook): void {
        if (!existsSync(INTEL_DIR)) mkdirSync(INTEL_DIR, { recursive: true })
        const path = join(INTEL_DIR, `${playbook.nodeId.toLowerCase().replace(/\s+/g, '-')}.json`)
        writeFileSync(path, JSON.stringify(playbook, null, 2))
    }

    static listAll(): NodePlaybook[] {
        if (!existsSync(INTEL_DIR)) return []
        const { readdirSync } = require('node:fs')
        return readdirSync(INTEL_DIR)
            .filter((f: string) => f.endsWith('.json'))
            .map((f: string) => {
                try { return JSON.parse(readFileSync(join(INTEL_DIR, f), 'utf-8')) } catch { return null }
            })
            .filter(Boolean)
    }
}

export default NodeIntelligence
