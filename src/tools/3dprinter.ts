/**
 * Nova Tool — 3D Printer (Moonraker/Klipper)
 *
 * Full integration with Moonraker API for Klipper-based 3D printers.
 * Supports: print status, temperatures, G-code, file management, control.
 *
 * Config (xaventra.config.json or env):
 *   PRINTER_URL = "http://192.168.1.100"   (Moonraker host, no port needed if default 80/7125)
 *   PRINTER_API_KEY = "..."                (optional, if HA auth is enabled)
 *
 * Or xaventra.config.json:
 *   { "printer": { "url": "http://192.168.1.100", "apiKey": "..." } }
 *
 * Slash commands: /printer status, /printer temp, /printer files, /printer pause, etc.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NovaTool } from './complete-registry.js'
import { resolveConfigPath } from '../config/config-path.js'


// ============================================
// Config
// ============================================

export interface PrinterConfig {
    url: string
    apiKey?: string
}

function getPrinterConfig(): PrinterConfig | null {
    if (process.env.PRINTER_URL) {
        return {
            url: process.env.PRINTER_URL.replace(/\/$/, ''),
            apiKey: process.env.PRINTER_API_KEY,
        }
    }

    try {
        const configPath = resolveConfigPath()
        if (existsSync(configPath)) {
            const cfg = JSON.parse(readFileSync(configPath, 'utf-8'))
            const p = cfg.printer || cfg['3dprinter'] || cfg.moonraker
            if (p?.url) return { url: p.url.replace(/\/$/, ''), apiKey: p.apiKey }
        }
    } catch { /* ignore */ }

    return null
}

// ============================================
// HTTP Helper
// ============================================

async function moonrakerGet<T = unknown>(path: string): Promise<T> {
    const cfg = getPrinterConfig()
    if (!cfg) throw new Error('Drucker nicht konfiguriert. Setze PRINTER_URL in xaventra.config.json oder als Umgebungsvariable.')

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (cfg.apiKey) headers['X-Api-Key'] = cfg.apiKey

    const res = await fetch(`${cfg.url}${path}`, { headers })
    if (!res.ok) throw new Error(`Moonraker Fehler ${res.status}: ${await res.text()}`)
    return res.json() as Promise<T>
}

async function moonrakerPost<T = unknown>(path: string, body: unknown = {}): Promise<T> {
    const cfg = getPrinterConfig()
    if (!cfg) throw new Error('Drucker nicht konfiguriert.')

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (cfg.apiKey) headers['X-Api-Key'] = cfg.apiKey

    const res = await fetch(`${cfg.url}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Moonraker Fehler ${res.status}: ${await res.text()}`)
    return res.json() as Promise<T>
}

// ============================================
// Types
// ============================================

export interface PrintStats {
    state: 'standby' | 'printing' | 'paused' | 'complete' | 'error' | 'cancelled'
    filename: string
    total_duration: number
    print_duration: number
    filament_used: number
    message?: string
}

export interface ExtruderStats {
    temperature: number
    target: number
    power?: number
}

export interface PrinterStatus {
    printStats: PrintStats
    extruder: ExtruderStats
    heaterBed: ExtruderStats
    displayStatus?: { progress: number; message?: string }
    klipperState?: string
    moonrakerVersion?: string
}

export interface PrintFile {
    filename: string
    size: number
    modified: number
    print_start_time?: number
    slicer?: string
    estimated_time?: number
    filament_total?: number
}

// ============================================
// Core Functions
// ============================================

export async function getPrinterStatus(): Promise<PrinterStatus> {
    const data = await moonrakerGet<{ result: { status: Record<string, unknown> } }>(
        '/printer/objects/query?print_stats&extruder&heater_bed&display_status&toolhead'
    )

    const status = data.result.status as any

    return {
        printStats: status.print_stats || { state: 'standby', filename: '', total_duration: 0, print_duration: 0, filament_used: 0 },
        extruder: status.extruder || { temperature: 0, target: 0 },
        heaterBed: status.heater_bed || { temperature: 0, target: 0 },
        displayStatus: status.display_status,
    }
}

export async function getPrinterInfo(): Promise<{ state: string; state_message: string; hostname: string; software_version: string }> {
    const data = await moonrakerGet<{ result: unknown }>('/printer/info')
    return data.result as any
}

export async function sendGcode(gcode: string): Promise<{ result: string }> {
    return moonrakerPost<{ result: string }>('/printer/gcode/script', { script: gcode })
}

export async function listPrintFiles(path = ''): Promise<PrintFile[]> {
    const url = path ? `/server/files/list?root=gcodes&path=${encodeURIComponent(path)}` : '/server/files/list?root=gcodes'
    const data = await moonrakerGet<{ result: PrintFile[] }>(url)
    return data.result || []
}

export async function startPrint(filename: string): Promise<unknown> {
    return moonrakerPost('/printer/print/start', { filename })
}

export async function pausePrint(): Promise<unknown> {
    return moonrakerPost('/printer/print/pause')
}

export async function resumePrint(): Promise<unknown> {
    return moonrakerPost('/printer/print/resume')
}

export async function cancelPrint(): Promise<unknown> {
    return moonrakerPost('/printer/print/cancel')
}

export async function emergencyStop(): Promise<unknown> {
    return moonrakerPost('/printer/emergency_stop')
}

export async function getMoonrakerVersion(): Promise<{ moonraker: string; klipper: string }> {
    const data = await moonrakerGet<{ result: { moonraker: { version: string }; klipper: { version: string } } }>('/server/info')
    return {
        moonraker: data.result?.moonraker?.version || 'unbekannt',
        klipper: data.result?.klipper?.version || 'unbekannt',
    }
}

// ============================================
// Formatters
// ============================================

function formatDuration(seconds: number): string {
    if (seconds < 60) return `${Math.round(seconds)}s`
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    return `${h}h ${m}m`
}

export function formatPrinterStatus(status: PrinterStatus): string {
    const { printStats, extruder, heaterBed, displayStatus } = status

    const stateIcons: Record<string, string> = {
        standby: '⏸️', printing: '🖨️', paused: '⏸️',
        complete: '✅', error: '❌', cancelled: '⛔',
    }
    const stateIcon = stateIcons[printStats.state] || '❓'

    let out = `${stateIcon} *3D Drucker Status*\n\n`
    out += `**Status:** ${printStats.state.toUpperCase()}\n`

    if (printStats.filename) {
        out += `**Datei:** ${printStats.filename}\n`
    }

    if (displayStatus?.progress !== undefined && printStats.state === 'printing') {
        const pct = Math.round(displayStatus.progress * 100)
        const bar = '█'.repeat(Math.floor(pct / 10)) + '░'.repeat(10 - Math.floor(pct / 10))
        out += `**Fortschritt:** ${bar} ${pct}%\n`
    }

    if (printStats.print_duration > 0) {
        out += `**Druckzeit:** ${formatDuration(printStats.print_duration)}\n`
        if (printStats.total_duration > printStats.print_duration) {
            const remaining = printStats.total_duration - printStats.print_duration
            out += `**Verbleibend:** ${formatDuration(remaining)}\n`
        }
    }

    if (printStats.filament_used > 0) {
        out += `**Filament verwendet:** ${(printStats.filament_used / 1000).toFixed(1)}m\n`
    }

    out += `\n🌡️ **Temperaturen:**\n`
    out += `  Extruder: ${extruder.temperature.toFixed(1)}°C`
    if (extruder.target > 0) out += ` → ${extruder.target}°C`
    out += `\n`
    out += `  Heizbett:  ${heaterBed.temperature.toFixed(1)}°C`
    if (heaterBed.target > 0) out += ` → ${heaterBed.target}°C`
    out += `\n`

    if (printStats.message) {
        out += `\n⚠️ **Meldung:** ${printStats.message}\n`
    }

    return out
}

export function formatFileList(files: PrintFile[]): string {
    if (files.length === 0) return '📂 Keine G-Code Dateien gefunden.'

    let out = `📂 *G-Code Dateien* (${files.length})\n\n`

    for (const f of files.slice(0, 20)) {
        const sizeKB = Math.round(f.size / 1024)
        const date = new Date(f.modified * 1000).toLocaleDateString('de')
        const time = f.estimated_time ? ` ⏱️ ${formatDuration(f.estimated_time)}` : ''
        const filament = f.filament_total ? ` 🧵 ${(f.filament_total / 1000).toFixed(1)}m` : ''
        out += `• **${f.filename}** (${sizeKB}KB, ${date})${time}${filament}\n`
    }

    if (files.length > 20) out += `\n… +${files.length - 20} weitere Dateien`

    return out
}

// ============================================
// Nova Tools
// ============================================

export const printerTools: NovaTool[] = [
    {
        name: 'printer_status',
        description: 'Gibt den aktuellen Status des 3D Druckers zurück (Druckfortschritt, Temperaturen, Dateiname, verbleibende Zeit).',
        category: 'other',
        parameters: [],
        handler: async () => {
            const status = await getPrinterStatus()
            return { formatted: formatPrinterStatus(status), status }
        },
    },
    {
        name: 'printer_files',
        description: 'Listet alle verfügbaren G-Code Dateien auf dem 3D Drucker auf.',
        category: 'other',
        parameters: [
            { name: 'path', type: 'string', description: 'Unterordner (optional)', required: false },
        ],
        handler: async (params) => {
            const files = await listPrintFiles(params.path as string | undefined)
            return { count: files.length, formatted: formatFileList(files), files }
        },
    },
    {
        name: 'printer_start',
        description: 'Startet einen Druckjob mit dem angegebenen G-Code Dateinamen.',
        category: 'other',
        parameters: [
            { name: 'filename', type: 'string', description: 'G-Code Dateiname (z.B. benchy.gcode)', required: true },
        ],
        handler: async (params) => {
            const result = await startPrint(params.filename as string)
            return { success: true, message: `Druck gestartet: ${params.filename}`, result }
        },
    },
    {
        name: 'printer_pause',
        description: 'Pausiert den aktuellen Druckjob.',
        category: 'other',
        parameters: [],
        handler: async () => {
            await pausePrint()
            return { success: true, message: '⏸️ Druck pausiert' }
        },
    },
    {
        name: 'printer_resume',
        description: 'Setzt einen pausierten Druckjob fort.',
        category: 'other',
        parameters: [],
        handler: async () => {
            await resumePrint()
            return { success: true, message: '▶️ Druck fortgesetzt' }
        },
    },
    {
        name: 'printer_cancel',
        description: 'Bricht den aktuellen Druckjob ab.',
        category: 'other',
        parameters: [],
        handler: async () => {
            await cancelPrint()
            return { success: true, message: '⛔ Druck abgebrochen' }
        },
    },
    {
        name: 'printer_gcode',
        description: 'Sendet einen G-Code Befehl direkt an den Drucker (z.B. G28 für Home, M104 S200 für Extrudertemperatur).',
        category: 'other',
        parameters: [
            { name: 'gcode', type: 'string', description: 'G-Code Befehl (z.B. G28, M104 S200, M84)', required: true },
        ],
        handler: async (params) => {
            const result = await sendGcode(params.gcode as string)
            return { success: true, gcode: params.gcode, result }
        },
    },
    {
        name: 'printer_info',
        description: 'Gibt Informationen über Moonraker und Klipper Versionen zurück.',
        category: 'other',
        parameters: [],
        handler: async () => {
            const [info, versions] = await Promise.all([getPrinterInfo(), getMoonrakerVersion()])
            return { ...info, versions }
        },
    },
]

// ============================================
// Slash Command Handler
// ============================================

export async function handlePrinterCommand(args: string): Promise<string> {
    const parts = args.trim().split(/\s+/)
    const sub = parts[0]?.toLowerCase()

    try {
        switch (sub) {
            case 'status':
            case '':
            case undefined: {
                const status = await getPrinterStatus()
                return formatPrinterStatus(status)
            }

            case 'temp':
            case 'temps': {
                const status = await getPrinterStatus()
                const { extruder, heaterBed } = status
                return `🌡️ *Temperaturen*\nExtruder: ${extruder.temperature.toFixed(1)}°C → ${extruder.target}°C\nHeizbett: ${heaterBed.temperature.toFixed(1)}°C → ${heaterBed.target}°C`
            }

            case 'files':
            case 'dateien': {
                const files = await listPrintFiles()
                return formatFileList(files)
            }

            case 'start': {
                if (!parts[1]) return '❌ Verwendung: /printer start <dateiname.gcode>'
                await startPrint(parts.slice(1).join(' '))
                return `✅ Druck gestartet: ${parts.slice(1).join(' ')}`
            }

            case 'pause': {
                await pausePrint()
                return '⏸️ Druck pausiert'
            }

            case 'resume':
            case 'weiter': {
                await resumePrint()
                return '▶️ Druck fortgesetzt'
            }

            case 'cancel':
            case 'abbruch': {
                await cancelPrint()
                return '⛔ Druck abgebrochen'
            }

            case 'gcode': {
                if (!parts[1]) return '❌ Verwendung: /printer gcode <G-Code>'
                const gcode = parts.slice(1).join(' ')
                await sendGcode(gcode)
                return `✅ G-Code gesendet: \`${gcode}\``
            }

            case 'home': {
                await sendGcode('G28')
                return '🏠 Home-Fahrt gestartet (G28)'
            }

            case 'info': {
                const [info, versions] = await Promise.all([getPrinterInfo(), getMoonrakerVersion()])
                return `ℹ️ *Drucker Info*\nStatus: ${info.state}\nKlipper: ${versions.klipper}\nMoonraker: ${versions.moonraker}\nHost: ${info.hostname}`
            }

            case 'help':
            default:
                return `🖨️ *3D Drucker Befehle*

/printer status — Druckstatus und Temperaturen
/printer temp — Nur Temperaturen
/printer files — G-Code Dateien auflisten
/printer start <datei> — Druck starten
/printer pause — Pausieren
/printer resume — Fortsetzen
/printer cancel — Abbrechen
/printer gcode <cmd> — G-Code senden
/printer home — G28 ausführen
/printer info — Klipper/Moonraker Version

*Config:* PRINTER_URL in xaventra.config.json setzen
*Beispiel:* { "printer": { "url": "http://192.168.1.100" } }`
        }
    } catch (err) {
        return `❌ Drucker-Fehler: ${err}`
    }
}

export default { printerTools, handlePrinterCommand, getPrinterStatus, sendGcode, listPrintFiles, startPrint, pausePrint, resumePrint, cancelPrint }
