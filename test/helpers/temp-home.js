import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
function snapshotEnv() {
    return {
        home: process.env.HOME,
        userProfile: process.env.USERPROFILE,
        homeDrive: process.env.HOMEDRIVE,
        homePath: process.env.HOMEPATH,
        stateDir: process.env.CLAWDBOT_STATE_DIR,
    };
}
function restoreEnv(snapshot) {
    const restoreKey = (key, value) => {
        if (value === undefined)
            delete process.env[key];
        else
            process.env[key] = value;
    };
    restoreKey("HOME", snapshot.home);
    restoreKey("USERPROFILE", snapshot.userProfile);
    restoreKey("HOMEDRIVE", snapshot.homeDrive);
    restoreKey("HOMEPATH", snapshot.homePath);
    restoreKey("CLAWDBOT_STATE_DIR", snapshot.stateDir);
}
function snapshotExtraEnv(keys) {
    const snapshot = {};
    for (const key of keys)
        snapshot[key] = process.env[key];
    return snapshot;
}
function restoreExtraEnv(snapshot) {
    for (const [key, value] of Object.entries(snapshot)) {
        if (value === undefined)
            delete process.env[key];
        else
            process.env[key] = value;
    }
}
function setTempHome(base) {
    process.env.HOME = base;
    process.env.USERPROFILE = base;
    process.env.CLAWDBOT_STATE_DIR = path.join(base, ".clawdbot");
    if (process.platform !== "win32")
        return;
    const match = base.match(/^([A-Za-z]:)(.*)$/);
    if (!match)
        return;
    process.env.HOMEDRIVE = match[1];
    process.env.HOMEPATH = match[2] || "\\";
}
export async function withTempHome(fn, opts = {}) {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), opts.prefix ?? "clawdbot-test-home-"));
    const snapshot = snapshotEnv();
    const envKeys = Object.keys(opts.env ?? {});
    for (const key of envKeys) {
        if (key === "HOME" || key === "USERPROFILE" || key === "HOMEDRIVE" || key === "HOMEPATH") {
            throw new Error(`withTempHome: use built-in home env (got ${key})`);
        }
    }
    const envSnapshot = snapshotExtraEnv(envKeys);
    setTempHome(base);
    await fs.mkdir(path.join(base, ".clawdbot", "agents", "main", "sessions"), { recursive: true });
    if (opts.env) {
        for (const [key, raw] of Object.entries(opts.env)) {
            const value = typeof raw === "function" ? raw(base) : raw;
            if (value === undefined)
                delete process.env[key];
            else
                process.env[key] = value;
        }
    }
    try {
        return await fn(base);
    }
    finally {
        restoreExtraEnv(envSnapshot);
        restoreEnv(snapshot);
        try {
            await fs.rm(base, {
                recursive: true,
                force: true,
                maxRetries: 10,
                retryDelay: 50,
            });
        }
        catch {
            // ignore cleanup failures in tests
        }
    }
}
//# sourceMappingURL=temp-home.js.map