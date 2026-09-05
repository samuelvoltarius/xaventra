/**
 * Nova - Layer 0: File Backup System
 * 
 * Automatically creates backups before any file modification.
 * 
 * Features:
 * - Auto-backup before writes
 * - Timestamped backup files
 * - Configurable retention
 * - Restore capability
 */

import { existsSync, mkdirSync, copyFileSync, statSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, basename, extname } from 'node:path'

// ============================================
// Types
// ============================================

export interface BackupConfig {
    enabled: boolean
    backupDir: string
    maxBackupsPerFile: number    // Keep N most recent backups per file
    maxAgeHours: number          // Delete backups older than N hours
}

export interface BackupInfo {
    originalPath: string
    backupPath: string
    timestamp: number
    size: number
}

// ============================================
// Default Config
// ============================================

const DEFAULT_CONFIG: BackupConfig = {
    enabled: true,
    backupDir: '.nova-backups',
    maxBackupsPerFile: 10,
    maxAgeHours: 168,  // 7 days
}

// ============================================
// Backup Manager (Layer 0)
// ============================================

export class BackupManager {
    private config: BackupConfig
    private backupIndex: Map<string, BackupInfo[]> = new Map()

    constructor(config: Partial<BackupConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config }
        this.loadIndex()
    }

    // ============================================
    // Backup Operations
    // ============================================

    /**
     * Create a backup of a file BEFORE modifying it.
     * Call this before any write operation.
     */
    backup(filePath: string): BackupInfo | null {
        if (!this.config.enabled) return null

        // Only backup existing files
        if (!existsSync(filePath)) return null

        try {
            // Create backup directory
            const backupDir = this.getBackupDirForFile(filePath)
            if (!existsSync(backupDir)) {
                mkdirSync(backupDir, { recursive: true })
            }

            // Generate backup filename with timestamp
            const timestamp = Date.now()
            const ext = extname(filePath)
            const name = basename(filePath, ext)
            const backupName = `${name}.${timestamp}${ext}`
            const backupPath = join(backupDir, backupName)

            // Copy file to backup
            copyFileSync(filePath, backupPath)

            const stat = statSync(backupPath)
            const info: BackupInfo = {
                originalPath: filePath,
                backupPath,
                timestamp,
                size: stat.size,
            }

            // Update index
            this.addToIndex(filePath, info)

            // Cleanup old backups
            this.pruneBackups(filePath)

            console.log(`[Backup] Created: ${backupPath}`)
            return info

        } catch (err) {
            console.error(`[Backup] Failed to backup ${filePath}:`, err)
            return null
        }
    }

    /**
     * Restore a file from its most recent backup.
     */
    restore(filePath: string): boolean {
        const backups = this.getBackups(filePath)
        if (backups.length === 0) {
            console.log(`[Backup] No backups found for: ${filePath}`)
            return false
        }

        // Get most recent backup
        const latest = backups[backups.length - 1]

        try {
            copyFileSync(latest.backupPath, filePath)
            console.log(`[Backup] Restored: ${filePath} from ${latest.backupPath}`)
            return true
        } catch (err) {
            console.error(`[Backup] Failed to restore ${filePath}:`, err)
            return false
        }
    }

    /**
     * Restore a file from a specific backup.
     */
    restoreFromBackup(backupPath: string, targetPath: string): boolean {
        if (!existsSync(backupPath)) {
            console.log(`[Backup] Backup not found: ${backupPath}`)
            return false
        }

        try {
            copyFileSync(backupPath, targetPath)
            console.log(`[Backup] Restored: ${targetPath} from ${backupPath}`)
            return true
        } catch (err) {
            console.error(`[Backup] Failed to restore:`, err)
            return false
        }
    }

    /**
     * Get all backups for a file.
     */
    getBackups(filePath: string): BackupInfo[] {
        return this.backupIndex.get(filePath) || []
    }

    /**
     * Get the most recent backup for a file.
     */
    getLatestBackup(filePath: string): BackupInfo | null {
        const backups = this.getBackups(filePath)
        return backups.length > 0 ? backups[backups.length - 1] : null
    }

    // ============================================
    // Safe File Operations
    // ============================================

    /**
     * Write to file with automatic backup.
     * This is the safe way to modify files.
     */
    safeWrite(filePath: string, content: string | Buffer): void {
        // Backup first
        this.backup(filePath)

        // Ensure directory exists
        const dir = dirname(filePath)
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true })
        }

        // Write file
        if (typeof content === 'string') {
            writeFileSync(filePath, content, 'utf-8')
        } else {
            writeFileSync(filePath, content)
        }

        console.log(`[Backup] Safe write: ${filePath}`)
    }

    /**
     * Read file content.
     */
    safeRead(filePath: string): string | null {
        if (!existsSync(filePath)) return null
        return readFileSync(filePath, 'utf-8')
    }

    // ============================================
    // Cleanup
    // ============================================

    private pruneBackups(filePath: string): void {
        const backups = this.getBackups(filePath)

        // Remove old backups beyond max count
        while (backups.length > this.config.maxBackupsPerFile) {
            const oldest = backups.shift()
            if (oldest && existsSync(oldest.backupPath)) {
                unlinkSync(oldest.backupPath)
                console.log(`[Backup] Pruned old backup: ${oldest.backupPath}`)
            }
        }

        // Remove backups older than max age
        const cutoff = Date.now() - (this.config.maxAgeHours * 60 * 60 * 1000)
        const filtered = backups.filter(b => {
            if (b.timestamp < cutoff) {
                if (existsSync(b.backupPath)) {
                    unlinkSync(b.backupPath)
                    console.log(`[Backup] Pruned expired backup: ${b.backupPath}`)
                }
                return false
            }
            return true
        })

        this.backupIndex.set(filePath, filtered)
        this.saveIndex()
    }

    /**
     * Clean up all old backups.
     */
    cleanupAll(): number {
        let cleaned = 0

        for (const filePath of this.backupIndex.keys()) {
            const before = this.getBackups(filePath).length
            this.pruneBackups(filePath)
            const after = this.getBackups(filePath).length
            cleaned += before - after
        }

        return cleaned
    }

    // ============================================
    // Index Management
    // ============================================

    private getBackupDirForFile(filePath: string): string {
        // Create a subdirectory based on the file's directory structure
        const normalized = filePath.replace(/[:\\]/g, '_').replace(/\//g, '_')
        return join(this.config.backupDir, normalized)
    }

    private addToIndex(filePath: string, info: BackupInfo): void {
        if (!this.backupIndex.has(filePath)) {
            this.backupIndex.set(filePath, [])
        }
        this.backupIndex.get(filePath)!.push(info)

        // Sort by timestamp
        this.backupIndex.get(filePath)!.sort((a, b) => a.timestamp - b.timestamp)

        this.saveIndex()
    }

    private loadIndex(): void {
        const indexPath = join(this.config.backupDir, 'index.json')

        try {
            if (existsSync(indexPath)) {
                const data = JSON.parse(readFileSync(indexPath, 'utf-8'))
                this.backupIndex = new Map(Object.entries(data))
            }
        } catch (err) {
            console.error('[Backup] Failed to load index:', err)
        }
    }

    private saveIndex(): void {
        try {
            if (!existsSync(this.config.backupDir)) {
                mkdirSync(this.config.backupDir, { recursive: true })
            }

            const indexPath = join(this.config.backupDir, 'index.json')
            const data = Object.fromEntries(this.backupIndex)
            writeFileSync(indexPath, JSON.stringify(data, null, 2))
        } catch (err) {
            console.error('[Backup] Failed to save index:', err)
        }
    }

    // ============================================
    // Stats
    // ============================================

    getStats(): {
        totalFiles: number
        totalBackups: number
        totalSizeBytes: number
        oldestBackup: number | null
        newestBackup: number | null
    } {
        let totalBackups = 0
        let totalSizeBytes = 0
        let oldestBackup: number | null = null
        let newestBackup: number | null = null

        for (const backups of this.backupIndex.values()) {
            totalBackups += backups.length

            for (const backup of backups) {
                totalSizeBytes += backup.size

                if (oldestBackup === null || backup.timestamp < oldestBackup) {
                    oldestBackup = backup.timestamp
                }
                if (newestBackup === null || backup.timestamp > newestBackup) {
                    newestBackup = backup.timestamp
                }
            }
        }

        return {
            totalFiles: this.backupIndex.size,
            totalBackups,
            totalSizeBytes,
            oldestBackup,
            newestBackup,
        }
    }

    /**
     * List all files that have backups.
     */
    listBackedUpFiles(): string[] {
        return Array.from(this.backupIndex.keys())
    }
}

// ============================================
// Global Instance
// ============================================

let backupInstance: BackupManager | null = null

export function getBackupManager(): BackupManager {
    if (!backupInstance) {
        backupInstance = new BackupManager()
    }
    return backupInstance
}

export function createBackupManager(config?: Partial<BackupConfig>): BackupManager {
    return new BackupManager(config)
}

// ============================================
// Convenience Functions
// ============================================

/**
 * Backup a file before modification.
 */
export function backupFile(filePath: string): BackupInfo | null {
    return getBackupManager().backup(filePath)
}

/**
 * Write file with automatic backup.
 */
export function safeWriteFile(filePath: string, content: string | Buffer): void {
    getBackupManager().safeWrite(filePath, content)
}

/**
 * Restore file from latest backup.
 */
export function restoreFile(filePath: string): boolean {
    return getBackupManager().restore(filePath)
}

export default { BackupManager, getBackupManager, createBackupManager, backupFile, safeWriteFile, restoreFile }
