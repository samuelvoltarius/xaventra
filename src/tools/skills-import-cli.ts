// Skills Import CLI — nova import-skill command
// Wraps npx skills add and registers the skill in Nova

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SKILLS_DIR = join(process.cwd(), '.agent', 'skills')

// Import a skill package from the open ecosystem
export async function importSkill(packageName: string): Promise<{ success: boolean; message: string }> {
    if (!packageName || packageName.length < 3) {
        return { success: false, message: 'Package name required (e.g. firebase/agent-skills)' }
    }

    // Sanitize input
    const sanitized = packageName.replace(/[^a-zA-Z0-9\-_\/\.@]/g, '')
    if (sanitized !== packageName) {
        return { success: false, message: 'Invalid characters in package name' }
    }

    console.log(`[Skills CLI] Installing: ${sanitized}`)

    try {
        // Ensure .agent/skills directory exists
        if (!existsSync(SKILLS_DIR)) {
            mkdirSync(SKILLS_DIR, { recursive: true })
        }

        // Run npx skills add
        const output = execSync(`npx -y skills add ${sanitized}`, {
            cwd: process.cwd(),
            timeout: 60000,
            encoding: 'utf-8',
            env: { ...process.env, npm_config_yes: 'true' },
        })

        console.log(`[Skills CLI] Output: ${output.slice(0, 200)}`)

        // Reload skills
        try {
            const { loadAllSkills } = await import('../core/skills-loader.js')
            const skills = loadAllSkills()
            console.log(`[Skills CLI] Reloaded: ${skills.length} skills total`)
        } catch { }

        // Broadcast to mesh
        try {
            const { emit } = await import('../mesh/event-hub.js')
            emit('mesh:skill_imported', { package: sanitized, timestamp: new Date().toISOString() })
        } catch { }

        return {
            success: true,
            message: `Skill "${sanitized}" installiert und geladen`,
        }
    } catch (err: any) {
        const errMsg = err.stderr || err.message || 'Unknown error'
        console.log(`[Skills CLI] Failed: ${errMsg.slice(0, 200)}`)
        return {
            success: false,
            message: `Installation fehlgeschlagen: ${errMsg.slice(0, 100)}`,
        }
    }
}

// List all installed skills
export function listInstalledSkills(): string[] {
    if (!existsSync(SKILLS_DIR)) return []

    const { readdirSync } = require('node:fs')
    const entries = readdirSync(SKILLS_DIR, { withFileTypes: true })
    return entries
        .filter((e: any) => e.isDirectory())
        .map((e: any) => e.name)
}

// Remove a skill
export function removeSkill(name: string): boolean {
    const skillDir = join(SKILLS_DIR, name)
    if (!existsSync(skillDir)) return false

    try {
        const { rmSync } = require('node:fs')
        rmSync(skillDir, { recursive: true, force: true })
        console.log(`[Skills CLI] Removed: ${name}`)
        return true
    } catch {
        return false
    }
}
