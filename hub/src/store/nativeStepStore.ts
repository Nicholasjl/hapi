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

    CREATE TABLE IF NOT EXISTS session_native_deliveries (
        session_id TEXT NOT NULL,
        native_id TEXT NOT NULL,
        delivery_seq INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('user', 'agent')),
        message_id TEXT NOT NULL,
        local_ids_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, native_id, delivery_seq),
        UNIQUE (session_id, native_id, kind, message_id),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_session_native_deliveries_session_native_seq
        ON session_native_deliveries(session_id, native_id, delivery_seq);
`

export type StoredNativeStep = {
    anchor: string
    fingerprint: string
    messageId: string
    seq: number
}

export type StoredPendingNativeDelivery = {
    deliverySeq: number
    kind: 'user' | 'agent'
    messageId: string
    localIds: string[]
}

function parseLocalIdsJson(raw: string): string[] {
    try {
        const parsed = JSON.parse(raw) as unknown
        return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
    } catch {
        return []
    }
}

/**
 * Durable append-only ledger of confirmed native transcript step anchors,
 * content hashes, and owning durable HAPI message IDs (plus uncommitted
 * live delivery intents) for imported sessions. Kept out of session metadata so
 * growth never swells keepalive/metadata snapshots or hits socket payload caps.
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

    recordPendingDelivery(
        sessionId: string,
        nativeId: string,
        delivery: { kind: 'user' | 'agent'; messageId: string; localIds: string[] },
        createdAt: number = Date.now(),
        options?: { moveToTail?: boolean }
    ): boolean {
        if (!nativeId || !delivery.messageId || delivery.localIds.length === 0) return false
        return this.db.transaction(() => {
            if (options?.moveToTail) {
                this.db.prepare(`
                    DELETE FROM session_native_deliveries
                    WHERE session_id = ? AND native_id = ? AND kind = ? AND message_id = ?
                `).run(sessionId, nativeId, delivery.kind, delivery.messageId)
            }
            const maxRow = this.db.prepare(
                'SELECT COALESCE(MAX(delivery_seq), 0) AS max_seq FROM session_native_deliveries WHERE session_id = ? AND native_id = ?'
            ).get(sessionId, nativeId) as { max_seq: number } | null
            const nextSeq = (maxRow?.max_seq ?? 0) + 1
            const res = this.db.prepare(`
                INSERT OR IGNORE INTO session_native_deliveries
                    (session_id, native_id, delivery_seq, kind, message_id, local_ids_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
                sessionId,
                nativeId,
                nextSeq,
                delivery.kind,
                delivery.messageId,
                JSON.stringify(delivery.localIds),
                createdAt
            )
            return res.changes > 0
        })()
    }

    getPendingDeliveries(sessionId: string, nativeId: string): StoredPendingNativeDelivery[] {
        const rows = this.db.prepare(`
            SELECT delivery_seq, kind, message_id, local_ids_json
            FROM session_native_deliveries
            WHERE session_id = ? AND native_id = ?
            ORDER BY delivery_seq ASC
        `).all(sessionId, nativeId) as Array<{
            delivery_seq: number
            kind: 'user' | 'agent'
            message_id: string
            local_ids_json: string
        }>
        return rows.map((row) => ({
            deliverySeq: row.delivery_seq,
            kind: row.kind,
            messageId: row.message_id,
            localIds: parseLocalIdsJson(row.local_ids_json)
        }))
    }

    removePendingDeliveriesByMessageIds(
        sessionId: string,
        nativeId: string,
        messageIds: ReadonlyArray<string>
    ): number {
        const unique = [...new Set(messageIds)]
        if (unique.length === 0) return 0
        return this.db.transaction(() => {
            const stmt = this.db.prepare(
                'DELETE FROM session_native_deliveries WHERE session_id = ? AND native_id = ? AND message_id = ?'
            )
            let deleted = 0
            for (const messageId of unique) {
                deleted += stmt.run(sessionId, nativeId, messageId).changes
            }
            return deleted
        })()
    }

    removePendingDeliveriesByLocalIds(
        sessionId: string,
        nativeId: string,
        localIds: ReadonlyArray<string>
    ): number {
        const targetIds = new Set(localIds)
        if (targetIds.size === 0) return 0
        return this.db.transaction(() => {
            const rows = this.db.prepare(`
                SELECT delivery_seq, local_ids_json
                FROM session_native_deliveries
                WHERE session_id = ? AND native_id = ?
            `).all(sessionId, nativeId) as Array<{ delivery_seq: number; local_ids_json: string }>
            const deleteStmt = this.db.prepare(
                'DELETE FROM session_native_deliveries WHERE session_id = ? AND native_id = ? AND delivery_seq = ?'
            )
            let deleted = 0
            for (const row of rows) {
                const parsed = parseLocalIdsJson(row.local_ids_json)
                if (parsed.some((id) => targetIds.has(id))) {
                    deleted += deleteStmt.run(sessionId, nativeId, row.delivery_seq).changes
                }
            }
            return deleted
        })()
    }

    transferSession(fromSessionId: string, toSessionId: string): number {
        if (fromSessionId === toSessionId) return 0
        return this.db.transaction(() => {
            let movedSteps = 0
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
            if (sourceRows.length > 0) {
                const maxStmt = this.db.prepare(
                    'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM session_native_steps WHERE session_id = ? AND native_id = ?'
                )
                const insertStmt = this.db.prepare(`
                    INSERT OR IGNORE INTO session_native_steps
                        (session_id, native_id, anchor, fingerprint, message_id, seq, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `)
                const nextSeqByNative = new Map<string, number>()
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
                        movedSteps += 1
                    }
                    nextSeqByNative.set(row.native_id, nextSeq)
                }
                this.db.prepare('DELETE FROM session_native_steps WHERE session_id = ?').run(fromSessionId)
            }

            const pendingRows = this.db.prepare(`
                SELECT native_id, kind, message_id, local_ids_json, created_at
                FROM session_native_deliveries
                WHERE session_id = ?
                ORDER BY native_id ASC, delivery_seq ASC
            `).all(fromSessionId) as Array<{
                native_id: string
                kind: 'user' | 'agent'
                message_id: string
                local_ids_json: string
                created_at: number
            }>
            if (pendingRows.length > 0) {
                const maxPendingStmt = this.db.prepare(
                    'SELECT COALESCE(MAX(delivery_seq), 0) AS max_seq FROM session_native_deliveries WHERE session_id = ? AND native_id = ?'
                )
                const insertPendingStmt = this.db.prepare(`
                    INSERT OR IGNORE INTO session_native_deliveries
                        (session_id, native_id, delivery_seq, kind, message_id, local_ids_json, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `)
                const nextPendingSeqByNative = new Map<string, number>()
                for (const row of pendingRows) {
                    let nextSeq = nextPendingSeqByNative.get(row.native_id)
                    if (nextSeq === undefined) {
                        const maxRow = maxPendingStmt.get(toSessionId, row.native_id) as { max_seq: number } | null
                        nextSeq = (maxRow?.max_seq ?? 0) + 1
                    }
                    const res = insertPendingStmt.run(
                        toSessionId,
                        row.native_id,
                        nextSeq,
                        row.kind,
                        row.message_id,
                        row.local_ids_json,
                        row.created_at
                    )
                    if (res.changes > 0) {
                        nextSeq += 1
                    }
                    nextPendingSeqByNative.set(row.native_id, nextSeq)
                }
                this.db.prepare('DELETE FROM session_native_deliveries WHERE session_id = ?').run(fromSessionId)
            }

            return movedSteps
        })()
    }
}
