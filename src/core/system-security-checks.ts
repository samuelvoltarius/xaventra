/**
 * Pure helpers for the boot-time security baseline (nova-boot.ts, R2 NZ-26).
 */

/**
 * Effective sshd auth settings from config text. sshd uses the FIRST value it
 * obtains for a keyword, ignores comments, and defaults PasswordAuthentication
 * to yes – a commented-out "#PasswordAuthentication no" is NOT key-only.
 * Pass drop-in files (sshd_config.d, included at the top) before the main file.
 */
export function effectiveSshdAuth(configTexts: string[]): { passwordAuthentication: boolean; permitRootLogin: string } {
    const values = new Map<string, string>()
    for (const text of configTexts) {
        for (const raw of String(text || '').split(/\r?\n/)) {
            const line = raw.trim()
            if (!line || line.startsWith('#')) continue
            // Settings inside a Match block apply only conditionally.
            if (/^match\s/i.test(line)) break
            const match = /^(\S+)\s+(.+)$/.exec(line)
            if (!match) continue
            const key = match[1].toLowerCase()
            if (!values.has(key)) values.set(key, match[2].trim().toLowerCase())
        }
    }
    return {
        passwordAuthentication: (values.get('passwordauthentication') ?? 'yes') !== 'no',
        permitRootLogin: values.get('permitrootlogin') ?? 'prohibit-password',
    }
}

/** `ufw status` exits 0 even when inactive; only "Status: active" counts. */
export function ufwOutputIsActive(output: string): boolean {
    return /^\s*Status:\s*active\b/im.test(String(output || ''))
}

/** Genesis may change the firewall only with an explicit operator opt-in
 * (R2 NZ-25): a default-deny UFW can lock out SSH on a custom port and block
 * mesh/REST ports. */
export function firewallChangeApproved(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.NOVA_GENESIS_FIREWALL === 'apply'
}
