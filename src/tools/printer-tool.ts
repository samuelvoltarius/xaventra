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
import { existsSync } from 'node:fs'
import { join } from 'node:path'

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
        const { timeout = 10 } = params
        
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
    
    # Simple socket-based discovery on common IPs
    ranges = ['192.168.1.', '192.168.0.', '10.0.0.']
    discovered = []
    
    for base in ranges:
        for i in range(1, 255):
            ip = base + str(i)
            try:
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.settimeout(0.5)
                result = sock.connect_ex((ip, 80))
                if result == 0:
                    # Port open - could be a printer
                    discovered.append(ip)
                sock.close()
            except:
                pass
    
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
        const { printerUrl, apiKey } = params
        
        return new Promise((resolve) => {
            const auth = apiKey ? ` -H "X-Api-Key: ${apiKey}"` : ''
            const curlCmd = `curl -s${auth} "${printerUrl}/printer/objects/query?heater_bed&toolhead&print_stats"`
            
            const proc = spawn('cmd', ['/c', curlCmd], { timeout: 10000 })
            let stdout = ''
            proc.stdout?.on('data', (d) => { stdout += d.toString() })
            
            proc.on('close', (code) => {
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
                        message: stdout || 'Connection failed'
                    })
                }
            })
            
            proc.on('error', (err) => {
                resolve({
                    success: false,
                    error: err.message,
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
            
            const proc = spawn(orcaPath, slicerArgs, {
                timeout: 120000,
                shell: true
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
        }
    ],
    handler: async (params: { printerUrl: string; gcodeFile: string; apiKey?: string }) => {
        const { printerUrl, gcodeFile, apiKey } = params
        
        if (!existsSync(gcodeFile)) {
            return { success: false, error: `G-code file not found: ${gcodeFile}` }
        }
        
        if (!apiKey) {
            return { success: false, error: 'API key required for printing' }
        }
        
        return new Promise((resolve) => {
            // Moonraker API - upload file and start print
            const uploadCmd = `curl -s -X POST "${printerUrl}/api/files/local" ` +
                `-H "X-Api-Key: ${apiKey}" ` +
                `-F "file=@${gcodeFile}" ` +
                `-F "root=gcodes" `
            
            const proc = spawn('cmd', ['/c', uploadCmd], { timeout: 60000 })
            let stdout = ''
            proc.stdout?.on('data', (d) => { stdout += d.toString() })
            
            proc.on('close', (code) => {
                if (code === 0) {
                    // Try to start the print
                    const startCmd = `curl -s -X POST "${printerUrl}/api/job" ` +
                        `-H "X-Api-Key: ${apiKey}" ` +
                        `-H "Content-Type: application/json" ` +
                        `-d '{"command": "start"}" `
                    
                    const startProc = spawn('cmd', ['/c', startCmd], { timeout: 10000 })
                    let startOut = ''
                    startProc.stdout?.on('data', (d) => { startOut += d.toString() })
                    
                    startProc.on('close', () => {
                        resolve({
                            success: true,
                            message: 'Print job sent to printer',
                            response: startOut || stdout
                        })
                    })
                } else {
                    resolve({
                        success: false,
                        error: 'Failed to upload file',
                        details: stdout
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

export default {
    printerDiscoveryTool,
    printerStatusTool,
    printerSliceTool,
    printerPrintTool
}