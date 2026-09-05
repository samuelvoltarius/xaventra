import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const writeQueues = new Map<string, Promise<void>>()

/** Serializes writes per path and replaces files atomically. */
export function atomicWriteFile(path: string, data: string | Uint8Array): Promise<void> {
    const previous = writeQueues.get(path) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(async () => {
        await mkdir(dirname(path), { recursive: true })
        const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
        try {
            await writeFile(temporary, data)
            await rename(temporary, path)
        } finally {
            await rm(temporary, { force: true }).catch(() => undefined)
        }
    })
    writeQueues.set(path, next)
    return next.finally(() => {
        if (writeQueues.get(path) === next) writeQueues.delete(path)
    })
}

export function atomicWriteJson(path: string, value: unknown): Promise<void> {
    return atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

export function atomicWriteFileSync(path: string, data: string | Uint8Array): void {
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    try {
        writeFileSync(temporary, data)
        renameSync(temporary, path)
    } finally {
        try { rmSync(temporary, { force: true }) } catch { /* already renamed */ }
    }
}

export function atomicWriteJsonSync(path: string, value: unknown): void {
    atomicWriteFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

export async function flushAtomicWrites(): Promise<void> {
    await Promise.allSettled(writeQueues.values())
}
