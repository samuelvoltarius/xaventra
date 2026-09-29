/**
 * Nova 3D Printer Integration Tool
 * 
 * Based on ADA V2's printer_agent.py:
 * - Auto-discovers printers via mDNS
 * - Slices STL files using OrcaSlicer
 * - Sends print jobs via Moonraker/OctoPrint API
 * 
 * Supports: Klipper/Moonraker, OctoPrint, PrusaLink
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ownerApprovalRefusal } from './owner-approval.js'

/** R2 T9: printer URLs are plain http(s) base URLs, never shell text. */
function printerBaseUrl(raw: unknown): string | null {
    try {
        const url = new URL(String(raw ?? ''))
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
        if (url.username || url.password) return null
        return url.origin + url.pathname.replace(/\/+$/, '')
    } catch {
        return null
    }
}

const GCODE_FILE = /\.(gcode|gco|g|bgcode)$/i

export interface PrinterConfig {
    name: string
    type: 'moonraker' | 'octoprint' | 'prusaprinterlink'
    url: string
    apiKey?: string
}

const PRINTER_CACHE_FILE = join(process.cwd(), '.nova-data', 'cad', 'printers.json')

export const printerDiscoveryTool = {
    name: 'printer_discover',
    description: 'Discover 3D printers on the local network using mDNS/ Zeroconf. Supports Klipper/Moonraker, OctoPrint, and PrusaLink.',
    category: 'media' as const,
    parameters: [
        {
            name: 'timeout',
            type: 'number',
            description: 'Discovery timeout in seconds',
            required: false,
            default: 10
        }
    ],
    handler: async (params: { timeout?: number }) => {
        // R2 T9: the timeout is interpolated into Python source: numbers only
        const timeout = Math.min(Math.max(Math.round(Number(params.timeout) || 10), 1), 60)
        
        return new Promise((resolve) => {
            const proc = spawn('python', ['-c', `
import socket
import time

def discover_printers(timeout=${timeout}):
    printers = []
    # mDNS service discovery for common printer services
    services = [
        ('_printer._tcp', 631),
        ('_http._tcp', 80),
        ('_octoprint._tcp', 80),
    ]
    
    # Simple socket-based discovery on common IPs (parallel: 762 addresses
    # one after another took longer than the tool timeout, R2 T18)
    from concurrent.futures import ThreadPoolExecutor
    ranges = ['192.168.1.', '192.168.0.', '10.0.0.']
    candidates = [base + str(i) for base in ranges for i in range(1, 255)]

    def probe(ip):
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(0.5)
            result = sock.connect_ex((ip, 80))
            sock.close()
            return ip if result == 0 else None
        except:
            return None

    with ThreadPoolExecutor(max_workers=128) as pool:
        discovered = [ip for ip in pool.map(probe, candidates) if ip]

    # Moonraker/Klipper typically on port 7125
    for ip in discovered:
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(1)
            result = sock.connect_ex((ip, 7125))
            if result == 0:
                printers.append({
                    'name': f'Klipper @{ip}',
                    'type': 'moonraker',
                    'url': f'http://{ip}:7125',
                    'ip': ip
                })
            sock.close()
        except:
            pass
    
    print('PRINTERS:' + ','.join([f\"{p['name']}|{p['type']}|{p['url']}\" for p in printers]))
`], { timeout: timeout * 1000 + 5000 })
            
            let stdout = ''
            proc.stdout?.on('data', (d) => { stdout += d.toString() })
            
            proc.on('close', (code) => {
                if (code === 0 && stdout.includes('PRINTERS:')) {
                    const parts = stdout.split('PRINTERS:')[1].trim().split(',')
                    const printers = parts.filter(p => p).map(p => {
                        const [name, type, url] = p.split('|')
                        return { name, type, url }
                    })
                    resolve({
                        success: true,
                        printers,
                        count: printers.length,
                        message: `Found ${printers.length} printer(s)`
                    })
                } else {
                    resolve({
                        success: true,
                        printers: [],
                        count: 0,
                        message: 'No printers found on network'
                    })
                }
            })
            
            proc.on('error', () => {
                resolve({
                    success: false,
                    error: 'Discovery failed',
                    printers: []
                })
            })
        })
    }
}

export const printerStatusTool = {
    name: 'printer_status',
    description: 'Get the current status of a 3D printer (temperature, job progress, state).',
    category: 'media' as const,
    parameters: [
        {
            name: 'printerUrl',
            type: 'string',
            description: 'Printer URL (e.g., http://192.168.1.100:7125)',
            required: true
        },
        {
            name: 'apiKey',
            type: 'string',
            description: 'API key for authenticated printers',
            required: false
        }
    ],
    handler: async (params: { printerUrl: string; apiKey?: string }) => {
        const { apiKey } = params
        const printerUrl = printerBaseUrl(params.printerUrl)
        if (!printerUrl) return { success: false, error: 'Ungültige Drucker-URL (nur http/https).' }

        // R2 T9: plain HTTP request instead of a cmd/curl shell string
        return new Promise((resolve) => {
            fetch(`${printerUrl}/printer/objects/query?heater_bed&toolhead&print_stats`, {
                headers: apiKey ? { 'X-Api-Key': String(apiKey) } : {},
                signal: AbortSignal.timeout(10000),
            }).then(async response => {
                const stdout = await response.text()
                const code = response.ok ? 0 : response.status
                if (code === 0 && stdout.includes('temperature')) {
                    try {
                        const data = JSON.parse(stdout)
                        resolve({
                            success: true,
                            status: 'connected',
                            data: data,
                            message: 'Printer status retrieved'
                        })
                    } catch {
                        resolve({
                            success: true,
                            status: 'connected',
                            raw: stdout,
                            message: 'Printer responded but parsing failed'
                        })
                    }
                } else {
                    resolve({
                        success: false,
                        error: 'Could not connect to printer',
                        message: stdout.slice(0, 500) || 'Connection failed'
                    })
                }
            }).catch((err) => {
                resolve({
                    success: false,
                    error: err instanceof Error ? err.message : String(err),
                    message: 'Failed to query printer'
                })
            })
        })
    }
}

export const printerSliceTool = {
    name: 'printer_slice',
    description: 'Slice a 3D STL/OBJ file using OrcaSlicer and prepare it for printing.',
    category: 'media' as const,
    parameters: [
        {
            name: 'stlFile',
            type: 'string',
            description: 'Path to the STL file to slice',
            required: true
        },
        {
            name: 'printerProfile',
            type: 'string',
            description: 'Printer profile name (e.g., "Creality K1", "Voron")',
            required: false,
            default: 'auto'
        },
        {
            name: 'profileName',
            type: 'string',
            description: 'Slicer profile name within OrcaSlicer',
            required: false,
            default: 'Fine'
        }
    ],
    handler: async (params: { stlFile: string; printerProfile?: string; profileName?: string }) => {
        const { stlFile, printerProfile = 'auto', profileName = 'Fine' } = params
        
        if (!existsSync(stlFile)) {
            return { success: false, error: `File not found: ${stlFile}` }
        }
        
        // Check for OrcaSlicer installation
        const orcaPaths = [
            'C:\\Program Files\\OrcaSlicer\\OrcaSlicer.exe',
            'C:\\Program Files\\Bambu Studio\\BambuStudio.exe',
            join(process.env.LOCALAPPDATA || '', 'OrcaSlicer', 'OrcaSlicer.exe')
        ]
        
        let orcaPath = orcaPaths.find(p => existsSync(p))
        
        // If no OrcaSlicer, check for slic3r or Cura
        if (!orcaPath) {
            orcaPath = orcaPaths[0] // Just return error with first path
        }
        
        return new Promise((resolve) => {
            if (!orcaPath) {
                resolve({
                    success: false,
                    error: 'OrcaSlicer not found. Please install from https://github.com/SoftFever/OrcaSlicer',
                    installHint: 'Download from https://github.com/SoftFever/OrcaSlicer/releases'
                })
                return
            }
            
            const outputGcode = stlFile.replace(/\.stl$/i, '_sliced.gcode')
            const slicerArgs = [
                '--slice',
                '--load-profile', profileName,
                '--output', outputGcode,
                stlFile
            ]
            
            // R2 T9: argument vector without a shell
            const proc = spawn(orcaPath, slicerArgs, {
                timeout: 120000,
            })
            
            let stderr = ''
            proc.stderr?.on('data', (d) => { stderr += d.toString() })
            
            proc.on('close', (code) => {
                if (code === 0 && existsSync(outputGcode)) {
                    resolve({
                        success: true,
                        output: outputGcode,
                        message: `Sliced successfully: ${outputGcode}`
                    })
                } else {
                    resolve({
                        success: false,
                        error: `Slicing failed: ${stderr}`,
                        exitCode: code
                    })
                }
            })
            
            proc.on('error', (err) => {
                resolve({
                    success: false,
                    error: err.message
                })
            })
        })
    }
}

export const printerPrintTool = {
    name: 'printer_print',
    description: 'Send a print job to a 3D printer via Moonraker/OctoPrint API.',
    category: 'media' as const,
    parameters: [
        {
            name: 'printerUrl',
            type: 'string',
            description: 'Printer URL (e.g., http://192.168.1.100:7125)',
            required: true
        },
        {
            name: 'gcodeFile',
            type: 'string',
            description: 'Path to the G-code file to print',
            required: true
        },
        {
            name: 'apiKey',
            type: 'string',
            description: 'API key for the printer',
            required: false
        },
        {
            name: 'confirm',
            type: 'string',
            description: 'Einmal-Freigabecode, den der Owner selbst nennt. Niemals selbst bilden.',
            required: false
        }
    ],
    handler: async (params: { printerUrl: string; gcodeFile: string; apiKey?: string; [key: string]: unknown }) => {
        const { gcodeFile, apiKey } = params
        const printerUrl = printerBaseUrl(params.printerUrl)
        if (!printerUrl) return { success: false, error: 'Ungültige Drucker-URL (nur http/https).' }

        // R2 T9: only real G-code files are uploaded (never configs or keys)
        if (typeof gcodeFile !== 'string' || !GCODE_FILE.test(gcodeFile) || !existsSync(gcodeFile) || !statSync(gcodeFile).isFile()) {
            return { success: false, error: `G-code file not found or not a G-code file: ${String(gcodeFile)}` }
        }

        if (!apiKey) {
            return { success: false, error: 'API key required for printing' }
        }

        // R2 T10: starting a print is a physical action: owner approval
        const refusal = await ownerApprovalRefusal(params, 'printer_print')
        if (refusal) return { success: false, error: refusal }

        // R2 T9/T18: plain HTTP requests (no shell), status codes checked
        try {
            const form = new FormData()
            form.append('file', new Blob([readFileSync(gcodeFile)]), basename(gcodeFile))
            form.append('root', 'gcodes')
            const upload = await fetch(`${printerUrl}/api/files/local`, {
                method: 'POST',
                headers: { 'X-Api-Key': String(apiKey) },
                body: form,
                signal: AbortSignal.timeout(60000),
            })
            const uploadText = await upload.text()
            if (!upload.ok) return { success: false, error: `Upload failed: HTTP ${upload.status}`, details: uploadText.slice(0, 500) }

            const start = await fetch(`${printerUrl}/api/job`, {
                method: 'POST',
                headers: { 'X-Api-Key': String(apiKey), 'Content-Type': 'application/json' },
                body: JSON.stringify({ command: 'start' }),
                signal: AbortSignal.timeout(10000),
            })
            const startText = await start.text()
            if (!start.ok) return { success: false, error: `Upload ok, but start failed: HTTP ${start.status}`, details: startText.slice(0, 500) }
            return { success: true, message: 'Print job sent to printer and started', response: startText || uploadText }
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) }
        }
    }
}

export default {
    printerDiscoveryTool,
    printerStatusTool,
    printerSliceTool,
    printerPrintTool
}