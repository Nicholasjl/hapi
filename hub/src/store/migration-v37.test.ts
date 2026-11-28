import { expect, it, spyOn } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '.'

it('adds session_native_steps when upgrading a v36 database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-native-steps-v37-migration-'))
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
        const path = join(dir, 'hub.db')
        new Store(path).close()
        expect(log).not.toHaveBeenCalled()
        const legacy = new Database(path)
        legacy.exec('DROP TABLE session_native_steps; PRAGMA user_version = 36;')
        legacy.close()
        const migrated = new Store(path)
        try {
            expect(log.mock.calls).toEqual([
                ['[Store] Migrating database schema from v36 to v37...'],
                ['[Store] Database schema migration complete (v36 to v37).']
            ])
            const internalDb = (migrated as unknown as { db: Database }).db
            expect((internalDb.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(37)
            const session = migrated.sessions.getOrCreateSession('mig-v37', { path: '/tmp/p', host: 'h' }, null, 'default')
            const m0 = migrated.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 's0' } })
            const m1 = migrated.messages.addMessage(session.id, { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 's1' } } })
            const m2 = migrated.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 's2' } })
            expect(migrated.nativeSteps.recordSteps(session.id, 'agy-1', [
                { anchor: 'step:0:0', fingerprint: 'a'.repeat(64), messageId: m0.id },
                { anchor: 'step:1:0', fingerprint: 'b'.repeat(64), messageId: m1.id }
            ])).toEqual({ inserted: 2 })
            // Duplicate anchor must keep the original fingerprint and message link rather than overwriting.
            expect(migrated.nativeSteps.recordSteps(session.id, 'agy-1', [
                { anchor: 'step:1:0', fingerprint: 'c'.repeat(64), messageId: m2.id },
                { anchor: 'step:2:0', fingerprint: 'd'.repeat(64), messageId: m2.id }
            ])).toEqual({ inserted: 1 })
            expect(migrated.nativeSteps.getSteps(session.id, 'agy-1')).toEqual([
                { anchor: 'step:0:0', fingerprint: 'a'.repeat(64), messageId: m0.id, seq: 1 },
                { anchor: 'step:1:0', fingerprint: 'b'.repeat(64), messageId: m1.id, seq: 2 },
                { anchor: 'step:2:0', fingerprint: 'd'.repeat(64), messageId: m2.id, seq: 3 }
            ])

            const target = migrated.sessions.getOrCreateSession('mig-v37-target', { path: '/tmp/p', host: 'h' }, null, 'default')
            migrated.messages.mergeSessionMessages(session.id, target.id)
            expect(migrated.nativeSteps.transferSession(session.id, target.id)).toBe(3)
            expect(migrated.nativeSteps.getSteps(session.id, 'agy-1')).toEqual([])
            expect(migrated.nativeSteps.getSteps(target.id, 'agy-1')).toEqual([
                { anchor: 'step:0:0', fingerprint: 'a'.repeat(64), messageId: m0.id, seq: 1 },
                { anchor: 'step:1:0', fingerprint: 'b'.repeat(64), messageId: m1.id, seq: 2 },
                { anchor: 'step:2:0', fingerprint: 'd'.repeat(64), messageId: m2.id, seq: 3 }
            ])
        } finally { migrated.close() }
        log.mockClear()
        new Store(path).close()
        expect(log).not.toHaveBeenCalled()
    } finally {
        log.mockRestore()
        Bun.gc(true)
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
})
