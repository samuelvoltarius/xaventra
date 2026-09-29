import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The migration cannot be executed here (no database in unit tests, and SQL
// must never be run against the real coordinator from a test). These checks
// pin the constructs the fencing guarantees depend on.
const sql = readFileSync(fileURLToPath(new URL('../../sql/mesh-coordination-v5.sql', import.meta.url)), 'utf8')
const executable = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n')

function functionBody(name: string): string {
    const start = executable.indexOf(`FUNCTION public.${name}(`)
    expect(start, `function ${name} missing`).toBeGreaterThanOrEqual(0)
    const bodyStart = executable.indexOf('$$', start)
    const bodyEnd = executable.indexOf('$$', bodyStart + 2)
    return executable.slice(start, bodyEnd)
}

describe('mesh-coordination-v5.sql (CL-07 fencing migration)', () => {
    it('is transactional and reloads the PostgREST schema', () => {
        expect(executable).toMatch(/^BEGIN;/m)
        expect(executable).toMatch(/NOTIFY pgrst, 'reload schema';\s*COMMIT;/)
    })

    it('draws every inserted epoch from one sequence, so a DELETE can never restart it at 1', () => {
        expect(executable).toContain('CREATE SEQUENCE IF NOT EXISTS public.nova_mesh_epoch_seq')
        const guard = functionBody('nova_mesh_leases_epoch_guard')
        expect(guard).toMatch(/IF TG_OP = 'INSERT' THEN\s+NEW\.epoch := nextval\('public\.nova_mesh_epoch_seq'\);/)
        expect(guard).toMatch(/NEW\.epoch < OLD\.epoch THEN\s+RAISE EXCEPTION/)
        expect(executable).toMatch(/BEFORE INSERT OR UPDATE ON public\.nova_mesh_leases/)
    })

    it('moves the sequence only forward (idempotent re-run, above every stored epoch)', () => {
        expect(executable).toMatch(/setval\(\s*'public\.nova_mesh_epoch_seq',\s*GREATEST\(\s*\(SELECT COALESCE\(MAX\(epoch\), 1\) FROM public\.nova_mesh_leases\),\s*\(SELECT last_value FROM public\.nova_mesh_epoch_seq\)/)
    })

    it('v2 renews only for the same node AND instance while live; anything else is a new term', () => {
        const v2 = functionBody('nova_acquire_service_lease_v2')
        expect(v2).toContain('p_holder_instance_id TEXT')
        expect(v2).toMatch(/current\.holder_instance_id IS NOT DISTINCT FROM EXCLUDED\.holder_instance_id\s+AND current\.expires_at > v_now THEN current\.epoch\s+ELSE EXCLUDED\.epoch/)
        expect(v2).toContain("'server_now', v_now")
        expect(v2).toContain("'ttl_ms', p_ttl_ms")
        // No client- or literal-computed epoch arithmetic survives.
        expect(v2).not.toMatch(/epoch \+ 1/)
    })

    it('keeps v1 for rolling upgrades without letting it reuse or lower an epoch', () => {
        const v1 = functionBody('nova_acquire_service_lease')
        expect(v1).not.toMatch(/epoch \+ 1/)
        expect(v1).toMatch(/current\.holder_instance_id IS NULL/)
        expect(v1).toContain('holder_instance_id = NULL')
    })

    it('offers a read-only live check that never writes', () => {
        const check = functionBody('nova_check_fence')
        expect(check).toMatch(/STABLE/)
        expect(check).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/)
        expect(check).toMatch(/l\.expires_at > statement_timestamp\(\)/)
    })

    it('linearises fenced shared-memory writes against the lease row and never lets an older epoch win', () => {
        const upsert = functionBody('nova_fenced_upsert_shared_memory')
        expect(upsert).toMatch(/FROM public\.nova_mesh_leases WHERE service = p_fence_service FOR SHARE/)
        expect(upsert).toMatch(/v_lease\.epoch <> p_epoch/)
        expect(upsert).toMatch(/v_lease\.expires_at <= clock_timestamp\(\)/)
        expect(upsert).toMatch(/WHERE existing\.writer_epoch IS NULL OR existing\.writer_epoch <= EXCLUDED\.writer_epoch/)
        expect(executable).toContain('ADD COLUMN IF NOT EXISTS writer_epoch BIGINT')
    })

    it('makes the lease table read-only for anon and keeps HA scopes behind the fenced RPC', () => {
        expect(executable).toContain('DROP POLICY IF EXISTS "Allow all for anon" ON public.nova_mesh_leases;')
        expect(executable).toMatch(/CREATE POLICY "nova_mesh_leases_read" ON public\.nova_mesh_leases FOR SELECT USING \(true\);/)
        expect(executable).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public\.nova_mesh_leases FROM %I/)
        for (const scope of ['ha-channel-state', 'ha-message-queue', 'outcome-ledger', 'outcome-checkpoint', 'codex-continuity']) {
            expect(executable).toContain(`'${scope}'`)
        }
        expect(executable).not.toMatch(/CREATE POLICY "Allow all for anon"/)
    })

    it('documents the way back to v4 and keeps the epoch guard on that way', () => {
        expect(sql).toContain('RÜCKWEG auf v4')
        const rollback = sql.slice(sql.indexOf('RÜCKWEG auf v4'))
        expect(rollback).not.toMatch(/DROP TRIGGER/)
        expect(rollback).toMatch(/DROP FUNCTION IF EXISTS public\.nova_acquire_service_lease_v2/)
    })
})
