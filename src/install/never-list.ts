// ============================================================================
// Nie-Liste (Stufe 2, feste Grenze 1). Code constant: no config key, no
// environment variable and no YOLO switch can lift it. A catalog entry, a
// computed rollback or a host-agent command that hits it is refused.
// ============================================================================

export interface NeverRule {
    readonly id: string
    readonly why: string
    /** Basenames of programs that may never be started. */
    readonly programs?: readonly string[]
    /** Exact arguments that may never appear (any program). */
    readonly args?: readonly string[]
    /** Argument patterns that may never appear (any program). */
    readonly argPatterns?: readonly RegExp[]
    /** Package names (apt) that may never be installed or removed. */
    readonly packagePatterns?: readonly RegExp[]
}

const rule = (value: NeverRule): NeverRule => Object.freeze({
    ...value,
    programs: value.programs && Object.freeze([...value.programs]),
    args: value.args && Object.freeze([...value.args]),
    argPatterns: value.argPatterns && Object.freeze([...value.argPatterns]),
    packagePatterns: value.packagePatterns && Object.freeze([...value.packagePatterns]),
})

export const NEVER_LIST: readonly NeverRule[] = Object.freeze([
    rule({ id: 'shell-pipe', why: 'Keine Shell, kein curl | sh, keine Interpreter mit freiem Code',
        programs: ['sh', 'bash', 'dash', 'zsh', 'ksh', 'fish', 'csh', 'tcsh', 'busybox', 'curl', 'wget', 'env', 'xargs', 'eval', 'exec',
            'python', 'python3', 'perl', 'ruby', 'php', 'lua', 'osascript', 'powershell', 'pwsh', 'cmd', 'cmd.exe', 'nohup', 'setsid'] }),
    rule({ id: 'privilege', why: 'Keine Rechteausweitung, keine Benutzer/sudoers',
        programs: ['sudo', 'su', 'doas', 'pkexec', 'runuser', 'visudo', 'passwd', 'chpasswd', 'usermod', 'useradd', 'userdel', 'groupadd',
            'chmod', 'chown', 'chgrp', 'setcap', 'chattr', 'crontab', 'at'] ,
        argPatterns: [/sudoers/i] }),
    rule({ id: 'power-services', why: 'Kein Neustart/Shutdown (NAS!), keine Dienste stoppen (vLLM, Hermes, Mail, Shop)',
        programs: ['reboot', 'shutdown', 'poweroff', 'halt', 'systemctl', 'service', 'init', 'telinit', 'kill', 'pkill', 'killall', 'rc-service'],
        argPatterns: [/vllm/i, /hermes/i, /purebeing/i, /postfix|dovecot|exim/i] }),
    rule({ id: 'network-access', why: 'Keine Firewall/SSH/Tailscale-Änderung',
        programs: ['ufw', 'iptables', 'ip6tables', 'nft', 'firewall-cmd', 'ssh', 'scp', 'sftp', 'sshd', 'ssh-keygen', 'tailscale', 'tailscaled', 'ip', 'route'] }),
    rule({ id: 'data-deletion', why: 'Keine Daten, Backups oder Rollback-Container löschen',
        programs: ['rm', 'rmdir', 'dd', 'mkfs', 'shred', 'wipefs', 'fdisk', 'sfdisk', 'parted', 'truncate', 'find', 'mv', 'unlink', 'rsync'],
        argPatterns: [/backup/i, /rollback-container/i] }),
    rule({ id: 'containers-database', why: 'Keine Container-Eingriffe, keine DB-Migrationen',
        programs: ['docker', 'podman', 'ctr', 'nerdctl', 'kubectl', 'psql', 'pg_ctl', 'pg_dump', 'supabase', 'prisma', 'knex', 'mysql', 'sqlite3'],
        argPatterns: [/^migrat/i] }),
    rule({ id: 'kernel-driver-cuda', why: 'Kein Kernel, kein Treiber, kein CUDA-Toolkit',
        programs: ['modprobe', 'insmod', 'rmmod', 'dkms', 'update-grub', 'grub-install', 'update-initramfs', 'mokutil', 'nvidia-installer'],
        packagePatterns: [/^linux-(image|headers|modules|generic|firmware)/, /^nvidia-/, /^cuda/, /^libcuda/, /^libnvidia/, /^firmware-/, /^grub/, /^dkms$/, /^initramfs/] }),
    rule({ id: 'system-upgrade', why: 'Kein apt upgrade / dist-upgrade / autoremove / purge',
        programs: ['do-release-upgrade', 'unattended-upgrade', 'unattended-upgrades', 'dpkg'],
        args: ['upgrade', 'dist-upgrade', 'full-upgrade', 'autoremove', 'autopurge', 'purge', '--purge', 'autoclean', 'clean', 'build-dep', 'source'] }),
    rule({ id: 'apt-hooks', why: 'Keine apt-Optionen, die Hooks oder Sicherheitsprüfungen verändern',
        argPatterns: [/^-o/, /^--option/, /invoke/i, /^--allow-/, /^--force/, /^-f$/, /^--fix-/, /^--reinstall$/, /^-t$/, /^--target-release/, /^--trivial-only$/] }),
    rule({ id: 'secrets', why: 'Secrets nie lesen, verschieben oder ausgeben; Telegram nur am Main',
        argPatterns: [/\.env(\.|$)/i, /secret/i, /token/i, /passw/i, /credential/i, /\.ssh(\/|$)/, /id_(rsa|ed25519|ecdsa)/, /telegram/i, /private[-_.]?key/i, /\.pem$/i] }),
    rule({ id: 'protected-packages', why: 'Systemkritische Pakete werden nie installiert oder entfernt',
        packagePatterns: [/^openssh/, /^ufw$/, /^iptables/, /^nftables/, /^tailscale/, /^sudo/, /^systemd/, /^docker/, /^containerd/, /^podman/,
            /^postgresql/, /^vllm/, /^postfix/, /^exim/, /^dovecot/, /^libc6$/, /^apt$/, /^dpkg$/, /^bash$/, /^coreutils$/, /^ubuntu-(minimal|standard|desktop)/] }),
])

export interface NeverListViolation { ruleId: string; why: string; value: string }

function baseName(program: string): string {
    const parts = String(program).split(/[\\/]/)
    return (parts[parts.length - 1] || '').toLowerCase()
}

/** Checks one argv (program + args). For apt-get every non-flag argument
 * after the verb is also treated as a package name. */
export function neverListViolation(argv: readonly string[], packages: readonly string[] = []): NeverListViolation | null {
    if (!Array.isArray(argv) || argv.length === 0) return { ruleId: 'malformed', why: 'Leerer Befehl', value: '' }
    const program = baseName(argv[0])
    const args = argv.slice(1).map(String)
    const aptPackages = program === 'apt-get' || program === 'apt'
        ? args.slice(1).filter(arg => !arg.startsWith('-'))
        : []
    for (const r of NEVER_LIST) {
        if (r.programs?.includes(program)) return { ruleId: r.id, why: r.why, value: program }
        for (const arg of args) {
            if (r.args?.includes(arg.toLowerCase())) return { ruleId: r.id, why: r.why, value: arg }
            if (r.argPatterns?.some(pattern => pattern.test(arg))) return { ruleId: r.id, why: r.why, value: arg }
        }
        for (const name of [...aptPackages, ...packages]) {
            if (r.packagePatterns?.some(pattern => pattern.test(name))) return { ruleId: r.id, why: r.why, value: name }
        }
    }
    return null
}

export function packageNeverListViolation(packages: readonly string[]): NeverListViolation | null {
    for (const r of NEVER_LIST) for (const name of packages) {
        if (r.packagePatterns?.some(pattern => pattern.test(name))) return { ruleId: r.id, why: r.why, value: name }
    }
    return null
}
