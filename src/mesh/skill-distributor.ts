/**
 * Nova Skill Distributor — Autonomous Skill Deployment
 * 
 * When a new skill/tool is created on Main, this module:
 * 1. Signs the skill with Code Guardian
 * 2. Packages it for distribution
 * 3. Deploys to all mesh nodes via SSH
 * 4. Verifies deployment
 * 
 * "App Store" for Nova — create once, run everywhere.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'

const DATA_DIR = join(process.cwd(), '.nova-data', 'skill-distribution')
const SKILLS_DIR = join(process.cwd(), '.nova-skills')

// ============================================
// Types
// ============================================

interface SkillPackage {
    name: string
    version: string
    hash: string
    signed: boolean
    files: string[]
    createdAt: string
    deployedTo: string[]
}

interface DeployTarget {
    name: string
    host: string
    user: string
    remotePath: string
    method: 'ssh' | 'tailscale'
}

// ============================================
// Configuration
// ============================================

const DEPLOY_TARGETS: DeployTarget[] = [
    {
        name: 'Pi5',
        host: '100.64.0.21',
        user: 'xaventra',
        remotePath: '~/nova-core/.nova-skills',
        method: 'tailscale',
    },
    {
        name: 'Jetson',
        host: '100.64.0.22',
        user: 'xaventra',
        remotePath: '~/nova-core/.nova-skills',
        method: 'tailscale',
    },
]

// ============================================
// Core Logic
// ============================================

/**
 * Package a skill for distribution
 */
export function packageSkill(skillName: string): SkillPackage | null {
    const skillDir = join(SKILLS_DIR, skillName)
    if (!existsSync(skillDir)) {
        console.log(`[SkillDist] ⚠️ Skill not found: ${skillName}`)
        return null
    }

    const files = readdirSync(skillDir).filter(f => f.endsWith('.ts') || f.endsWith('.js') || f.endsWith('.json'))

    // Hash all files
    const hasher = createHash('sha256')
    for (const file of files) {
        hasher.update(readFileSync(join(skillDir, file)))
    }
    const hash = hasher.digest('hex').slice(0, 16)

    const pkg: SkillPackage = {
        name: skillName,
        version: `1.0.0-${hash.slice(0, 8)}`,
        hash,
        signed: false,
        files,
        createdAt: new Date().toISOString(),
        deployedTo: [],
    }

    // Sign with Code Guardian
    try {
        const { analyzeAST } = require('../security/ast-analyzer.js')
        let allSafe = true
        for (const file of files) {
            if (file.endsWith('.ts') || file.endsWith('.js')) {
                const code = readFileSync(join(skillDir, file), 'utf-8')
                const result = analyzeAST(code, file)
                if (!result.safe) {
                    console.log(`[SkillDist] 🚨 Skill ${skillName}/${file} failed security check!`)
                    allSafe = false
                }
            }
        }
        pkg.signed = allSafe
    } catch {
        console.log('[SkillDist] ⚠️ Code Guardian not available — skill unsigned')
    }

    // Save package manifest
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(join(DATA_DIR, `${skillName}.json`), JSON.stringify(pkg, null, 2))

    console.log(`[SkillDist] 📦 Packaged: ${skillName} v${pkg.version} (${files.length} files, signed: ${pkg.signed})`)
    return pkg
}

/**
 * Deploy a skill to all mesh nodes
 */
export async function deploySkill(skillName: string): Promise<{
    success: boolean
    deployed: string[]
    failed: string[]
}> {
    const pkg = packageSkill(skillName)
    if (!pkg) return { success: false, deployed: [], failed: ['Package failed'] }

    if (!pkg.signed) {
        console.log(`[SkillDist] 🚨 BLOCKED: Skill ${skillName} failed security check — NOT deploying!`)
        return { success: false, deployed: [], failed: ['Security check failed'] }
    }

    const deployed: string[] = []
    const failed: string[] = []
    const skillDir = join(SKILLS_DIR, skillName)

    for (const target of DEPLOY_TARGETS) {
        try {
            console.log(`[SkillDist] 🚀 Deploying ${skillName} to ${target.name}...`)

            // Create remote skill directory
            execSync(
                `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${target.user}@${target.host} "mkdir -p ${target.remotePath}/${skillName}"`,
                { timeout: 15000, stdio: 'pipe' }
            )

            // Copy files via tar pipe
            execSync(
                `cd "${skillDir}" && tar czf - . | ssh -o StrictHostKeyChecking=no ${target.user}@${target.host} "cd ${target.remotePath}/${skillName} && tar xzf -"`,
                { timeout: 30000, stdio: 'pipe', shell: 'C:\\Program Files\\Git\\bin\\bash.exe' }
            )

            deployed.push(target.name)
            console.log(`[SkillDist] ✅ Deployed to ${target.name}`)
        } catch (err: any) {
            failed.push(target.name)
            console.log(`[SkillDist] ❌ Failed on ${target.name}: ${err.message?.slice(0, 80)}`)
        }
    }

    // Update package
    pkg.deployedTo = deployed
    writeFileSync(join(DATA_DIR, `${skillName}.json`), JSON.stringify(pkg, null, 2))

    return { success: failed.length === 0, deployed, failed }
}

/**
 * List all packaged skills
 */
export function listDistributedSkills(): SkillPackage[] {
    if (!existsSync(DATA_DIR)) return []

    return readdirSync(DATA_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => {
            try { return JSON.parse(readFileSync(join(DATA_DIR, f), 'utf-8')) }
            catch { return null }
        })
        .filter(Boolean) as SkillPackage[]
}

/**
 * Deploy ALL local skills to mesh
 */
export async function deployAllSkills(): Promise<{ total: number; deployed: number; failed: number }> {
    if (!existsSync(SKILLS_DIR)) return { total: 0, deployed: 0, failed: 0 }

    const skills = readdirSync(SKILLS_DIR).filter(d =>
        existsSync(join(SKILLS_DIR, d)) && !d.startsWith('.')
    )

    let deployed = 0
    let failed = 0
    for (const skill of skills) {
        const result = await deploySkill(skill)
        if (result.success) deployed++
        else failed++
    }

    return { total: skills.length, deployed, failed }
}
