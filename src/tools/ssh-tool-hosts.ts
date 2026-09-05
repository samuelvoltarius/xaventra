/**
 * SSH Host Database — Shared exports for slash commands
 * 
 * Re-exports loadHosts/saveHosts from ssh-tool.ts so that
 * slash-commands.ts can manage hosts without importing the
 * full SSH execution machinery.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export interface KnownHost {
    name: string
    alias: string[]
    ip: string
    user: string
    password?: string
    description: string
    lastSeen: string | null
}

export interface HostDB {
    hosts: KnownHost[]
}

const HOSTS_FILE = join(process.cwd(), '.nova-data', 'hosts.json')

export function loadHosts(): HostDB {
    try {
        if (existsSync(HOSTS_FILE)) {
            return JSON.parse(readFileSync(HOSTS_FILE, 'utf-8'))
        }
    } catch {
        console.log('[SSH Hosts] Could not load hosts.json')
    }
    return { hosts: [] }
}

export function saveHosts(db: HostDB): void {
    try {
        const dir = join(process.cwd(), '.nova-data')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        writeFileSync(HOSTS_FILE, JSON.stringify(db, null, 2))
    } catch {
        console.log('[SSH Hosts] Could not save hosts.json')
    }
}
