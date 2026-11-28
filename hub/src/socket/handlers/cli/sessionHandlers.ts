import type { ClientToServerEvents } from '@hapi/protocol'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AGENT_MESSAGE_PAYLOAD_TYPE, type CopilotAgentMode } from '@hapi/protocol'
import type { AgentState, BackgroundTask, CodexCollaborationMode, Metadata, PermissionMode } from '@hapi/protocol/types'
import { getToolCallId, isRedundantGoalStatusEventContent, unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import type { Store, StoredMessage, StoredSession } from '../../../store'
import { truncateOversizedMessageContent } from '../../../store/contentCodec'
import type { SyncEvent } from '../../../sync/syncEngine'
import { extractTodoWriteTodosFromMessageContent } from '../../../sync/todos'
import { extractTeamStateFromMessageContent, applyTeamStateDelta } from '../../../sync/teams'
import { extractBackgroundTasks } from '../../../sync/backgroundTasks'
import { shouldRecordSessionActivity } from '../../../sync/sessionActivity'
import { computeLocalTranscriptFingerprint } from '../../../web/routes/localSessions/matchAnchored'
import {
    collectEffectivePendingDeliveries,
    isCompatibleNativeUpdate,
    isPlainRecord,
    mergeNativeReconcileContentPreservingCallId,
    serializePendingDeliveriesForCli,
    storedHapiMessagesMatchNativeContent,
    unwrapAgentPayload
} from '../../../web/routes/localSessions/reconcileNativeDeliveries'
import type { CliSocketWithData } from '../../socketTypes'
import type { SessionEndReason } from '@hapi/protocol'
import type { AccessErrorReason, AccessResult } from './types'
import { getConfiguration } from '../../../configuration'
import { stripExternalRefsWhenAwarenessDisabled, externalRefsInMetadataValid } from '../../../sync/externalRefsPolicy'
import { cliMetadataWaitingValid } from '../../../sync/waitingMetadataPolicy'

export { cliMetadataWaitingValid }

function gateExternalRefs(metadata: unknown): unknown {
    let awarenessEnabled = false
    try {
        awarenessEnabled = getConfiguration().githubPrAwareness
    } catch {
        awarenessEnabled = false
    }
    return stripExternalRefsWhenAwarenessDisabled(metadata, awarenessEnabled)
}

type SessionAlivePayload = {
    sid: string
    time: number
    thinking?: boolean
    mode?: 'local' | 'remote'
    permissionMode?: PermissionMode
    model?: string | null
    modelReasoningEffort?: string | null
    effort?: string | null
    serviceTier?: string | null
    collaborationMode?: CodexCollaborationMode
    copilotAgentMode?: CopilotAgentMode
}

type SessionEndPayload = {
    sid: string
    time: number
    reason?: SessionEndReason
}

type SessionReadyPayload = {
    sid: string
    time: number
}

type ResolveSessionAccess = (sessionId: string, opts?: { fresh?: boolean }) => AccessResult<StoredSession>

type EmitAccessError = (scope: 'session' | 'machine', id: string, reason: AccessErrorReason) => void

type UpdateMetadataHandler = ClientToServerEvents['update-metadata']
type UpdateStateHandler = ClientToServerEvents['update-state']

const messageSchema = z.object({
    sid: z.string(),
    message: z.union([z.string(), z.unknown()]),
    localId: z.string().optional(),
    // Client-provided origin timestamp (epoch ms) — e.g. a Claude transcript
    // entry's own `timestamp`. Only honored for agent messages (no localId);
    // see addMessage in messages.ts.
    createdAt: z.number().optional()
})

const updateMetadataSchema = z.object({
    sid: z.string(),
    expectedVersion: z.number().int(),
    metadata: z.unknown()
})

const updateStateSchema = z.object({
    sid: z.string(),
    expectedVersion: z.number().int(),
    agentState: z.unknown().nullable()
})

const commitNativeStepsSchema = z.object({
    sid: z.string().min(1),
    nativeId: z.string().min(1),
    expectedOffset: z.number().int().min(0),
    entries: z.array(z.discriminatedUnion('kind', [
        z.object({
            kind: z.literal('link'),
            anchor: z.string().min(1).max(256),
            fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
            targetLocalIds: z.array(z.string().min(1)).min(1).max(100),
            content: z.unknown(),
            createdAt: z.number()
        }),
        z.object({
            kind: z.literal('reconcile_update'),
            anchor: z.string().min(1).max(256),
            fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
            targetLocalId: z.string().min(1),
            localId: z.string().min(1),
            content: z.unknown(),
            createdAt: z.number()
        }),
        z.object({
            kind: z.literal('backfill'),
            anchor: z.string().min(1).max(256),
            fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
            localId: z.string().min(1),
            content: z.unknown(),
            createdAt: z.number()
        })
    ])).max(100)
})

const discardNativeDeliverySchema = z.object({
    sid: z.string().min(1),
    nativeId: z.string().min(1),
    localIds: z.array(z.string().min(1)).min(1).max(100)
})

class NativeCommitError extends Error {
    constructor(readonly reason: 'offset_mismatch' | 'missing_target' | 'content_mismatch' | 'invalid') {
        super(reason)
        this.name = 'NativeCommitError'
    }
}

export const MAX_RECONCILE_NATIVE_STEPS_PER_REQUEST = 10_000
const MAX_PENDING_NATIVE_RECONCILES = 16

type PendingNativeReconcileCursor = {
    totalSteps: number
    validatedCount: number
    legacyMode: boolean
    recordedCount: number
    lastRecordedStepSeq: number
    importedCount: number
    storedMessageCount: number
    lastStoredSeq: number
    hasEffectivePending: boolean
    trailingUserFingerprints: Set<string>
}

function computeTrailingInvokedUserFingerprints(
    storedMessages: ReadonlyArray<StoredMessage>,
    lastRecordedSeq: number
): Set<string> {
    const fingerprints = new Set<string>()
    for (const msg of storedMessages) {
        if (msg.seq <= lastRecordedSeq || msg.invokedAt === null) continue
        const record = unwrapRoleWrappedRecordEnvelope(msg.content)
        if (!record || record.role !== 'user' || !isPlainRecord(record.content) || record.content.type !== 'text') {
            continue
        }
        const rawText = typeof record.content.text === 'string' ? record.content.text : ''
        if (!rawText) continue
        fingerprints.add(computeLocalTranscriptFingerprint({
            role: 'user',
            content: { type: 'text', text: rawText },
            meta: { sentFrom: 'cli' }
        }))
        fingerprints.add(computeLocalTranscriptFingerprint({
            role: 'user',
            content: { type: 'text', text: rawText.trim() },
            meta: { sentFrom: 'cli' }
        }))
    }
    return fingerprints
}

const reconcileNativeStepsSchema = z.object({
    sid: z.string().min(1),
    nativeId: z.string().min(1),
    offset: z.number().int().min(0).optional(),
    totalSteps: z.number().int().min(0).optional(),
    steps: z.array(z.object({
        anchor: z.string().min(1).max(256),
        fingerprint: z.string().regex(/^[0-9a-f]{64}$/)
    })).max(MAX_RECONCILE_NATIVE_STEPS_PER_REQUEST)
})

const backfillNativeMessagesSchema = z.object({
    sid: z.string().min(1),
    nativeId: z.string().min(1),
    expectedOffset: z.number().int().min(0),
    messages: z.array(z.object({
        localId: z.string().min(1),
        anchor: z.string().min(1).max(256),
        createdAt: z.number(),
        content: z.unknown()
    })).max(100)
})

// Hub-only merge/clear/title links. CLI update-metadata must not forge or erase them
// (same strip/restore as supersededBySessionId — see sessionHandlers.test.ts).
const HUB_OWNED_METADATA_KEYS = [
    'agyImportedAt',
    'codexImportedAt',
    'opencodeRewind',
    'supersededBySessionId',
    'opencodeClearOperation',
    'opencodeForkPending',
    'titleSuggestionAutoAttemptedAt',
    'titleSuggestionTurn',
    'jobsAcceptedFromSessionIds',
    'jobsTransferredToSessionId',
    'jobKeyRedirects',
    'promptTitle',
    'translateInput'
] as const

function preserveHubOwnedMetadata(incoming: unknown, current: unknown): unknown {
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming
    const next = { ...(incoming as Record<string, unknown>) }
    const existing = current && typeof current === 'object' && !Array.isArray(current)
        ? current as Record<string, unknown>
        : {}
    for (const key of HUB_OWNED_METADATA_KEYS) {
        if (Object.prototype.hasOwnProperty.call(existing, key)) next[key] = existing[key]
        else delete next[key]
    }
    const rewind = existing.opencodeRewind as { phase?: string } | undefined
    if (rewind && ['reserved', 'prepared', 'unknown'].includes(rewind.phase ?? '')) {
        for (const key of ['opencodeHistoryCheckpoint', 'conversationHistoryIndexes', 'conversationHistoryPoints']) next[key] = existing[key]
    }
    return next
}

export type SessionHandlersDeps = {
    store: Store
    resolveSessionAccess: ResolveSessionAccess
    emitAccessError: EmitAccessError
    onSessionAlive?: (payload: SessionAlivePayload) => void
    onSessionReady?: (payload: SessionReadyPayload) => void
    onSessionEnd?: (payload: SessionEndPayload) => void
    onWebappEvent?: (event: SyncEvent) => void
    onBackgroundTasks?: (sessionId: string, tasks: BackgroundTask[]) => void
    onSessionActivity?: (sessionId: string, updatedAt: number) => void
    /** tiann/hapi#1820: any message is agent progress, either direction. */
    onAgentProgress?: (sessionId: string, at: number) => void
    /** Delegates session-end immediate-queue sweep to the MessageService layer. */
    onSweepImmediateQueued?: (sessionId: string, now: number) => void
    /** Drops the queued-thinking grace so synchronous CLI handlers (e.g. slash
     *  commands) don't leave the spinner stuck for the full grace window. */
    onMessagesConsumed?: (sessionId: string) => void
}

export function registerSessionHandlers(socket: CliSocketWithData, deps: SessionHandlersDeps): void {
    const { store, resolveSessionAccess, emitAccessError, onSessionAlive, onSessionReady, onSessionEnd, onWebappEvent, onBackgroundTasks, onSessionActivity, onAgentProgress, onSweepImmediateQueued, onMessagesConsumed } = deps
    const pendingNativeReconciles = new Map<string, PendingNativeReconcileCursor>()
    socket.on('disconnect', () => {
        pendingNativeReconciles.clear()
    })

    socket.on('native-queue-message', data => {
        const parsed = z.object({ sid: z.string(), localId: z.string().min(1), text: z.string().nullable() }).safeParse(data)
        if (!parsed.success) return
        const { sid, localId, text } = parsed.data
        // Fresh resolve: the capabilities gate below decides whether the
        // queue ledger is written, and capabilities can change via metadata
        // writes (e.g. a merge copying capabilities onto this session) — a
        // memo snapshot could silently drop or wrongly accept the entry.
        // Queued input is human-paced, not a stream hot path.
        const access = resolveSessionAccess(sid, { fresh: true })
        if (!access.ok) { emitAccessError('session', sid, access.reason); return }
        const metadata = access.value.metadata as Metadata | null
        if (!metadata?.capabilities?.concurrentClients) return
        if (text === null) {
            const prior = store.messages.lookupQueuedMessage(sid, localId)
            if ('resolvedId' in prior && store.messages.deleteQueuedMessageById(sid, localId)) {
                onWebappEvent?.({ type: 'message-cancelled', sessionId: sid, messageId: prior.resolvedId, localId })
            }
        } else {
            const message = store.messages.syncNativeQueuedMessage(sid, localId, text)
            onWebappEvent?.({ type: 'message-received', sessionId: sid, message })
        }
    })

    socket.on('message', (data: unknown) => {
        const parsed = messageSchema.safeParse(data)
        if (!parsed.success) {
            return
        }

        const { sid, localId, createdAt } = parsed.data
        const raw = parsed.data.message

        const content = typeof raw === 'string'
            ? (() => {
                try {
                    return JSON.parse(raw) as unknown
                } catch {
                    return raw
                }
            })()
            : raw

        const sessionAccess = resolveSessionAccess(sid)
        if (!sessionAccess.ok) {
            emitAccessError('session', sid, sessionAccess.reason)
            return
        }
        const session = sessionAccess.value

        if (isRedundantGoalStatusEventContent(content)) {
            return
        }

        // A background-task snapshot is session state, not chat: apply it
        // without storing a hidden row.
        const backgroundTasks = extractBackgroundTasks(content)
        if (backgroundTasks !== null) {
            onBackgroundTasks?.(sid, backgroundTasks)
            return
        }

        const wasStored = Boolean(localId && store.messages.lookupQueuedMessage(sid, localId).status !== 'absent')
        // ACP agents re-emit one tool call under a stable callId for every
        // state tick. When that callId is still live in the session tail, fold
        // the tick into the call's existing row instead of appending another
        // one, and broadcast the merged row under its original id/seq so
        // clients upsert it in place. Peer CLIs in the session room dedupe
        // that re-emit by message id, harmlessly: only user rows reach a
        // consumer there (onUserMessage), agent rows do not.
        const callId = getToolCallId(content)
        const stored = callId !== null && !wasStored
            ? store.messages.upsertToolCallMessage(sid, content, callId, localId, createdAt)
            : store.messages.addMessageSweepingLiveSnapshots(sid, content, localId, undefined, createdAt)
        const msg = stored.message
        // A merged row keeps its first snapshot's createdAt for stable
        // ordering, but derived todo/team versions must strictly advance
        // (setSessionTodos/setSessionTeamState gate on *_updated_at < candidate),
        // so stamp them at merge time instead.
        const derivedAt = stored.updated ? Math.max(Date.now(), msg.createdAt + 1) : msg.createdAt
        // A merged row keeps its first snapshot's createdAt for stable
        // ordering, but each repeated tick must still advance the
        // keepalive-idle clock: feeding onAgentProgress the frozen
        // first-snapshot timestamp lets an ACP call with thinking=false and
        // no background task be marked idle despite fresh updates.
        const progressAt = stored.updated ? Date.now() : msg.createdAt
        // The durable row already exists; replay must not be mistaken for
        // fresh agent progress or trigger another round of UI updates.
        if (wasStored) return

        if (!stored.updated && localId?.startsWith('agy-live:')) {
            const sessionMeta = session.metadata as { agyImportedAt?: unknown; agySessionId?: unknown } | null
            if (
                sessionMeta?.agyImportedAt != null
                && typeof sessionMeta.agySessionId === 'string'
                && sessionMeta.agySessionId.length > 0
            ) {
                store.nativeSteps.recordPendingDelivery(
                    sid,
                    sessionMeta.agySessionId,
                    { kind: 'agent', messageId: msg.id, localIds: [localId] },
                    msg.createdAt
                )
            }
        }

        // A reasoning stream arrives as a series of growing snapshots under one
        // stable id, so a stream should cost one row rather than one per
        // interval. The addMessageSweepingLiveSnapshots call above already
        // retired the earlier live snapshots of the incoming message's own
        // reasoning/text streams in the same transaction (INSERT first, then
        // DELETE — a crash rolls back both, so the stream never loses its
        // newest row). Tool-call content never carries a stream id, so the
        // upsert branch needs no sweep. Only rows marked live are eligible;
        // the settled message that closes a stream survives and also sweeps
        // up its own leftovers.

        // tiann/hapi#1820: every stored message proves the agent is doing
        // something, so it refreshes the keepalive-idle clock. Only human
        // turns additionally bump `updatedAt` (list ordering).
        onAgentProgress?.(sid, progressAt)

        if (shouldRecordSessionActivity(content)) {
            onSessionActivity?.(sid, msg.createdAt)
        }

        const todos = extractTodoWriteTodosFromMessageContent(content)
        if (todos) {
            const updated = store.sessions.setSessionTodos(sid, todos, derivedAt, session.namespace)
            if (updated) {
                const stored = store.sessions.getSession(sid)
                onWebappEvent?.({
                    type: 'session-updated',
                    sessionId: sid,
                    data: {
                        todos: {
                            version: stored?.todosUpdatedAt ?? msg.createdAt,
                            value: todos
                        },
                        updatedAt: stored?.updatedAt ?? msg.createdAt
                    }
                })
            }
        }

        const teamDelta = extractTeamStateFromMessageContent(content)
        if (teamDelta) {
            const existingSession = store.sessions.getSession(sid)
            const existingTeamState = existingSession?.teamState as import('@hapi/protocol/types').TeamState | null | undefined
            const newTeamState = applyTeamStateDelta(existingTeamState ?? null, teamDelta)
            const updated = store.sessions.setSessionTeamState(sid, newTeamState, derivedAt, session.namespace)
            if (updated) {
                const stored = store.sessions.getSession(sid)
                // Versioned clear: value null = TeamDelete. Consumers gate on
                // version (store team_state_updated_at) so dual SSE cannot
                // resurrect a deleted team from a lagged older event.
                onWebappEvent?.({
                    type: 'session-updated',
                    sessionId: sid,
                    data: {
                        teamState: {
                            version: stored?.teamStateUpdatedAt ?? msg.createdAt,
                            value: newTeamState
                        },
                        updatedAt: stored?.updatedAt ?? msg.createdAt
                    }
                })
            }
        }

        const update = {
            id: randomUUID(),
            seq: msg.seq,
            createdAt: Date.now(),
            body: {
                t: 'new-message' as const,
                sid,
                message: {
                    id: msg.id,
                    seq: msg.seq,
                    createdAt: msg.createdAt,
                    localId: msg.localId,
                    content: msg.content
                }
            }
        }
        socket.to(`session:${sid}`).emit('update', update)

        onWebappEvent?.({
            type: 'message-received',
            sessionId: sid,
            message: {
                id: msg.id,
                seq: msg.seq,
                localId: msg.localId,
                content: msg.content,
                createdAt: msg.createdAt,
                invokedAt: msg.invokedAt,
                ...(msg.contentRevision ? { contentRevision: msg.contentRevision } : {})
            }
        })
    })

    const handleUpdateMetadata: UpdateMetadataHandler = (data, cb) => {
        const parsed = updateMetadataSchema.safeParse(data)
        if (!parsed.success) {
            cb({ result: 'error' })
            return
        }

        const { sid, metadata, expectedVersion } = parsed.data
        // Fresh resolve: preserveHubOwnedMetadata below merges against
        // sessionAccess.value.metadata, so the base must be the live row.
        // A memo-stale base would drop a concurrently-set hub-owned key or
        // resurrect a concurrently-cleared one in this very write.
        const sessionAccess = resolveSessionAccess(sid, { fresh: true })
        if (!sessionAccess.ok) {
            cb({ result: 'error', reason: sessionAccess.reason })
            return
        }

        const gatedMetadata = gateExternalRefs(metadata)
        if (!externalRefsInMetadataValid(gatedMetadata)) {
            cb({ result: 'error' })
            return
        }
        if (!cliMetadataWaitingValid(gatedMetadata)) {
            cb({ result: 'error' })
            return
        }

        const result = store.sessions.updateSessionMetadata(
            sid,
            preserveHubOwnedMetadata(gatedMetadata, sessionAccess.value.metadata),
            expectedVersion,
            sessionAccess.value.namespace
        )
        if (result.result === 'success') {
            cb({ result: 'success', version: result.version, metadata: result.value })
        } else if (result.result === 'version-mismatch') {
            cb({ result: 'version-mismatch', version: result.version, metadata: result.value })
        } else {
            cb({ result: 'error' })
        }

        if (result.result === 'success') {
            const stored = store.sessions.getSession(sid)
            const update = {
                id: randomUUID(),
                seq: Date.now(),
                createdAt: Date.now(),
                body: {
                    t: 'update-session' as const,
                    sid,
                    // Broadcast the persisted (merged) value, not the pre-merge
                    // payload — otherwise other CLIs in the session room would
                    // overwrite their local cache with a tokenless metadata
                    // snapshot even though the DB row was preserved.
                    // See store.sessions.mergeSessionMetadata for the merge
                    // contract.
                    metadata: { version: result.version, value: result.value },
                    agentState: null
                }
            }
            socket.to(`session:${sid}`).emit('update', update)
            onWebappEvent?.({
                type: 'session-updated',
                sessionId: sid,
                // The unknown-cast here mirrors the schema's MetadataSchema.nullable()
                // shape: the store returns raw JSON, the wire schema parses it on
                // both ends. Keeping the broadcast shape identical to the socket.io
                // `update-session` body (line ~213) lets the same patch travel
                // through both fan-out channels without divergence.
                data: {
                    metadata: { version: result.version, value: result.value as Metadata | null },
                    updatedAt: stored?.updatedAt ?? Date.now()
                }
            })
        }
    }

    socket.on('update-metadata', handleUpdateMetadata)

    const handleUpdateState: UpdateStateHandler = (data, cb) => {
        const parsed = updateStateSchema.safeParse(data)
        if (!parsed.success) {
            cb({ result: 'error' })
            return
        }

        const { sid, agentState, expectedVersion } = parsed.data
        const sessionAccess = resolveSessionAccess(sid)
        if (!sessionAccess.ok) {
            cb({ result: 'error', reason: sessionAccess.reason })
            return
        }

        const result = store.sessions.updateSessionAgentState(
            sid,
            agentState,
            expectedVersion,
            sessionAccess.value.namespace
        )
        if (result.result === 'success') {
            cb({ result: 'success', version: result.version, agentState: result.value })
        } else if (result.result === 'version-mismatch') {
            cb({ result: 'version-mismatch', version: result.version, agentState: result.value })
        } else {
            cb({ result: 'error' })
        }

        if (result.result === 'success') {
            const stored = store.sessions.getSession(sid)
            const update = {
                id: randomUUID(),
                seq: Date.now(),
                createdAt: Date.now(),
                body: {
                    t: 'update-session' as const,
                    sid,
                    metadata: null,
                    agentState: { version: result.version, value: agentState }
                }
            }
            socket.to(`session:${sid}`).emit('update', update)
            onWebappEvent?.({
                type: 'session-updated',
                sessionId: sid,
                data: {
                    agentState: { version: result.version, value: agentState as AgentState | null },
                    updatedAt: stored?.updatedAt ?? Date.now()
                }
            })
        }
    }

    socket.on('update-state', handleUpdateState)

    socket.on('session-alive', (data: SessionAlivePayload) => {
        if (!data || typeof data.sid !== 'string' || typeof data.time !== 'number') {
            return
        }
        const sessionAccess = resolveSessionAccess(data.sid)
        if (!sessionAccess.ok) {
            emitAccessError('session', data.sid, sessionAccess.reason)
            return
        }
        onSessionAlive?.(data)
    })

    socket.on('session-ready', (data: SessionReadyPayload) => {
        if (!data || typeof data.sid !== 'string' || typeof data.time !== 'number') {
            return
        }
        const sessionAccess = resolveSessionAccess(data.sid)
        if (!sessionAccess.ok) {
            emitAccessError('session', data.sid, sessionAccess.reason)
            return
        }
        onSessionReady?.(data)
    })

    socket.on('messages-consumed', (data: { sid: string; localIds: string[]; clearQueuedThinkingGrace?: boolean; steered?: boolean; nativeId?: string }) => {
        if (!data || typeof data.sid !== 'string' || !Array.isArray(data.localIds)) {
            return
        }
        const localIds = data.localIds.filter((id): id is string => typeof id === 'string')
        if (localIds.length === 0) {
            return
        }
        const sessionAccess = resolveSessionAccess(data.sid)
        if (!sessionAccess.ok) {
            emitAccessError('session', data.sid, sessionAccess.reason)
            return
        }
        const invokedAt = Date.now()
        let sessionUpdatedAt: number
        try {
            const nativeId = typeof data.nativeId === 'string' && data.nativeId.length > 0 ? data.nativeId : null
            sessionUpdatedAt = store.runInTransaction(() => {
                let pendingUserDelivery: { messageId: string; localIds: string[]; moveToTail: boolean } | null = null
                if (nativeId) {
                    const freshAccess = resolveSessionAccess(data.sid, { fresh: true })
                    const metadata = freshAccess.ok
                        ? (freshAccess.value.metadata as { agyImportedAt?: unknown; agySessionId?: unknown } | null)
                        : null
                    if (metadata?.agyImportedAt != null && metadata.agySessionId === nativeId) {
                        const idSet = new Set(localIds)
                        const matchedRows = store.messages.getAllMessages(data.sid)
                            .filter((m) => m.localId && idSet.has(m.localId))
                            .sort((a, b) => a.seq - b.seq)
                        if (matchedRows.length > 0) {
                            const anchorRow = matchedRows[matchedRows.length - 1]!
                            pendingUserDelivery = {
                                messageId: anchorRow.id,
                                localIds: matchedRows.map((row) => row.localId!),
                                moveToTail: matchedRows.some((row) => row.invokedAt === null)
                            }
                        }
                    }
                }
                const updatedAt = store.recordMessagesConsumed(
                    data.sid,
                    localIds,
                    invokedAt,
                    sessionAccess.value.namespace
                )
                if (nativeId && pendingUserDelivery) {
                    store.nativeSteps.recordPendingDelivery(
                        data.sid,
                        nativeId,
                        { kind: 'user', messageId: pendingUserDelivery.messageId, localIds: pendingUserDelivery.localIds },
                        invokedAt,
                        { moveToTail: pendingUserDelivery.moveToTail }
                    )
                }
                return updatedAt
            })
        } catch (err) {
            console.error('recordMessagesConsumed failed', err)
            return
        }

        try {
            onSessionActivity?.(data.sid, sessionUpdatedAt)
        } catch (err) {
            console.error('onSessionActivity failed', err)
        }

        // Only drop the queued-thinking grace when the CLI explicitly opts in
        // (synchronous handlers like slash commands that will never send
        // their own `thinking=true` keepalive). Normal queue drains still
        // need the grace so the spinner doesn't flicker between the queue
        // shift and `backend.prompt` start.
        if (data.clearQueuedThinkingGrace === true) {
            onMessagesConsumed?.(data.sid)
        }
        // Emit only after the DB transaction succeeds. This is an ACK-level
        // batch contract, so preserve its original timestamp even when IDs are
        // heterogeneous, replayed, or unknown. `steered` is a live-only signal
        // (never persisted) that marks mid-turn delivery for the web badge.
        onWebappEvent?.({ type: 'messages-consumed', sessionId: data.sid, localIds, invokedAt, ...(data.steered === true ? { steered: true } : {}) })
    })

    socket.on('messages-indeterminate', (data: { sid: string; localIds: string[] }) => {
        if (!data || typeof data.sid !== 'string' || !Array.isArray(data.localIds)) {
            return
        }
        const localIds = data.localIds.filter((id): id is string => typeof id === 'string')
        if (localIds.length === 0) return
        const sessionAccess = resolveSessionAccess(data.sid)
        if (!sessionAccess.ok) {
            emitAccessError('session', data.sid, sessionAccess.reason)
            return
        }
        try {
            store.recordMessagesIndeterminate(data.sid, localIds, sessionAccess.value.namespace)
        } catch (err) {
            console.error('recordMessagesIndeterminate failed', err)
            return
        }
        onWebappEvent?.({ type: 'messages-indeterminate', sessionId: data.sid, localIds })
    })

    socket.on('messages-steer-state', (
        data: { sid: string; localIds: string[]; state: 'queued' | 'dispatching'; nativeId?: string },
        ack?: (response: { ok: boolean }) => void
    ) => {
        const reply = typeof ack === 'function' ? ack : () => {}
        if (!data || typeof data.sid !== 'string' || !Array.isArray(data.localIds)
            || (data.state !== 'queued' && data.state !== 'dispatching')) {
            reply({ ok: false })
            return
        }
        const localIds = data.localIds.filter((id): id is string => typeof id === 'string')
        if (localIds.length === 0) {
            reply({ ok: false })
            return
        }
        const sessionAccess = resolveSessionAccess(data.sid)
        if (!sessionAccess.ok) {
            emitAccessError('session', data.sid, sessionAccess.reason)
            reply({ ok: false })
            return
        }
        try {
            const nativeId = typeof data.nativeId === 'string' && data.nativeId.length > 0 ? data.nativeId : null
            const ok = store.runInTransaction(() => {
                const transitioned = store.recordSteerDeliveryState(
                    data.sid,
                    localIds,
                    data.state,
                    sessionAccess.value.namespace
                )
                if (!transitioned || !nativeId) {
                    return transitioned
                }
                const freshAccess = resolveSessionAccess(data.sid, { fresh: true })
                const metadata = freshAccess.ok
                    ? (freshAccess.value.metadata as { agyImportedAt?: unknown; agySessionId?: unknown } | null)
                    : null
                if (metadata?.agyImportedAt != null && metadata.agySessionId === nativeId) {
                    if (data.state === 'dispatching') {
                        const idSet = new Set(localIds)
                        const matchedRows = store.messages.getAllMessages(data.sid)
                            .filter((m) => m.localId && idSet.has(m.localId))
                            .sort((a, b) => a.seq - b.seq)
                        if (matchedRows.length > 0) {
                            const anchorRow = matchedRows[matchedRows.length - 1]!
                            store.nativeSteps.recordPendingDelivery(
                                data.sid,
                                nativeId,
                                { kind: 'user', messageId: anchorRow.id, localIds: matchedRows.map((row) => row.localId!) },
                                Date.now()
                            )
                        }
                    } else {
                        store.nativeSteps.removePendingDeliveriesByLocalIds(data.sid, nativeId, localIds)
                    }
                }
                return true
            })
            reply({ ok })
            if (ok) {
                onWebappEvent?.(data.state === 'queued'
                    ? { type: 'messages-requeued', sessionId: data.sid, localIds }
                    : { type: 'messages-indeterminate', sessionId: data.sid, localIds, dispatching: true })
            }
        } catch (err) {
            console.error('recordSteerDeliveryState failed', err)
            reply({ ok: false })
        }
    })

    const broadcastMessageUpdate = (sid: string, msg: StoredMessage) => {
        const update = {
            id: randomUUID(),
            seq: msg.seq,
            createdAt: Date.now(),
            body: {
                t: 'new-message' as const,
                sid,
                message: {
                    id: msg.id,
                    seq: msg.seq,
                    createdAt: msg.createdAt,
                    localId: msg.localId,
                    content: msg.content
                }
            }
        }
        socket.to(`session:${sid}`).emit('update', update)
        onWebappEvent?.({
            type: 'message-received',
            sessionId: sid,
            message: {
                id: msg.id,
                seq: msg.seq,
                localId: msg.localId,
                content: msg.content,
                createdAt: msg.createdAt,
                invokedAt: msg.invokedAt,
                ...(msg.contentRevision ? { contentRevision: msg.contentRevision } : {})
            }
        })
    }

    socket.on('session-discard-native-delivery', (data: unknown) => {
        const parsed = discardNativeDeliverySchema.safeParse(data)
        if (!parsed.success) return
        const sessionAccess = resolveSessionAccess(parsed.data.sid, { fresh: true })
        if (!sessionAccess.ok) {
            emitAccessError('session', parsed.data.sid, sessionAccess.reason)
            return
        }
        const metadata = sessionAccess.value.metadata as { agyImportedAt?: unknown; agySessionId?: unknown } | null
        if (metadata?.agyImportedAt == null || metadata.agySessionId !== parsed.data.nativeId) {
            return
        }
        store.nativeSteps.removePendingDeliveriesByLocalIds(
            parsed.data.sid,
            parsed.data.nativeId,
            parsed.data.localIds
        )
    })

    socket.on('session-commit-native-steps', (
        data: unknown,
        ack?: (
            response:
                | { ok: true; confirmedCount: number; inserted: number; updated: number }
                | { ok: false; reason?: 'offset_mismatch' | 'missing_target' | 'content_mismatch' | 'invalid' }
        ) => void
    ) => {
        const reply = typeof ack === 'function' ? ack : () => {}
        const parsed = commitNativeStepsSchema.safeParse(data)
        if (!parsed.success) {
            reply({ ok: false, reason: 'invalid' })
            return
        }
        const sessionAccess = resolveSessionAccess(parsed.data.sid, { fresh: true })
        if (!sessionAccess.ok) {
            emitAccessError('session', parsed.data.sid, sessionAccess.reason)
            reply({ ok: false })
            return
        }
        const metadata = sessionAccess.value.metadata as { agyImportedAt?: unknown; agySessionId?: unknown } | null
        if (metadata?.agyImportedAt == null || metadata.agySessionId !== parsed.data.nativeId) {
            reply({ ok: false })
            return
        }

        const appended: StoredMessage[] = []
        const updatedMessages: StoredMessage[] = []
        try {
            const { sid, nativeId, expectedOffset, entries } = parsed.data
            const result = store.runInTransaction(() => {
                const currentSteps = store.nativeSteps.getSteps(sid, nativeId)
                if (expectedOffset > currentSteps.length) {
                    throw new NativeCommitError('offset_mismatch')
                }
                const overlap = Math.min(entries.length, currentSteps.length - expectedOffset)
                const allMessages = store.messages.getAllMessages(sid)
                const byLocalId = new Map<string, StoredMessage>()
                for (const msg of allMessages) {
                    if (msg.localId) {
                        byLocalId.set(msg.localId, msg)
                    }
                }
                const committedMessageIds: string[] = []
                for (let i = 0; i < overlap; i += 1) {
                    const entry = entries[i]!
                    const recordedStep = currentSteps[expectedOffset + i]!
                    if (computeLocalTranscriptFingerprint(entry.content) !== entry.fingerprint) {
                        throw new NativeCommitError('invalid')
                    }
                    if (recordedStep.anchor !== entry.anchor || recordedStep.fingerprint !== entry.fingerprint) {
                        throw new NativeCommitError('offset_mismatch')
                    }
                    if (entry.kind === 'link') {
                        const targetRows: StoredMessage[] = []
                        const seenIds = new Set<string>()
                        for (const targetLocalId of entry.targetLocalIds) {
                            if (seenIds.has(targetLocalId)) {
                                throw new NativeCommitError('invalid')
                            }
                            seenIds.add(targetLocalId)
                            const found = byLocalId.get(targetLocalId)
                            if (!found) {
                                throw new NativeCommitError('offset_mismatch')
                            }
                            targetRows.push(found)
                        }
                        if (!storedHapiMessagesMatchNativeContent(targetRows, entry.content)) {
                            throw new NativeCommitError('offset_mismatch')
                        }
                        const anchorRow = targetRows.reduce((latest, row) => (row.seq > latest.seq ? row : latest), targetRows[0]!)
                        if (recordedStep.messageId !== anchorRow.id) {
                            throw new NativeCommitError('offset_mismatch')
                        }
                        committedMessageIds.push(anchorRow.id)
                        continue
                    }

                    if (entry.localId !== `agy:${nativeId}:${entry.anchor}`) {
                        throw new NativeCommitError('invalid')
                    }

                    if (entry.kind === 'reconcile_update') {
                        if (!entry.targetLocalId.startsWith('agy-live:') || unwrapAgentPayload(entry.content) === null) {
                            throw new NativeCommitError('invalid')
                        }
                        const existing = byLocalId.get(entry.targetLocalId) ?? byLocalId.get(entry.localId)
                        if (!existing || recordedStep.messageId !== existing.id) {
                            throw new NativeCommitError('offset_mismatch')
                        }
                        const expectedContent = mergeNativeReconcileContentPreservingCallId(existing.content, entry.content)
                        if (!isDeepStrictEqual(
                            truncateOversizedMessageContent(existing.content),
                            truncateOversizedMessageContent(expectedContent)
                        )) {
                            throw new NativeCommitError('offset_mismatch')
                        }
                        committedMessageIds.push(existing.id)
                        continue
                    }

                    const existing = byLocalId.get(entry.localId)
                    if (!existing || recordedStep.messageId !== existing.id) {
                        throw new NativeCommitError('offset_mismatch')
                    }
                }

                const ledgerSteps: Array<{ anchor: string; fingerprint: string; messageId: string }> = []
                const corroboratedLocalIdSet = new Set<string>()
                let insertedCount = 0
                let updatedCount = 0
                for (let i = overlap; i < entries.length; i += 1) {
                    const entry = entries[i]!
                    if (computeLocalTranscriptFingerprint(entry.content) !== entry.fingerprint) {
                        throw new NativeCommitError('invalid')
                    }
                    if (entry.kind === 'link') {
                        const targetRows: StoredMessage[] = []
                        const seenIds = new Set<string>()
                        for (const targetLocalId of entry.targetLocalIds) {
                            if (seenIds.has(targetLocalId)) {
                                throw new NativeCommitError('invalid')
                            }
                            seenIds.add(targetLocalId)
                            const found = byLocalId.get(targetLocalId)
                            if (!found) {
                                throw new NativeCommitError('missing_target')
                            }
                            targetRows.push(found)
                        }
                        if (!storedHapiMessagesMatchNativeContent(targetRows, entry.content)) {
                            throw new NativeCommitError('content_mismatch')
                        }
                        for (const row of targetRows) {
                            if (row.invokedAt === null && typeof row.localId === 'string') {
                                corroboratedLocalIdSet.add(row.localId)
                            }
                        }
                        const anchorRow = targetRows.reduce((latest, row) => (row.seq > latest.seq ? row : latest), targetRows[0]!)
                        committedMessageIds.push(anchorRow.id)
                        ledgerSteps.push({
                            anchor: entry.anchor,
                            fingerprint: entry.fingerprint,
                            messageId: anchorRow.id
                        })
                        continue
                    }

                    if (entry.localId !== `agy:${nativeId}:${entry.anchor}`) {
                        throw new NativeCommitError('invalid')
                    }

                    if (entry.kind === 'reconcile_update') {
                        if (!entry.targetLocalId.startsWith('agy-live:') || unwrapAgentPayload(entry.content) === null) {
                            throw new NativeCommitError('invalid')
                        }
                        const existing = byLocalId.get(entry.targetLocalId)
                        if (existing) {
                            if (!isCompatibleNativeUpdate(existing.content, entry.content)) {
                                throw new NativeCommitError('content_mismatch')
                            }
                            const nextContent = mergeNativeReconcileContentPreservingCallId(existing.content, entry.content)
                            const replaced = store.messages.replaceMessageContent(sid, existing.id, nextContent)
                            if (!replaced) {
                                throw new NativeCommitError('missing_target')
                            }
                            byLocalId.set(entry.targetLocalId, replaced)
                            updatedMessages.push(replaced)
                            updatedCount += 1
                            committedMessageIds.push(replaced.id)
                            ledgerSteps.push({
                                anchor: entry.anchor,
                                fingerprint: entry.fingerprint,
                                messageId: replaced.id
                            })
                        } else {
                            const added = store.messages.addImportedMessage(
                                sid,
                                entry.content,
                                entry.localId,
                                entry.createdAt
                            )
                            byLocalId.set(entry.localId, added.message)
                            if (added.inserted) {
                                appended.push(added.message)
                                insertedCount += 1
                            }
                            ledgerSteps.push({
                                anchor: entry.anchor,
                                fingerprint: entry.fingerprint,
                                messageId: added.message.id
                            })
                        }
                        continue
                    }

                    const added = store.messages.addImportedMessage(
                        sid,
                        entry.content,
                        entry.localId,
                        entry.createdAt
                    )
                    byLocalId.set(entry.localId, added.message)
                    if (added.inserted) {
                        appended.push(added.message)
                        insertedCount += 1
                    }
                    ledgerSteps.push({
                        anchor: entry.anchor,
                        fingerprint: entry.fingerprint,
                        messageId: added.message.id
                    })
                }
                const now = Date.now()
                const corroboratedLocalIds = [...corroboratedLocalIdSet]
                if (corroboratedLocalIds.length > 0) {
                    store.messages.markMessagesInvoked(sid, corroboratedLocalIds, now)
                }
                if (ledgerSteps.length > 0) {
                    const { inserted } = store.nativeSteps.recordSteps(sid, nativeId, ledgerSteps, now)
                    if (inserted !== ledgerSteps.length) {
                        throw new NativeCommitError('offset_mismatch')
                    }
                }
                if (committedMessageIds.length > 0) {
                    store.nativeSteps.removePendingDeliveriesByMessageIds(sid, nativeId, committedMessageIds)
                }
                return {
                    confirmedCount: store.nativeSteps.getSteps(sid, nativeId).length,
                    inserted: insertedCount,
                    updated: updatedCount,
                    corroboratedLocalIds,
                    invokedAt: now
                }
            })
            if (result.corroboratedLocalIds.length > 0) {
                onWebappEvent?.({
                    type: 'messages-consumed',
                    sessionId: sid,
                    localIds: result.corroboratedLocalIds,
                    invokedAt: result.invokedAt
                })
            }
            for (const msg of appended) {
                broadcastMessageUpdate(sid, msg)
            }
            for (const msg of updatedMessages) {
                broadcastMessageUpdate(sid, msg)
            }
            reply({
                ok: true,
                confirmedCount: result.confirmedCount,
                inserted: result.inserted,
                updated: result.updated
            })
        } catch (err) {
            if (err instanceof NativeCommitError) {
                reply({ ok: false, reason: err.reason })
                return
            }
            console.error('commitNativeSteps failed', err)
            reply({ ok: false })
        }
    })

    socket.on('session-reconcile-native-steps', (
        data: unknown,
        ack?: (
            response:
                | { ok: true; status: 'continue'; nextOffset: number; confirmedCount: number }
                | { ok: true; status: 'up_to_date'; confirmedCount: number; unresolvedLocalIds?: string[] }
                | { ok: true; status: 'pending_flush'; confirmedCount: number }
                | { ok: true; status: 'needs_backfill'; fromIndex: number }
                | {
                    ok: true
                    status: 'needs_reconcile'
                    fromIndex: number
                    pendingDeliveries: Array<
                        | { kind: 'user'; localIds: string[]; texts: string[]; uncertain?: boolean; awaitingResolution?: boolean }
                        | { kind: 'agent'; localId: string; data: Record<string, unknown> }
                    >
                }
                | { ok: true; status: 'diverged' }
                | { ok: false }
        ) => void
    ) => {
        const reply = typeof ack === 'function' ? ack : () => {}
        const parsed = reconcileNativeStepsSchema.safeParse(data)
        if (!parsed.success) {
            reply({ ok: false })
            return
        }
        const sessionAccess = resolveSessionAccess(parsed.data.sid, { fresh: true })
        if (!sessionAccess.ok) {
            emitAccessError('session', parsed.data.sid, sessionAccess.reason)
            reply({ ok: false })
            return
        }
        const metadata = sessionAccess.value.metadata as { agyImportedAt?: unknown; agySessionId?: unknown } | null
        if (metadata?.agyImportedAt == null || metadata.agySessionId !== parsed.data.nativeId) {
            reply({ ok: false })
            return
        }
        try {
            const { sid, nativeId, steps } = parsed.data
            const offset = parsed.data.offset ?? 0
            if (offset > 0 && parsed.data.totalSteps === undefined) {
                reply({ ok: false })
                return
            }
            const totalSteps = parsed.data.totalSteps ?? (offset + steps.length)
            const endOffset = offset + steps.length
            if (endOffset > totalSteps || (totalSteps > 0 && steps.length === 0)) {
                reply({ ok: false })
                return
            }

            const cursorKey = `${sid}\0${nativeId}`
            const recorded = store.nativeSteps.getSteps(sid, nativeId)
            const storedMessages = store.messages.getAllMessages(sid)
            const storedById = new Map(storedMessages.map((msg) => [msg.id, msg]))
            const importPrefix = `agy:${nativeId}:`
            const imported = storedMessages.filter((msg) => msg.localId?.startsWith(importPrefix))
            const lastRecordedStepSeq = recorded.length > 0 ? recorded[recorded.length - 1]!.seq : -1
            const lastStoredSeq = storedMessages.length > 0 ? storedMessages[storedMessages.length - 1]!.seq : -1

            let cursor: PendingNativeReconcileCursor
            if (offset === 0) {
                pendingNativeReconciles.delete(cursorKey)
                if (recorded.length > 0) {
                    if (totalSteps < recorded.length) {
                        reply({ ok: true, status: 'diverged' })
                        return
                    }
                    const stepIndexByAnchor = new Map<string, number>()
                    let lastRecordedSeq = -1
                    for (let i = 0; i < recorded.length; i += 1) {
                        const expected = recorded[i]!
                        const linked = storedById.get(expected.messageId)
                        if (!linked) {
                            reply({ ok: true, status: 'diverged' })
                            return
                        }
                        if (linked.seq > lastRecordedSeq) {
                            lastRecordedSeq = linked.seq
                        }
                        stepIndexByAnchor.set(expected.anchor, i)
                    }
                    let priorIndex = -1
                    for (const msg of imported) {
                        const expectedAnchor = msg.localId!.slice(importPrefix.length)
                        const sourceIndex = stepIndexByAnchor.get(expectedAnchor)
                        if (sourceIndex === undefined || sourceIndex <= priorIndex || sourceIndex >= recorded.length) {
                            reply({ ok: true, status: 'diverged' })
                            return
                        }
                        if (computeLocalTranscriptFingerprint(msg.content) !== recorded[sourceIndex]!.fingerprint) {
                            reply({ ok: true, status: 'diverged' })
                            return
                        }
                        priorIndex = sourceIndex
                    }
                    const hasEffectivePending = collectEffectivePendingDeliveries(
                        storedMessages,
                        recorded,
                        store.nativeSteps.getPendingDeliveries(sid, nativeId)
                    ).length > 0
                    const trailingUserFingerprints = !hasEffectivePending && totalSteps > recorded.length
                        ? computeTrailingInvokedUserFingerprints(storedMessages, lastRecordedSeq)
                        : new Set<string>()
                    cursor = {
                        totalSteps,
                        validatedCount: 0,
                        legacyMode: false,
                        recordedCount: recorded.length,
                        lastRecordedStepSeq,
                        importedCount: imported.length,
                        storedMessageCount: storedMessages.length,
                        lastStoredSeq,
                        hasEffectivePending,
                        trailingUserFingerprints
                    }
                } else {
                    if (imported.length === 0 || storedMessages.length > imported.length || totalSteps < imported.length) {
                        reply({ ok: true, status: 'diverged' })
                        return
                    }
                    cursor = {
                        totalSteps,
                        validatedCount: 0,
                        legacyMode: true,
                        recordedCount: 0,
                        lastRecordedStepSeq: -1,
                        importedCount: imported.length,
                        storedMessageCount: storedMessages.length,
                        lastStoredSeq,
                        hasEffectivePending: false,
                        trailingUserFingerprints: new Set<string>()
                    }
                }
            } else {
                const existing = pendingNativeReconciles.get(cursorKey)
                if (
                    !existing
                    || existing.totalSteps !== totalSteps
                    || existing.validatedCount !== offset
                    || existing.recordedCount !== recorded.length
                    || existing.lastRecordedStepSeq !== lastRecordedStepSeq
                    || existing.importedCount !== imported.length
                    || existing.storedMessageCount !== storedMessages.length
                    || existing.lastStoredSeq !== lastStoredSeq
                ) {
                    pendingNativeReconciles.delete(cursorKey)
                    reply({ ok: false })
                    return
                }
                cursor = existing
            }

            if (!cursor.legacyMode) {
                const recordedEnd = Math.min(endOffset, recorded.length)
                for (let idx = offset; idx < recordedEnd; idx += 1) {
                    const expected = recorded[idx]!
                    const actual = steps[idx - offset]!
                    if (actual.anchor !== expected.anchor || actual.fingerprint !== expected.fingerprint) {
                        pendingNativeReconciles.delete(cursorKey)
                        reply({ ok: true, status: 'diverged' })
                        return
                    }
                }
                if (!cursor.hasEffectivePending && cursor.trailingUserFingerprints.size > 0 && endOffset > recorded.length) {
                    const tailStart = Math.max(offset, recorded.length)
                    for (let idx = tailStart; idx < endOffset; idx += 1) {
                        if (cursor.trailingUserFingerprints.has(steps[idx - offset]!.fingerprint)) {
                            pendingNativeReconciles.delete(cursorKey)
                            reply({ ok: true, status: 'diverged' })
                            return
                        }
                    }
                }
            } else {
                const legacyEnd = Math.min(endOffset, imported.length)
                for (let idx = offset; idx < legacyEnd; idx += 1) {
                    const msg = imported[idx]!
                    const actual = steps[idx - offset]!
                    if (
                        msg.localId !== `${importPrefix}${actual.anchor}`
                        || computeLocalTranscriptFingerprint(msg.content) !== actual.fingerprint
                    ) {
                        pendingNativeReconciles.delete(cursorKey)
                        reply({ ok: true, status: 'diverged' })
                        return
                    }
                }
            }

            if (endOffset < totalSteps) {
                cursor.validatedCount = endOffset
                if (pendingNativeReconciles.size >= MAX_PENDING_NATIVE_RECONCILES && !pendingNativeReconciles.has(cursorKey)) {
                    const oldestKey = pendingNativeReconciles.keys().next().value
                    if (oldestKey !== undefined) {
                        pendingNativeReconciles.delete(oldestKey)
                    }
                }
                pendingNativeReconciles.delete(cursorKey)
                pendingNativeReconciles.set(cursorKey, cursor)
                reply({
                    ok: true,
                    status: 'continue',
                    nextOffset: endOffset,
                    confirmedCount: cursor.legacyMode ? imported.length : recorded.length
                })
                return
            }

            pendingNativeReconciles.delete(cursorKey)
            if (!cursor.legacyMode) {
                const demoted = store.messages.markDispatchingMessagesIndeterminate(sid)
                if (demoted.length > 0) {
                    onWebappEvent?.({ type: 'messages-indeterminate', sessionId: sid, localIds: demoted })
                }
                const latestStoredMessages = demoted.length > 0 ? store.messages.getAllMessages(sid) : storedMessages
                const effectivePending = collectEffectivePendingDeliveries(
                    latestStoredMessages,
                    recorded,
                    store.nativeSteps.getPendingDeliveries(sid, nativeId)
                )
                if (!cursor.hasEffectivePending && effectivePending.length > 0) {
                    reply({ ok: false })
                    return
                }
                if (effectivePending.length > 0) {
                    if (totalSteps === recorded.length) {
                        const hasCorroborated = effectivePending.some((entry) => !entry.uncertain)
                        if (hasCorroborated) {
                            reply({ ok: true, status: 'pending_flush', confirmedCount: recorded.length })
                            return
                        }
                        const unresolvedLocalIds = Array.from(new Set(
                            effectivePending.flatMap((entry) =>
                                entry.kind === 'user' && entry.awaitingResolution ? entry.localIds : []
                            )
                        ))
                        reply({
                            ok: true,
                            status: 'up_to_date',
                            confirmedCount: recorded.length,
                            ...(unresolvedLocalIds.length > 0 ? { unresolvedLocalIds } : {})
                        })
                        return
                    }
                    reply({
                        ok: true,
                        status: 'needs_reconcile',
                        fromIndex: recorded.length,
                        pendingDeliveries: serializePendingDeliveriesForCli(effectivePending)
                    })
                    return
                }
                if (totalSteps === recorded.length) {
                    reply({ ok: true, status: 'up_to_date', confirmedCount: recorded.length })
                } else {
                    reply({ ok: true, status: 'needs_backfill', fromIndex: recorded.length })
                }
                return
            }

            const legacySteps = imported.map((msg) => ({
                anchor: msg.localId!.slice(importPrefix.length),
                fingerprint: computeLocalTranscriptFingerprint(msg.content),
                messageId: msg.id
            }))
            store.nativeSteps.recordSteps(sid, nativeId, legacySteps)
            if (totalSteps === imported.length) {
                reply({ ok: true, status: 'up_to_date', confirmedCount: imported.length })
            } else {
                reply({ ok: true, status: 'needs_backfill', fromIndex: imported.length })
            }
        } catch (err) {
            console.error('reconcileNativeSteps failed', err)
            reply({ ok: false })
        }
    })

    socket.on('session-backfill-native-messages', (
        data: unknown,
        ack?: (response: { ok: true; inserted: number; confirmedCount: number } | { ok: false }) => void
    ) => {
        const reply = typeof ack === 'function' ? ack : () => {}
        const parsed = backfillNativeMessagesSchema.safeParse(data)
        if (!parsed.success) {
            reply({ ok: false })
            return
        }
        const sessionAccess = resolveSessionAccess(parsed.data.sid, { fresh: true })
        if (!sessionAccess.ok) {
            emitAccessError('session', parsed.data.sid, sessionAccess.reason)
            reply({ ok: false })
            return
        }
        const metadata = sessionAccess.value.metadata as { agyImportedAt?: unknown; agySessionId?: unknown } | null
        if (metadata?.agyImportedAt == null || metadata.agySessionId !== parsed.data.nativeId) {
            reply({ ok: false })
            return
        }
        const appended: StoredMessage[] = []
        try {
            const { sid, nativeId, expectedOffset, messages } = parsed.data
            const confirmedCount = store.runInTransaction(() => {
                const currentCount = store.nativeSteps.getSteps(sid, nativeId).length
                if (currentCount !== expectedOffset) {
                    throw new Error('NATIVE_STEP_OFFSET_MISMATCH')
                }
                const ledgerSteps: Array<{ anchor: string; fingerprint: string; messageId: string }> = []
                for (const item of messages) {
                    if (item.localId !== `agy:${nativeId}:${item.anchor}`) {
                        throw new Error('INVALID_NATIVE_LOCAL_ID')
                    }
                    const added = store.messages.addImportedMessage(
                        sid,
                        item.content,
                        item.localId,
                        item.createdAt
                    )
                    if (added.inserted) {
                        appended.push(added.message)
                    }
                    ledgerSteps.push({
                        anchor: item.anchor,
                        fingerprint: computeLocalTranscriptFingerprint(item.content),
                        messageId: added.message.id
                    })
                }
                store.nativeSteps.recordSteps(sid, nativeId, ledgerSteps)
                return store.nativeSteps.getSteps(sid, nativeId).length
            })
            for (const msg of appended) {
                broadcastMessageUpdate(sid, msg)
            }
            reply({ ok: true, inserted: appended.length, confirmedCount })
        } catch (err) {
            if (!(err instanceof Error && (err.message === 'NATIVE_STEP_OFFSET_MISMATCH' || err.message === 'INVALID_NATIVE_LOCAL_ID'))) {
                console.error('backfillNativeMessages failed', err)
            }
            reply({ ok: false })
        }
    })

    socket.on('session-end', (data: SessionEndPayload) => {
        if (!data || typeof data.sid !== 'string' || typeof data.time !== 'number') {
            return
        }
        // Fresh resolve: the shared-Codex capability gate below decides
        // whether the queue ledger is swept, and capabilities can change via
        // metadata writes. Session end fires once per session — not a hot
        // path — so read the live row rather than a memo snapshot.
        const sessionAccess = resolveSessionAccess(data.sid, { fresh: true })
        if (!sessionAccess.ok) {
            emitAccessError('session', data.sid, sessionAccess.reason)
            return
        }

        // Force-invoke only immediate-queued messages (scheduled_at IS NULL) at
        // session end.  *All* scheduled rows — mature or future — are deliberately
        // preserved in DB so the mature-scan path (releaseMatureScheduledMessages)
        // remains the sole emit channel and the CLI ack remains the sole writer of
        // invoked_at.  See HAPI Bot R4: stamping a mature scheduled row here would
        // make the next mature-scan tick skip it (filter on invoked_at IS NULL) and
        // silently drop the user's prompt.
        //
        // Without this sweep for immediate rows, the floating bar would pin queued
        // rows after the CLI exits — there is no longer an ack path, so they would
        // stay queued forever.  The 5-second tick in syncEngine.expireInactive
        // emits scheduled rows when they mature, regardless of session end.
        // Shared Codex execution exit is suspension, not consumption. Its native
        // queue ledger proves which messages can be replayed on ordinary resume.
        // Never stamp pending/uncertain input as executed, including on archive.
        const sharedCodex = (sessionAccess.value.metadata as Metadata | null)?.capabilities?.concurrentClients
        if (data.reason !== 'cleared' && !sharedCodex) {
            try {
                onSweepImmediateQueued?.(data.sid, Date.now())
            } catch (err) {
                console.error('session-end sweep failed', err)
            }
        }

        onSessionEnd?.(data)
    })
}
