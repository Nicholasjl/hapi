import type { Database } from 'bun:sqlite'

export const NATIVE_STEPS_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS session_native_steps (
        session_id TEXT NOT NULL,
        native_id TEXT NOT NULL,
        anchor TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        message_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, native_id, anchor),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_session_native_steps_session_native_seq
        ON session_native_steps(session_id, native_id, seq);
`

export type StoredNativeStep = {
    anchor: string
    fingerprint: string
    messageId: string
    seq: number
}

/**
 * Durable append-only ledger of confirmed native transcript step anchors,
 * content hashes, and owning durable HAPI message IDs for imported sessions.
 * Kept out of session metadata so growth never swells keepalive/metadata
 * snapshots or hits socket payload caps.
 */
export class NativeStepStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    recordSteps(
        sessionId: string,
        nativeId: string,
        steps: ReadonlyArray<{ anchor: string; fingerprint: string; messageId: string }>,
        now: number = Date.now()
    ): { inserted: number } {
        if (steps.length === 0) return { inserted: 0 }
        return this.db.transaction(() => {
            const maxRow = this.db.prepare(
                'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM session_native_steps WHERE session_id = ? AND native_id = ?'
            ).get(sessionId, nativeId) as { max_seq: number } | null
            let nextSeq = (maxRow?.max_seq ?? 0) + 1
            const insertStmt = this.db.prepare(`
                INSERT OR IGNORE INTO session_native_steps
                    (session_id, native_id, anchor, fingerprint, message_id, seq, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `)
            let inserted = 0
            for (const step of steps) {
                const res = insertStmt.run(
                    sessionId,
                    nativeId,
                    step.anchor,
                    step.fingerprint,
                    step.messageId,
                    nextSeq,
                    now
                )
                if (res.changes > 0) {
                    nextSeq += 1
                    inserted += 1
                }
            }
            return { inserted }
        })()
    }

    getSteps(sessionId: string, nativeId: string): StoredNativeStep[] {
        return this.db.prepare(`
            SELECT anchor, fingerprint, message_id AS messageId, seq
            FROM session_native_steps
            WHERE session_id = ? AND native_id = ?
            ORDER BY seq ASC
        `).all(sessionId, nativeId) as StoredNativeStep[]
    }

    transferSession(fromSessionId: string, toSessionId: string): number {
        if (fromSessionId === toSessionId) return 0
        return this.db.transaction(() => {
            const sourceRows = this.db.prepare(`
                SELECT native_id, anchor, fingerprint, message_id, created_at
                FROM session_native_steps
                WHERE session_id = ?
                ORDER BY native_id ASC, seq ASC
            `).all(fromSessionId) as Array<{
                native_id: string
                anchor: string
                fingerprint: string
                message_id: string
                created_at: number
            }>
            if (sourceRows.length === 0) return 0

            const maxStmt = this.db.prepare(
                'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM session_native_steps WHERE session_id = ? AND native_id = ?'
            )
            const insertStmt = this.db.prepare(`
                INSERT OR IGNORE INTO session_native_steps
                    (session_id, native_id, anchor, fingerprint, message_id, seq, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `)
            const nextSeqByNative = new Map<string, number>()
            let moved = 0
            for (const row of sourceRows) {
                let nextSeq = nextSeqByNative.get(row.native_id)
                if (nextSeq === undefined) {
                    const maxRow = maxStmt.get(toSessionId, row.native_id) as { max_seq: number } | null
                    nextSeq = (maxRow?.max_seq ?? 0) + 1
                }
                const res = insertStmt.run(
                    toSessionId,
                    row.native_id,
                    row.anchor,
                    row.fingerprint,
                    row.message_id,
                    nextSeq,
                    row.created_at
                )
                if (res.changes > 0) {
                    nextSeq += 1
                    moved += 1
                }
                nextSeqByNative.set(row.native_id, nextSeq)
            }
            this.db.prepare('DELETE FROM session_native_steps WHERE session_id = ?').run(fromSessionId)
            return moved
        })()
    }
}
