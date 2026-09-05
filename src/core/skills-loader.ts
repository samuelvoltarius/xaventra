// Skills Loader — Import from Open Agent Skills Ecosystem
// Reads .agent/skills/*/SKILL.md files, YAML frontmatter + MD body
// Compatible with: npx skills add firebase/agent-skills

import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

interface AgentSkill {
    name: string
    description: string
    content: string
    path: string
    scripts: string[]
    resources: string[]
}

// ============================================
// Config
// ============================================

const SKILL_DIRS = [
    join(process.cwd(), '.agent', 'skills'),
    join(process.cwd(), '_agent', 'skills'),
    join(process.cwd(), '.agents', 'skills'),
]

let loadedSkills: AgentSkill[] = []

// ============================================
// Core
// ============================================

export function loadAllSkills(): AgentSkill[] {
    loadedSkills = []

    for (const skillDir of SKILL_DIRS) {
        if (!existsSync(skillDir)) continue

        const entries = readdirSync(skillDir, { withFileTypes: true })
        for (const entry of entries) {
            if (!entry.isDirectory()) continue

            const skillPath = join(skillDir, entry.name, 'SKILL.md')
            if (!existsSync(skillPath)) continue

            try {
                const skill = parseSkillFile(skillPath, entry.name)
                if (skill) {
                    loadedSkills.push(skill)
                    console.log(`[Skills] Loaded: ${skill.name} (${skill.description.slice(0, 50)})`)
                }
            } catch (err) {
                console.log(`[Skills] Failed to load ${entry.name}: ${err}`)
            }
        }
    }

    return loadedSkills
}

function parseSkillFile(filePath: string, dirName: string): AgentSkill | null {
    const raw = readFileSync(filePath, 'utf-8')

    let name = dirName
    let description = ''
    let body = raw

    const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
    if (fmMatch) {
        const frontmatter = fmMatch[1]
        body = fmMatch[2]

        const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
        const descMatch = frontmatter.match(/^description:\s*(.+)$/m)
        if (nameMatch) name = nameMatch[1].trim()
        if (descMatch) description = descMatch[1].trim()
    }

    const skillDir = join(filePath, '..')
    const scripts: string[] = []
    const resources: string[] = []

    const scriptsDir = join(skillDir, 'scripts')
    if (existsSync(scriptsDir)) {
        scripts.push(...readdirSync(scriptsDir))
    }

    const resourcesDir = join(skillDir, 'resources')
    if (existsSync(resourcesDir)) {
        resources.push(...readdirSync(resourcesDir))
    }

    return { name, description, content: body, path: filePath, scripts, resources }
}

export function getSkillContent(name: string): string | null {
    const skill = loadedSkills.find(s =>
        s.name.toLowerCase() === name.toLowerCase() ||
        s.path.toLowerCase().includes(name.toLowerCase())
    )
    return skill?.content || null
}

export function getSkillsSummary(): string {
    if (loadedSkills.length === 0) return ''

    const lines = [`## Available Agent Skills (${loadedSkills.length})`]
    for (const skill of loadedSkills) {
        lines.push(`- **${skill.name}**: ${skill.description}`)
        if (skill.scripts.length > 0) {
            lines.push(`  Scripts: ${skill.scripts.join(', ')}`)
        }
    }
    return lines.join('\n')
}

export function matchSkillsForMessage(message: string): string[] {
    const msgLC = message.toLowerCase()
    const matched: string[] = []

    for (const skill of loadedSkills) {
        const keywords = [
            skill.name.toLowerCase(),
            ...skill.description.toLowerCase().split(/\s+/).filter(w => w.length > 3),
        ]

        if (keywords.some(kw => msgLC.includes(kw))) {
            matched.push(skill.content)
        }
    }

    return matched.slice(0, 2)
}

export function getLoadedSkills(): AgentSkill[] {
    return [...loadedSkills]
}

// ============================================
// Init
// ============================================

export function initSkillsLoader(): void {
    const defaultDir = SKILL_DIRS[0]
    if (!SKILL_DIRS.some(d => existsSync(d))) {
        mkdirSync(defaultDir, { recursive: true })
    }

    const skills = loadAllSkills()
    console.log(`[Skills] Initialized: ${skills.length} external skills loaded`)
}
