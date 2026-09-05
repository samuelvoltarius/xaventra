/**
 * L11 Project Manager - Project Context and Roadmap Memory
 * 
 * Maintains project state across sessions:
 * - Current project and feature being worked on
 * - Task tracking (what's done, what's pending)
 * - Tech stack awareness
 * - Key files tracking
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export interface ProjectTask {
    id: string
    title: string
    description?: string
    status: 'pending' | 'in-progress' | 'done' | 'blocked'
    files: string[]
    createdAt: number
    completedAt?: number
}

export interface ProjectFeature {
    id: string
    name: string
    description?: string
    tasks: ProjectTask[]
    status: 'planning' | 'in-progress' | 'testing' | 'done'
    createdAt: number
    completedAt?: number
}

export interface ProjectState {
    id: string
    name: string
    description: string
    rootPath: string
    techStack: string[]
    keyFiles: string[]
    features: ProjectFeature[]
    currentFeatureId?: string
    currentTaskId?: string
    createdAt: number
    updatedAt: number
}

// ============================================
// Project Manager
// ============================================

const PROJECT_DIR = '.nova-projects'

export class ProjectManager {
    private projects: Map<string, ProjectState> = new Map()
    private activeProjectId: string | null = null
    private storageDir: string

    constructor(baseDir?: string) {
        this.storageDir = baseDir || join(process.cwd(), PROJECT_DIR)

        if (!existsSync(this.storageDir)) {
            mkdirSync(this.storageDir, { recursive: true })
        }

        this.loadAllProjects()
        console.log(`[L11 ProjectManager] Loaded ${this.projects.size} projects`)
    }

    // ============================================
    // Project CRUD
    // ============================================

    createProject(name: string, description: string, rootPath?: string): ProjectState {
        const id = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

        const project: ProjectState = {
            id,
            name,
            description,
            rootPath: rootPath || process.cwd(),
            techStack: [],
            keyFiles: [],
            features: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
        }

        this.projects.set(id, project)
        this.activeProjectId = id
        this.saveProject(project)

        console.log(`[L11 ProjectManager] Created project: ${name}`)
        return project
    }

    getProject(id: string): ProjectState | undefined {
        return this.projects.get(id)
    }

    getActiveProject(): ProjectState | undefined {
        if (!this.activeProjectId) return undefined
        return this.projects.get(this.activeProjectId)
    }

    setActiveProject(id: string): boolean {
        if (this.projects.has(id)) {
            this.activeProjectId = id
            return true
        }
        return false
    }

    getAllProjects(): ProjectState[] {
        return Array.from(this.projects.values())
    }

    // ============================================
    // Feature Management
    // ============================================

    addFeature(name: string, description?: string): ProjectFeature | null {
        const project = this.getActiveProject()
        if (!project) return null

        const feature: ProjectFeature = {
            id: `feat_${Date.now()}`,
            name,
            description,
            tasks: [],
            status: 'planning',
            createdAt: Date.now(),
        }

        project.features.push(feature)
        project.currentFeatureId = feature.id
        project.updatedAt = Date.now()
        this.saveProject(project)

        console.log(`[L11 ProjectManager] Added feature: ${name}`)
        return feature
    }

    getCurrentFeature(): ProjectFeature | undefined {
        const project = this.getActiveProject()
        if (!project || !project.currentFeatureId) return undefined
        return project.features.find(f => f.id === project.currentFeatureId)
    }

    setFeatureStatus(featureId: string, status: ProjectFeature['status']): boolean {
        const project = this.getActiveProject()
        if (!project) return false

        const feature = project.features.find(f => f.id === featureId)
        if (!feature) return false

        feature.status = status
        if (status === 'done') {
            feature.completedAt = Date.now()
        }
        project.updatedAt = Date.now()
        this.saveProject(project)
        return true
    }

    // ============================================
    // Task Management
    // ============================================

    addTask(title: string, description?: string, files: string[] = []): ProjectTask | null {
        const feature = this.getCurrentFeature()
        const project = this.getActiveProject()
        if (!feature || !project) return null

        const task: ProjectTask = {
            id: `task_${Date.now()}`,
            title,
            description,
            status: 'pending',
            files,
            createdAt: Date.now(),
        }

        feature.tasks.push(task)

        // Auto-start first task if none active
        if (!project.currentTaskId) {
            project.currentTaskId = task.id
            task.status = 'in-progress'
        }

        project.updatedAt = Date.now()
        this.saveProject(project)

        console.log(`[L11 ProjectManager] Added task: ${title}`)
        return task
    }

    getCurrentTask(): ProjectTask | undefined {
        const project = this.getActiveProject()
        const feature = this.getCurrentFeature()
        if (!project || !feature || !project.currentTaskId) return undefined
        return feature.tasks.find(t => t.id === project.currentTaskId)
    }

    completeCurrentTask(): ProjectTask | null {
        const project = this.getActiveProject()
        const feature = this.getCurrentFeature()
        const task = this.getCurrentTask()

        if (!project || !feature || !task) return null

        task.status = 'done'
        task.completedAt = Date.now()

        // Find next pending task
        const nextTask = feature.tasks.find(t => t.status === 'pending')
        if (nextTask) {
            project.currentTaskId = nextTask.id
            nextTask.status = 'in-progress'
        } else {
            project.currentTaskId = undefined
            // Check if feature is complete
            const allDone = feature.tasks.every(t => t.status === 'done')
            if (allDone) {
                feature.status = 'done'
                feature.completedAt = Date.now()
            }
        }

        project.updatedAt = Date.now()
        this.saveProject(project)
        return task
    }

    setTaskStatus(taskId: string, status: ProjectTask['status']): boolean {
        const feature = this.getCurrentFeature()
        const project = this.getActiveProject()
        if (!feature || !project) return false

        const task = feature.tasks.find(t => t.id === taskId)
        if (!task) return false

        task.status = status
        if (status === 'in-progress') {
            project.currentTaskId = taskId
        }
        if (status === 'done') {
            task.completedAt = Date.now()
        }

        project.updatedAt = Date.now()
        this.saveProject(project)
        return true
    }

    // ============================================
    // Tech Stack & Key Files
    // ============================================

    setTechStack(stack: string[]): void {
        const project = this.getActiveProject()
        if (!project) return

        project.techStack = stack
        project.updatedAt = Date.now()
        this.saveProject(project)
    }

    addKeyFile(path: string): void {
        const project = this.getActiveProject()
        if (!project) return

        if (!project.keyFiles.includes(path)) {
            project.keyFiles.push(path)
            project.updatedAt = Date.now()
            this.saveProject(project)
        }
    }

    // ============================================
    // Context for LLM
    // ============================================

    getProjectContext(): string {
        const project = this.getActiveProject()
        if (!project) {
            return 'Kein aktives Projekt. Nutze /project new <name> um ein Projekt zu starten.'
        }

        const feature = this.getCurrentFeature()
        const task = this.getCurrentTask()

        let context = `## Aktuelles Projekt: ${project.name}\n`
        context += `${project.description}\n\n`

        if (project.techStack.length > 0) {
            context += `**Tech Stack:** ${project.techStack.join(', ')}\n`
        }

        if (feature) {
            context += `\n### Aktuelles Feature: ${feature.name}\n`
            context += `Status: ${feature.status}\n`

            const done = feature.tasks.filter(t => t.status === 'done').length
            const total = feature.tasks.length
            context += `Fortschritt: ${done}/${total} Tasks\n`

            if (task) {
                context += `\n**Aktueller Task:** ${task.title}\n`
                if (task.description) {
                    context += `${task.description}\n`
                }
                if (task.files.length > 0) {
                    context += `Relevante Dateien: ${task.files.join(', ')}\n`
                }
            }
        }

        return context
    }

    // ============================================
    // Status Formatting
    // ============================================

    formatStatus(): string {
        const project = this.getActiveProject()
        if (!project) {
            return `📁 **Kein Projekt aktiv**\n\nNutze \`/project new <name>\` um ein Projekt zu starten.`
        }

        let msg = `📁 **${project.name}**\n`
        msg += `${project.description}\n\n`

        if (project.techStack.length > 0) {
            msg += `🔧 **Tech Stack:** ${project.techStack.join(', ')}\n`
        }

        const feature = this.getCurrentFeature()
        if (feature) {
            const statusIcon = {
                'planning': '📋',
                'in-progress': '🔄',
                'testing': '🧪',
                'done': '✅',
            }[feature.status]

            msg += `\n${statusIcon} **Feature:** ${feature.name}\n`

            for (const task of feature.tasks) {
                const taskIcon = {
                    'pending': '⬜',
                    'in-progress': '🔷',
                    'done': '✅',
                    'blocked': '🔴',
                }[task.status]

                const isCurrent = task.id === project.currentTaskId
                msg += `  ${taskIcon} ${task.title}${isCurrent ? ' ← aktuell' : ''}\n`
            }
        } else {
            msg += `\nKein aktives Feature. Nutze \`/project feature <name>\` um eins hinzuzufügen.`
        }

        return msg
    }

    // ============================================
    // Storage
    // ============================================

    private saveProject(project: ProjectState): void {
        const filepath = join(this.storageDir, `${project.id}.json`)
        writeFileSync(filepath, JSON.stringify(project, null, 2))
    }

    private loadAllProjects(): void {
        if (!existsSync(this.storageDir)) return

        const files = readdirSync(this.storageDir).filter(f => f.endsWith('.json'))

        for (const file of files) {
            try {
                const data = JSON.parse(readFileSync(join(this.storageDir, file), 'utf-8'))
                this.projects.set(data.id, data)

                // Set most recent as active
                if (!this.activeProjectId || data.updatedAt > (this.getActiveProject()?.updatedAt || 0)) {
                    this.activeProjectId = data.id
                }
            } catch (err) {
                console.error(`[L11 ProjectManager] Failed to load ${file}: ${err}`)
            }
        }
    }
}

// ============================================
// Singleton
// ============================================

let projectManager: ProjectManager | null = null

export function getProjectManager(): ProjectManager {
    if (!projectManager) {
        projectManager = new ProjectManager()
    }
    return projectManager
}

export default { ProjectManager, getProjectManager }
