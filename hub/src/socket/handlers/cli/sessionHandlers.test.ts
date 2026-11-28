import { describe, expect, it, mock } from 'bun:test'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import { Store, type StoredSession } from '../../../store'
import type { SyncEvent } from '../../../sync/syncEngine'
import type { CliSocketWithData } from '../../socketTypes'
import { computeLocalTranscriptFingerprint } from '../../../web/routes/localSessions/matchAnchored'
import { registerSessionHandlers } from './sessionHandlers'

class FakeSocket {
    readonly roomEvents: Array<{ room: string; event: string; data: unknown }> = []
    private readonly handlers = new Map<string, (data: unknown, ack?: (response: unknown) => void) => void>()

    on(event: string, handler: (data: unknown, ack?: (response: unknown) => void) => void): this {
        this.handlers.set(event, handler)
        return this
    }

    to(room: string): { emit: (event: string, data: unknown) => void } {
        return {
            emit: (event: string, data: unknown) => {
                this.roomEvents.push({ room, event, data })
            }
        }
    }

    trigger(event: string, data: unknown, ack?: (response: unknown) => void): void {
        this.handlers.get(event)?.(data, ack)
    }
}

it('does not rebroadcast stored messages and retains repeated consumption acknowledgements', () => {
    const store = new Store(':memory:')
    const session = store.sessions.getOrCreateSession('dedupe-replay', {}, null, 'default')
    const socket = new FakeSocket()
    const events: SyncEvent[] = []
    const progress = mock(() => {})
    registerSessionHandlers(socket as unknown as CliSocketWithData, {
        store, resolveSessionAccess: () => ({ ok: true, value: session }), emitAccessError() {},
        onWebappEvent: event => events.push(event), onAgentProgress: progress
    })
    const message = { sid: session.id, localId: 'stable-1', message: { role: 'user', content: { type: 'text', text: 'hello' } } }
    socket.trigger('message', message)
    socket.trigger('messages-consumed', { sid: session.id, localIds: ['stable-1'] })
    socket.trigger('message', message)
    socket.trigger('messages-consumed', { sid: session.id, localIds: ['stable-1'] })
    expect(events.filter(event => event.type === 'message-received')).toHaveLength(1)
    expect(events.filter(event => event.type === 'messages-consumed')).toHaveLength(2)
    expect(progress).toHaveBeenCalledTimes(1)
    expect(store.messages.getAllMessages(session.id)).toHaveLength(1)
    store.close()
})

function redundantGoalStatusContent(message: string): unknown {
    return {
        role: 'agent',
        content: {
            id: `event-${message}`,
            type: 'event',
            data: { type: 'message', message }
        }
    }
}

function reasoningContent(streamId: string, text: string, live: boolean): unknown {
    return {
        role: 'agent',
        content: {
            type: AGENT_MESSAGE_PAYLOAD_TYPE,
            data: { type: 'reasoning', message: text, id: streamId, ...(live ? { live: true } : {}) }
        }
    }
}

function reasoningTextOf(message: { content: unknown }): string {
    return (message.content as { content: { data: { message: string } } }).content.data.message
}

type ToolCallFields = {
    input?: unknown
    status?: string
    nativeTitle?: string
}

function toolCallContent(callId: string, fields: ToolCallFields = {}): unknown {
    return {
        role: 'agent',
        content: {
            type: AGENT_MESSAGE_PAYLOAD_TYPE,
            data: {
                type: 'tool-call',
                callId,
                name: 'Read',
                ...(fields.input !== undefined ? { input: fields.input } : {}),
                ...(fields.status !== undefined ? { status: fields.status } : {}),
                ...(fields.nativeTitle !== undefined ? { nativeTitle: fields.nativeTitle } : {})
            }
        }
    }
}

function toolCallResultContent(callId: string, output: unknown): unknown {
    return {
        role: 'agent',
        content: {
            type: AGENT_MESSAGE_PAYLOAD_TYPE,
            data: { type: 'tool-call-result', callId, output }
        }
    }
}

describe('cli session handlers', () => {
    it('advances the agent-progress clock when a tool-call tick merges into its row', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('merge-progress', {}, null, 'default')
        const socket = new FakeSocket()
        const progressTimes: number[] = []
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store, resolveSessionAccess: () => ({ ok: true, value: session }), emitAccessError() {},
            onAgentProgress: (sid, at) => progressTimes.push(at)
        })
        const now = Date.now()
        // Two ticks of one live call, two minutes apart per the CLI's own
        // transcript timestamps. The merged row keeps its first snapshot's
        // createdAt for stable ordering — but each tick must still advance
        // the keepalive-idle clock, or an ACP call with thinking=false and no
        // background task can be marked idle despite fresh updates.
        socket.trigger('message', {
            sid: session.id,
            message: toolCallContent('call-1', { status: 'running' }),
            createdAt: now - 120_000
        })
        expect(progressTimes).toHaveLength(1)
        socket.trigger('message', {
            sid: session.id,
            message: toolCallContent('call-1', { status: 'running', input: { file: 'b' } }),
            createdAt: now - 60_000
        })
        expect(progressTimes).toHaveLength(2)
        expect(progressTimes[1]!).toBeGreaterThan(progressTimes[0]!)
        expect(store.messages.getAllMessages(session.id)).toHaveLength(1)
        store.close()
    })
    it.each([undefined, 'terminated', 'error'] as const)('preserves shared Codex pending input on execution exit (%s)', reason => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('shared-end', { flavor: 'codex', capabilities: { concurrentClients: true } }, null, 'default')
        store.messages.addMessage(session.id, { text: 'pending' }, 'pending')
        const socket = new FakeSocket(); const sweep = mock(); const end = mock()
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store, resolveSessionAccess: () => ({ ok: true, value: session }), emitAccessError() {},
            onSweepImmediateQueued: sweep, onSessionEnd: end
        })
        socket.trigger('session-end', { sid: session.id, time: Date.now(), reason })
        expect(sweep).not.toHaveBeenCalled(); expect(end).toHaveBeenCalledTimes(1)
        expect(store.messages.getAllMessages(session.id)[0]).toMatchObject({ localId: 'pending', invokedAt: null })
        store.close()
    })
    it('mirrors native queued edits/removal without overwriting or deleting a consumed row', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('shared-queue', { capabilities: { concurrentClients: true } }, null, 'default')
        const socket = new FakeSocket(); const events: SyncEvent[] = []
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store, resolveSessionAccess: () => ({ ok: true, value: session }), emitAccessError() {}, onWebappEvent: event => events.push(event)
        })
        const sync = (localId: string, text: string | null) => socket.trigger('native-queue-message', { sid: session.id, localId, text })
        sync('queued', 'one'); sync('queued', 'edited')
        expect(store.messages.getAllMessages(session.id)).toHaveLength(1)
        expect(store.messages.getAllMessages(session.id)[0]).toMatchObject({ invokedAt: null, content: {
            content: { text: 'edited' }, meta: { sentFrom: 'cli', isNativeQueuedMessage: true }
        } })
        sync('queued', null); expect(events.at(-1)).toMatchObject({ type: 'message-cancelled', localId: 'queued' })
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'original', attachments: [{ name: 'image.png' }] }, meta: { sentFrom: 'web' } }, 'attachment')
        sync('attachment', 'edited')
        expect(store.messages.getAllMessages(session.id)[0]).toMatchObject({ content: { content: { attachments: [{ name: 'image.png' }], text: 'edited' }, meta: { sentFrom: 'web' } } })
        sync('attachment', null)
        sync('consumed', 'executed'); store.messages.markMessagesInvoked(session.id, ['consumed'], Date.now())
        sync('consumed', 'stale'); sync('consumed', null)
        expect(store.messages.getAllMessages(session.id)[0]).toMatchObject({ content: { content: { text: 'executed' } } })
    })
    it('preserves immediate queued rows for cleared handoff transfer', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('clear-end', {}, null, 'default')
        store.messages.addMessage(session.id, { text: 'held' }, 'held-local')
        const socket = new FakeSocket()
        let swept = false
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {},
            onSweepImmediateQueued: () => { swept = true }
        })
        socket.trigger('session-end', { sid: session.id, time: Date.now(), reason: 'cleared' })
        expect(swept).toBe(false)
        expect(store.messages.getAllMessages(session.id)).toEqual([
            expect.objectContaining({ localId: 'held-local', invokedAt: null })
        ])
    })

    it('collapses a live reasoning stream into its settled message', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('reasoning-stream-session', {}, null, 'default')
        const socket = new FakeSocket()

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            }
        })

        for (const text of ['th', 'thin', 'think']) {
            socket.trigger('message', { sid: session.id, message: reasoningContent('stream-1', text, true) })
        }
        socket.trigger('message', { sid: session.id, message: reasoningContent('stream-1', 'thinking', false) })
        // A second stream in the same turn must survive the first one's cleanup.
        socket.trigger('message', { sid: session.id, message: reasoningContent('stream-2', 'more', true) })

        expect(store.messages.getAllMessages(session.id).map(reasoningTextOf)).toEqual(['thinking', 'more'])
    })

    it('collapses a live text stream into its settled boundary message', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('text-stream-session', {}, null, 'default')
        const socket = new FakeSocket()

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            }
        })

        // Idle flushes: the CLI re-sends the growing buffer under one id,
        // marked live; the boundary flush re-sends the full text with only
        // the snapshot marker. Only the settled row may survive.
        const textContent = (streamId: string, text: string, live: boolean) => ({
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: {
                    type: 'message',
                    message: text,
                    id: streamId,
                    streamSnapshot: true,
                    ...(live ? { live: true } : {})
                }
            }
        })
        for (const text of ['He', 'Hello', 'Hello wor', 'Hello world, the ans']) {
            socket.trigger('message', { sid: session.id, message: textContent('text-1', text, true) })
        }
        socket.trigger('message', { sid: session.id, message: textContent('text-1', 'Hello world, the answer.', false) })

        const bodies = store.messages.getAllMessages(session.id)
            .map((message) => (message.content as { content: { data: { message: string } } }).content.data.message)
        expect(bodies).toEqual(['Hello world, the answer.'])
    })

    it('keeps plain text messages without a stream id untouched', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('plain-text-session', {}, null, 'default')
        const socket = new FakeSocket()

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            }
        })

        for (const text of ['one', 'two']) {
            socket.trigger('message', {
                sid: session.id,
                message: { role: 'agent', content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'message', message: text } } }
            })
        }

        expect(store.messages.getAllMessages(session.id)).toHaveLength(2)
    })

    it('keeps every reasoning snapshot that carries no stream id', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('reasoning-idless-session', {}, null, 'default')
        const socket = new FakeSocket()

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            }
        })

        for (const text of ['one', 'two']) {
            socket.trigger('message', {
                sid: session.id,
                message: { role: 'agent', content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'reasoning', message: text } } }
            })
        }

        expect(store.messages.getAllMessages(session.id)).toHaveLength(2)
    })

    it('drops redundant goal status events before persistence and broadcast', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('goal-status-session', {}, null, 'default')
        const socket = new FakeSocket()
        const webEvents: SyncEvent[] = []

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            },
            onWebappEvent: (event) => {
                webEvents.push(event)
            }
        })

        for (const message of [
            'Goal active · 8016 tokens',
            'Goal blocked',
            'Goal limited by usage · 8016 tokens'
        ]) {
            socket.trigger('message', {
                sid: session.id,
                message: redundantGoalStatusContent(message)
            })
        }

        expect(store.messages.getMessages(session.id)).toHaveLength(0)
        expect(socket.roomEvents).toHaveLength(0)
        expect(webEvents).toHaveLength(0)
    })

    it('emits a structured todos patch when a TodoWrite message lands (closes second half of #884)', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('todos-session', { path: '/tmp', host: 'h' }, null, 'default')
        const socket = new FakeSocket()
        const webEvents: SyncEvent[] = []

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            },
            onWebappEvent: (event) => {
                webEvents.push(event)
            }
        })

        socket.trigger('message', {
            sid: session.id,
            message: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            content: [
                                {
                                    type: 'tool_use',
                                    name: 'TodoWrite',
                                    input: {
                                        todos: [
                                            { content: 'pending thing', status: 'pending' },
                                            { content: 'done thing', status: 'completed' }
                                        ]
                                    }
                                }
                            ]
                        }
                    }
                }
            }
        })

        const sessionUpdated = webEvents.find((e) => e.type === 'session-updated')
        expect(sessionUpdated).toBeDefined()
        if (!sessionUpdated || sessionUpdated.type !== 'session-updated') return
        expect(sessionUpdated.data).toMatchObject({
            todos: {
                version: expect.any(Number),
                value: [
                    { content: 'pending thing', status: 'pending' },
                    { content: 'done thing', status: 'completed' }
                ]
            }
        })
        expect(typeof (sessionUpdated.data as { updatedAt?: number }).updatedAt).toBe('number')
        expect((sessionUpdated.data as { updatedAt?: number }).updatedAt).toBeGreaterThan(0)
    })

    it('emits a structured metadata patch on update-metadata RPC (closes second half of #884)', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'metadata-patch-session',
            { path: '/tmp/project', host: 'example' },
            null,
            'default'
        )
        const socket = new FakeSocket()
        const webEvents: SyncEvent[] = []

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            },
            onWebappEvent: (event) => {
                webEvents.push(event)
            }
        })

        socket.trigger(
            'update-metadata',
            {
                sid: session.id,
                expectedVersion: session.metadataVersion,
                metadata: { lifecycleState: 'archived' }
            },
            () => {}
        )

        const sessionUpdated = webEvents.find((e) => e.type === 'session-updated')
        expect(sessionUpdated).toBeDefined()
        if (!sessionUpdated || sessionUpdated.type !== 'session-updated') return
        const data = sessionUpdated.data as { metadata?: { version: number; value: Record<string, unknown> }; updatedAt?: number } | undefined
        expect(data?.metadata?.version).toBe(session.metadataVersion + 1)
        // Merged value: original path/host preserved + new lifecycleState applied.
        expect(data?.metadata?.value).toMatchObject({
            path: '/tmp/project',
            host: 'example',
            lifecycleState: 'archived'
        })
        expect(typeof data?.updatedAt).toBe('number')
        // Same-ms create+update is common in unit tests; store still touches updated_at.
        expect(data?.updatedAt).toBeGreaterThanOrEqual(session.updatedAt)
    })

    it('emits a structured agentState patch on update-state RPC (closes second half of #884)', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'agent-state-patch-session',
            { path: '/tmp', host: 'h' },
            null,
            'default'
        )
        const socket = new FakeSocket()
        const webEvents: SyncEvent[] = []

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            },
            onWebappEvent: (event) => {
                webEvents.push(event)
            }
        })

        socket.trigger(
            'update-state',
            {
                sid: session.id,
                expectedVersion: session.agentStateVersion,
                agentState: { controlledByUser: true }
            },
            () => {}
        )

        const sessionUpdated = webEvents.find((e) => e.type === 'session-updated')
        expect(sessionUpdated).toBeDefined()
        if (!sessionUpdated || sessionUpdated.type !== 'session-updated') return
        const data = sessionUpdated.data as {
            agentState?: { version: number; value: { controlledByUser?: boolean } }
            updatedAt?: number
        } | undefined
        expect(data?.agentState?.version).toBe(session.agentStateVersion + 1)
        expect(data?.agentState?.value).toMatchObject({ controlledByUser: true })
        expect(typeof data?.updatedAt).toBe('number')
        // Same-ms create+update is common in unit tests; store still touches updated_at.
        expect(data?.updatedAt).toBeGreaterThanOrEqual(session.updatedAt)
    })

    it('update-metadata broadcasts the merged value, not the pre-merge payload', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'broadcast-merged',
            {
                path: '/tmp/project',
                host: 'example',
                cursorSessionId: 'broadcast-survives'
            },
            null,
            'default'
        )
        const socket = new FakeSocket()

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            }
        })

        let ackResponse: unknown = null
        socket.trigger(
            'update-metadata',
            {
                sid: session.id,
                expectedVersion: session.metadataVersion,
                metadata: {
                    lifecycleState: 'archived',
                    archivedBy: 'cli',
                    archiveReason: 'Session crashed'
                }
            },
            (response) => {
                ackResponse = response
            }
        )

        // Ack: success and the version bumps; the persisted value carries the
        // merged metadata so other CLIs can update their cache to the truth.
        const ack = ackResponse as { result: string; version: number; metadata: unknown }
        expect(ack.result).toBe('success')
        const ackMetadata = ack.metadata as Record<string, unknown>
        expect(ackMetadata.cursorSessionId).toBe('broadcast-survives')
        expect(ackMetadata.path).toBe('/tmp/project')

        // Broadcast: the room event must carry the same merged value.
        const broadcast = socket.roomEvents.find((event) => event.event === 'update')
        expect(broadcast).toBeDefined()
        const broadcastBody = (broadcast?.data as { body: { metadata: { value: Record<string, unknown> } } }).body
        expect(broadcastBody.metadata.value.cursorSessionId).toBe('broadcast-survives')
        expect(broadcastBody.metadata.value.path).toBe('/tmp/project')
        expect(broadcastBody.metadata.value.lifecycleState).toBe('archived')
    })

    // Agent messages used to be stamped with
    // the hub's own Date.now() at receive time (see messages.ts addMessage),
    // ignoring the transcript's own jsonl timestamp entirely. During a burst
    // (e.g. resume replaying several transcript lines back-to-back), the CLI-side
    // processing/emit order does not always match the jsonl append order, so the
    // hub's arrival-time stamping could display messages out of jsonl order. The
    // fix is for agent messages to respect a client-provided `createdAt` (the
    // transcript entry's own timestamp) for BOTH created_at and invoked_at, so
    // getMessagesByPosition's existing COALESCE(invoked_at, created_at) sort
    // reproduces jsonl order regardless of arrival order.
    it('agent messages: display order follows client-provided createdAt (jsonl order), not hub arrival order', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('order-drift', {}, null, 'default')
        const socket = new FakeSocket()

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            }
        })

        // jsonl SSOT order is msg-1 (createdAt=1000) then msg-2 (createdAt=2000).
        // Simulate the burst/resume drift by having the hub receive msg-2 FIRST.
        socket.trigger('message', {
            sid: session.id,
            message: { role: 'agent', content: { type: 'output', data: { uuid: 'msg-2' } } },
            createdAt: 2000
        })
        socket.trigger('message', {
            sid: session.id,
            message: { role: 'agent', content: { type: 'output', data: { uuid: 'msg-1' } } },
            createdAt: 1000
        })

        const ordered = store.messages.getMessagesByPosition(session.id, 10)
        const uuids = ordered.map((m) => (m.content as { content: { data: { uuid: string } } }).content.data.uuid)
        expect(uuids).toEqual(['msg-1', 'msg-2'])
    })

it.each([
        ['agyImportedAt', 1234],
        ['codexImportedAt', 1234],
        ['supersededBySessionId', 'foreign-session'],
        ['opencodeClearOperation', { replacementSessionId: 'foreign-session', state: 'reserved', updatedAt: Date.now() }],
        ['opencodeForkPending', true],
        ['titleSuggestionAutoAttemptedAt', 1234],
        ['titleSuggestionTurn', { first: false, completed: true }],
        ['promptTitle', 'Forged title'],
        ['translateInput', true],
        ['jobsAcceptedFromSessionIds', ['foreign-session']],
        ['jobsTransferredToSessionId', 'foreign-session'],
        ['jobKeyRedirects', { 'foreign-session/beets': 'beets.foreign' }],
    ] as const)(
        'ignores a forged hub-owned %s addition from CLI metadata',
        (field, forged) => {
            const store = new Store(':memory:')
            const session = store.sessions.getOrCreateSession('forged-clear-link', { path: '/tmp/project' }, null, 'default')
            const socket = new FakeSocket()
            registerSessionHandlers(socket as unknown as CliSocketWithData, {
                store,
                resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
                emitAccessError: () => { throw new Error('unexpected access error') }
            })
            socket.trigger('update-metadata', {
                sid: session.id,
                expectedVersion: session.metadataVersion,
                metadata: {
                    path: '/tmp/project',
                    [field]: forged
                }
            }, () => {})
            expect(store.sessions.getSessionByNamespace(session.id, 'default')?.metadata).not.toHaveProperty(field)
        }
    )

    it('rejects malformed waiting without wiping prior metadata (#2616)', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('waiting-ingress', {
            path: '/tmp/project',
            host: 'h',
            lifecycleState: 'running',
            waiting: { since: 1_700_000_000_000, reason: 'watch CI on tip' },
        }, null, 'default')
        const socket = new FakeSocket()
        let reply: { result: string } | undefined
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({
                ok: true,
                value: store.sessions.getSessionByNamespace(session.id, 'default') as StoredSession,
            }),
            emitAccessError: () => { throw new Error('unexpected access error') }
        })
        socket.trigger('update-metadata', {
            sid: session.id,
            expectedVersion: session.metadataVersion,
            metadata: {
                path: '/tmp/project',
                host: 'h',
                // Missing required `since` — must fail closed before persist.
                waiting: { reason: 'watch CI' },
            },
        }, (ack: unknown) => { reply = ack as { result: string } })
        expect(reply).toEqual({ result: 'error' })
        expect(store.sessions.getSessionByNamespace(session.id, 'default')?.metadata).toMatchObject({
            path: '/tmp/project',
            waiting: { since: 1_700_000_000_000, reason: 'watch CI on tip' },
        })
    })

    it('preserves the hub-owned translateInput toggle across CLI metadata replacements', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('preserve-translate', {
            path: '/tmp/project', translateInput: true
        }, null, 'default')
        const socket = new FakeSocket()
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => { throw new Error('unexpected access error') }
        })
        socket.trigger('update-metadata', {
            sid: session.id,
            expectedVersion: session.metadataVersion,
            metadata: { path: '/tmp/project', translateInput: false }
        }, () => {})
        expect(store.sessions.getSessionByNamespace(session.id, 'default')?.metadata)
            .toMatchObject({ translateInput: true })
    })

    it.each([1234, null])('preserves Codex import state %s across CLI bootstrap replacements', (codexImportedAt) => {
        const store = new Store(':memory:')
        try {
            const session = store.sessions.getOrCreateSession('preserve-import-state', {
                path: '/tmp/project', codexImportedAt
            }, null, 'default')
            const socket = new FakeSocket()
            registerSessionHandlers(socket as unknown as CliSocketWithData, {
                store,
                resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
                emitAccessError: () => { throw new Error('unexpected access error') }
            })
            socket.trigger('update-metadata', {
                sid: session.id,
                expectedVersion: session.metadataVersion,
                metadata: { path: '/tmp/project' }
            }, () => {})
            expect(store.sessions.getSessionByNamespace(session.id, 'default')?.metadata)
                .toHaveProperty('codexImportedAt', codexImportedAt)
        } finally {
            store.close()
        }
    })

    it('preserves existing hub-owned clear and job-redirect metadata across CLI metadata updates', () => {
        const store = new Store(':memory:')
        const operation = { replacementSessionId: 'owned-target', state: 'completed', updatedAt: Date.now() }
        const session = store.sessions.getOrCreateSession('preserve-clear-link', {
            supersededBySessionId: 'owned-target',
            opencodeClearOperation: operation,
            opencodeForkPending: true,
            jobsAcceptedFromSessionIds: ['old-session'],
            jobsTransferredToSessionId: 'merge-target',
            jobKeyRedirects: { 'old-session/beets': 'beets.oldsess1' },
        }, null, 'default')
        const socket = new FakeSocket()
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => { throw new Error('unexpected access error') }
        })
        socket.trigger('update-metadata', {
            sid: session.id,
            expectedVersion: session.metadataVersion,
            metadata: {
                lifecycleState: 'archived',
                supersededBySessionId: 'forged-target', opencodeForkPending: false,
                opencodeClearOperation: { replacementSessionId: 'forged-target', state: 'reserved', updatedAt: 0 },
                jobsAcceptedFromSessionIds: ['forged-session'],
                jobsTransferredToSessionId: 'forged-target',
                jobKeyRedirects: { 'forged/beets': 'beets.forged' },
            }
        }, () => {})
        expect(store.sessions.getSessionByNamespace(session.id, 'default')?.metadata).toMatchObject({
            supersededBySessionId: 'owned-target',
            opencodeClearOperation: operation,
            opencodeForkPending: true,
            jobsAcceptedFromSessionIds: ['old-session'],
            jobsTransferredToSessionId: 'merge-target',
            jobKeyRedirects: { 'old-session/beets': 'beets.oldsess1' },
            lifecycleState: 'archived',
        })
    })

    it('preserves the automatic title attempt marker across CLI metadata updates', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('preserve-auto-title-marker', {
            path: '/tmp/project',
            titleSuggestionAutoAttemptedAt: 1234,
            titleSuggestionTurn: { first: true, completed: false },
            promptTitle: 'Fix the login bug'
        }, null, 'default')
        const socket = new FakeSocket()
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => { throw new Error('unexpected access error') }
        })

        socket.trigger('update-metadata', {
            sid: session.id,
            expectedVersion: session.metadataVersion,
            metadata: { path: '/tmp/project', titleSuggestionAutoAttemptedAt: 9999, titleSuggestionTurn: { first: false, completed: true } }
        }, () => {})

        expect(store.sessions.getSessionByNamespace(session.id, 'default')?.metadata).toMatchObject({
            titleSuggestionAutoAttemptedAt: 1234,
            titleSuggestionTurn: { first: true, completed: false },
            promptTitle: 'Fix the login bug'
        })
    })

    it('applies a refined TodoWrite snapshot merged into the same callId row', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('acp-todowrite-merge', {}, null, 'default')
        const socket = new FakeSocket()
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store, resolveSessionAccess: () => ({ ok: true, value: session }), emitAccessError() {}
        })
        const todoCall = (todos: Array<{ content: string; status: string }>) => ({
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: { type: 'tool-call', callId: 'todo-1', name: 'TodoWrite', input: { todos }, status: 'in_progress' }
            }
        })
        const send = (content: unknown) => socket.trigger('message', { sid: session.id, message: content })

        send(todoCall([{ content: 'first', status: 'pending' }]))
        // The refined snapshot re-emits the same callId with a different valid
        // todos array; the merged row must feed the session's todo list too.
        send(todoCall([
            { content: 'first', status: 'completed' },
            { content: 'second', status: 'pending' }
        ]))

        const rows = store.messages.getAllMessages(session.id)
        expect(rows).toHaveLength(1)
        expect(store.sessions.getSession(session.id)?.todos).toEqual([
            { content: 'first', status: 'completed', priority: 'medium', id: '' },
            { content: 'second', status: 'pending', priority: 'medium', id: '' }
        ])
        store.close()
    })

    it('folds repeated ACP tool-call updates into one stored row and rebroadcasts the merged row', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('acp-toolcall-fold', {}, null, 'default')
        const socket = new FakeSocket()
        const events: SyncEvent[] = []
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store, resolveSessionAccess: () => ({ ok: true, value: session }), emitAccessError() {},
            onWebappEvent: event => events.push(event)
        })
        const send = (content: unknown) => socket.trigger('message', { sid: session.id, message: content })

        send(toolCallContent('call-1', { input: { path: '/a' }, status: 'in_progress', nativeTitle: 'Reading /a' }))
        expect(store.messages.getAllMessages(session.id)).toHaveLength(1)
        send(toolCallContent('call-1', { status: 'in_progress' }))
        // The update replaces the row in place: no second row mid-stream.
        expect(store.messages.getAllMessages(session.id)).toHaveLength(1)
        send(toolCallContent('call-1', { status: 'completed' }))
        send(toolCallResultContent('call-1', 'done'))

        const rows = store.messages.getAllMessages(session.id)
        expect(rows).toHaveLength(2)

        const received = events.filter((event): event is Extract<SyncEvent, { type: 'message-received' }> => event.type === 'message-received')
        expect(received).toHaveLength(4)
        const firstId = received[0]!.message.id
        const firstSeq = received[0]!.message.seq
        // Every update is broadcast under the FIRST row's id/seq so live
        // clients replace the row in place instead of appending a duplicate.
        expect(received[1]!.message.id).toBe(firstId)
        expect(received[1]!.message.seq).toBe(firstSeq)
        expect(received[2]!.message.id).toBe(firstId)
        expect(received[2]!.message.seq).toBe(firstSeq)
        // The result stays its own row with its own id.
        expect(received[3]!.message.id).not.toBe(firstId)
        // The final broadcast of the call carries the merged content.
        const mergedData = (received[2]!.message.content as { content: { data: Record<string, unknown> } }).content.data
        expect(mergedData.input).toEqual({ path: '/a' })
        expect(mergedData.nativeTitle).toBe('Reading /a')
        expect(mergedData.status).toBe('completed')

        // The session-room socket broadcast re-emits the same existing id/seq.
        const roomUpdates = socket.roomEvents.filter(event => event.event === 'update')
        expect(roomUpdates).toHaveLength(4)
        const updatedBody = (roomUpdates[1]!.data as {
            body: { t: string; message: { id: string; seq: number | null; content: unknown } }
        }).body
        expect(updatedBody.t).toBe('new-message')
        expect(updatedBody.message.id).toBe(firstId)
        expect(updatedBody.message.seq).toBe(firstSeq)
        expect((updatedBody.message.content as { content: { data: Record<string, unknown> } }).content.data.status).toBe('in_progress')
        store.close()
    })
})

describe('session-commit-native-steps handler', () => {
    const userContent = (text: string) => ({ role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'cli' } })
    const agentMsg = (message: string) => ({
        role: 'agent',
        content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'message', message } },
        meta: { sentFrom: 'cli' }
    })
    const reasoningMsg = (id: string, message: string) => ({
        role: 'agent',
        content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'reasoning', id, message } },
        meta: { sentFrom: 'cli' }
    })

    it('links live user/reasoning/message rows, replaces partial live replies with reconcile_update, and backfills omitted steps atomically', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'agy-imported',
            { path: '/work', host: 'h1', agyImportedAt: 100, agySessionId: 'native-1' },
            null,
            'default'
        )
        const socket = new FakeSocket()
        const events: SyncEvent[] = []
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: (sid, opts) => {
                expect(opts?.fresh).toBe(true)
                const found = store.sessions.getSession(sid)
                return found ? { ok: true, value: found } : { ok: false, reason: 'not-found' }
            },
            emitAccessError() {},
            onWebappEvent: (event) => events.push(event)
        })

        // Seed live user batch, live reasoning with different UUID id, partial live message, and tool result.
        const u1 = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'first' } }, 'u-1', null, 10)
        const u2 = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'second' } }, 'u-2', null, 11)
        store.messages.markMessagesInvoked(session.id, ['u-1', 'u-2'], 12)
        const r1 = store.messages.addMessage(session.id, reasoningMsg('live-uuid-r1', 'Thinking step'), 'agy-live:r-1', null, 13)
        expect(r1.invokedAt).not.toBeNull()
        const partial = store.messages.addMessage(session.id, agentMsg('done batch'), 'agy-live:m-1', null, 14)
        const tr = store.messages.addMessage(session.id, {
            role: 'agent',
            content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'tool-call-result', callId: 'live-call-9', output: { stdout: 'complete...' }, is_error: false } },
            meta: { sentFrom: 'cli' }
        }, 'agy-live:tr-1', null, 15)

        const diskU = userContent('first\nsecond')
        const diskR = reasoningMsg('agy:native-1:step:1:reasoning', 'Thinking step')
        const diskFull = agentMsg('done batch full text')
        const diskOmitted = agentMsg('omitted intermediate note')
        const diskTr = {
            role: 'agent',
            content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'tool-call-result', callId: 'agy-wakeup-native-1-2-0', output: { stdout: 'complete full output', exit_code: 0 }, is_error: false } },
            meta: { sentFrom: 'cli' }
        }

        const acks: Array<unknown> = []

        // 1. Linking partial 'done batch' against 'done batch full text' rejects fail-closed with content_mismatch.
        socket.trigger('session-commit-native-steps', {
            sid: session.id,
            nativeId: 'native-1',
            expectedOffset: 0,
            entries: [{
                kind: 'link',
                anchor: 'step:2:text',
                fingerprint: computeLocalTranscriptFingerprint(diskFull),
                targetLocalIds: ['agy-live:m-1'],
                content: diskFull,
                createdAt: 14
            }]
        }, (resp) => acks.push(resp))
        expect(acks[0]).toEqual({ ok: false, reason: 'content_mismatch' })
        expect(store.nativeSteps.getSteps(session.id, 'native-1')).toEqual([])

        // 2. Missing target returns missing_target without inserting.
        socket.trigger('session-commit-native-steps', {
            sid: session.id,
            nativeId: 'native-1',
            expectedOffset: 0,
            entries: [{
                kind: 'link',
                anchor: 'step:0:0',
                fingerprint: computeLocalTranscriptFingerprint(diskU),
                targetLocalIds: ['does-not-exist'],
                content: diskU,
                createdAt: 12
            }]
        }, (resp) => acks.push(resp))
        expect(acks[1]).toEqual({ ok: false, reason: 'missing_target' })

        // 3. Atomic commit with link + link(reasoning) + backfill + reconcile_update + reconcile_update(tool-result preserving callId).
        socket.trigger('session-commit-native-steps', {
            sid: session.id,
            nativeId: 'native-1',
            expectedOffset: 0,
            entries: [
                {
                    kind: 'link',
                    anchor: 'step:0:0',
                    fingerprint: computeLocalTranscriptFingerprint(diskU),
                    targetLocalIds: ['u-1', 'u-2'],
                    content: diskU,
                    createdAt: 12
                },
                {
                    kind: 'link',
                    anchor: 'step:1:reasoning',
                    fingerprint: computeLocalTranscriptFingerprint(diskR),
                    targetLocalIds: ['agy-live:r-1'],
                    content: diskR,
                    createdAt: 13
                },
                {
                    kind: 'backfill',
                    anchor: 'step:2:text',
                    fingerprint: computeLocalTranscriptFingerprint(diskOmitted),
                    localId: 'agy:native-1:step:2:text',
                    content: diskOmitted,
                    createdAt: 14
                },
                {
                    kind: 'reconcile_update',
                    anchor: 'step:3:text',
                    fingerprint: computeLocalTranscriptFingerprint(diskFull),
                    targetLocalId: 'agy-live:m-1',
                    localId: 'agy:native-1:step:3:text',
                    content: diskFull,
                    createdAt: 14
                },
                {
                    kind: 'reconcile_update',
                    anchor: 'step:4:0',
                    fingerprint: computeLocalTranscriptFingerprint(diskTr),
                    targetLocalId: 'agy-live:tr-1',
                    localId: 'agy:native-1:step:4:0',
                    content: diskTr,
                    createdAt: 15
                }
            ]
        }, (resp) => acks.push(resp))
        expect(acks[2]).toEqual({ ok: true, confirmedCount: 5, inserted: 1, updated: 2 })

        const updatedPartial = store.messages.getMessageById(session.id, partial.id)
        expect(updatedPartial?.content).toEqual(diskFull)
        const updatedTr = store.messages.getMessageById(session.id, tr.id)
        expect(updatedTr?.content).toMatchObject({
            role: 'agent',
            content: {
                data: {
                    type: 'tool-call-result',
                    callId: 'live-call-9',
                    output: { stdout: 'complete full output', exit_code: 0 }
                }
            }
        })
        expect(store.nativeSteps.getSteps(session.id, 'native-1')).toEqual([
            { anchor: 'step:0:0', fingerprint: computeLocalTranscriptFingerprint(diskU), messageId: u2.id, seq: 1 },
            { anchor: 'step:1:reasoning', fingerprint: computeLocalTranscriptFingerprint(diskR), messageId: r1.id, seq: 2 },
            { anchor: 'step:2:text', fingerprint: computeLocalTranscriptFingerprint(diskOmitted), messageId: expect.any(String), seq: 3 },
            { anchor: 'step:3:text', fingerprint: computeLocalTranscriptFingerprint(diskFull), messageId: partial.id, seq: 4 },
            { anchor: 'step:4:0', fingerprint: computeLocalTranscriptFingerprint(diskTr), messageId: tr.id, seq: 5 }
        ])
        expect(u1.id).not.toBe(u2.id)
        expect(socket.roomEvents.filter((e) => e.event === 'update')).toHaveLength(3)
        expect(events.filter((e) => e.type === 'message-received')).toHaveLength(3)

        // 4. Stale/mismatched expectedOffset fails closed.
        socket.trigger('session-commit-native-steps', {
            sid: session.id,
            nativeId: 'native-1',
            expectedOffset: 4,
            entries: [{
                kind: 'backfill',
                anchor: 'step:5:text',
                fingerprint: computeLocalTranscriptFingerprint(agentMsg('extra')),
                localId: 'agy:native-1:step:5:text',
                content: agentMsg('extra'),
                createdAt: 16
            }]
        }, (resp) => acks.push(resp))
        expect(acks[3]).toEqual({ ok: false, reason: 'offset_mismatch' })

        // 5. Idempotent full-overlap retry AND partial-overlap + new-tail retry succeed after lost ACK.
        socket.trigger('session-commit-native-steps', {
            sid: session.id,
            nativeId: 'native-1',
            expectedOffset: 3,
            entries: [
                {
                    kind: 'reconcile_update',
                    anchor: 'step:3:text',
                    fingerprint: computeLocalTranscriptFingerprint(diskFull),
                    targetLocalId: 'agy-live:m-1',
                    localId: 'agy:native-1:step:3:text',
                    content: diskFull,
                    createdAt: 14
                },
                {
                    kind: 'reconcile_update',
                    anchor: 'step:4:0',
                    fingerprint: computeLocalTranscriptFingerprint(diskTr),
                    targetLocalId: 'agy-live:tr-1',
                    localId: 'agy:native-1:step:4:0',
                    content: diskTr,
                    createdAt: 15
                }
            ]
        }, (resp) => acks.push(resp))
        expect(acks[4]).toEqual({ ok: true, confirmedCount: 5, inserted: 0, updated: 0 })

        const diskExtra = agentMsg('new step after retry')
        socket.trigger('session-commit-native-steps', {
            sid: session.id,
            nativeId: 'native-1',
            expectedOffset: 4,
            entries: [
                {
                    kind: 'reconcile_update',
                    anchor: 'step:4:0',
                    fingerprint: computeLocalTranscriptFingerprint(diskTr),
                    targetLocalId: 'agy-live:tr-1',
                    localId: 'agy:native-1:step:4:0',
                    content: diskTr,
                    createdAt: 15
                },
                {
                    kind: 'backfill',
                    anchor: 'step:5:text',
                    fingerprint: computeLocalTranscriptFingerprint(diskExtra),
                    localId: 'agy:native-1:step:5:text',
                    content: diskExtra,
                    createdAt: 16
                }
            ]
        }, (resp) => acks.push(resp))
        expect(acks[5]).toEqual({ ok: true, confirmedCount: 6, inserted: 1, updated: 0 })

        // 6. reconcile_update rejects unrelated non-prefix text as content_mismatch instead of overwriting.
        const conflictingLive = store.messages.addMessage(session.id, agentMsg('unrelated answer'), 'agy-live:conflict-1', null, 17)
        expect(conflictingLive.localId).toBe('agy-live:conflict-1')
        const diskBranch = agentMsg('completely different native branch')
        socket.trigger('session-commit-native-steps', {
            sid: session.id,
            nativeId: 'native-1',
            expectedOffset: 6,
            entries: [{
                kind: 'reconcile_update',
                anchor: 'step:6:text',
                fingerprint: computeLocalTranscriptFingerprint(diskBranch),
                targetLocalId: 'agy-live:conflict-1',
                localId: 'agy:native-1:step:6:text',
                content: diskBranch,
                createdAt: 17
            }]
        }, (resp) => acks.push(resp))
        expect(acks[6]).toEqual({ ok: false, reason: 'content_mismatch' })
        store.close()
    })

    it('persists durable pending deliveries from messages-consumed and message, discards cancelled turns, and returns needs_reconcile on crash reopen', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'agy-durable-pending',
            { path: '/work', host: 'h1', agyImportedAt: 100, agySessionId: 'native-pend' },
            null,
            'default'
        )
        const s0 = userContent('seed prompt')
        const m0 = store.messages.addImportedMessage(session.id, s0, 'agy:native-pend:step:0:0', 10).message
        store.nativeSteps.recordSteps(session.id, 'native-pend', [
            { anchor: 'step:0:0', fingerprint: computeLocalTranscriptFingerprint(s0), messageId: m0.id }
        ])

        const socket = new FakeSocket()
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: (sid) => {
                const found = store.sessions.getSession(sid)
                return found ? { ok: true, value: found } : { ok: false, reason: 'not-found' }
            },
            emitAccessError() {}
        })

        // Queue + cancel-discard lifecycle clears cancelled prompt from pending ledger.
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'aborted' } }, 'u-abort', null, 11)
        socket.trigger('messages-consumed', { sid: session.id, localIds: ['u-abort'], nativeId: 'native-pend' })
        expect(store.nativeSteps.getPendingDeliveries(session.id, 'native-pend')).toHaveLength(1)
        socket.trigger('session-discard-native-delivery', { sid: session.id, nativeId: 'native-pend', localIds: ['u-abort'] })
        expect(store.nativeSteps.getPendingDeliveries(session.id, 'native-pend')).toEqual([])

        // Crash before commit leaves invoked user prompt + partial agy-live: reply in SQLite pending deliveries.
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'live turn' } }, 'u-live', null, 12)
        socket.trigger('messages-consumed', { sid: session.id, localIds: ['u-live'], nativeId: 'native-pend' })
        socket.trigger('message', {
            sid: session.id,
            localId: 'agy-live:partial-1',
            createdAt: 13,
            message: agentMsg('live partial')
        })
        expect(store.nativeSteps.getPendingDeliveries(session.id, 'native-pend')).toHaveLength(2)

        const s1 = userContent('live turn')
        const s2Full = agentMsg('live partial completed text')
        const acks: unknown[] = []
        socket.trigger('session-reconcile-native-steps', {
            sid: session.id,
            nativeId: 'native-pend',
            steps: [
                { anchor: 'step:0:0', fingerprint: computeLocalTranscriptFingerprint(s0) },
                { anchor: 'step:1:0', fingerprint: computeLocalTranscriptFingerprint(s1) },
                { anchor: 'step:2:text', fingerprint: computeLocalTranscriptFingerprint(s2Full) }
            ]
        }, (resp) => acks.push(resp))
        expect(acks[0]).toEqual({
            ok: true,
            status: 'needs_reconcile',
            fromIndex: 1,
            pendingDeliveries: [
                { kind: 'user', localIds: ['u-live'], texts: ['live turn'], uncertain: false, awaitingResolution: false },
                { kind: 'agent', localId: 'agy-live:partial-1', data: { type: 'message', message: 'live partial' } }
            ]
        })

        // If disk didn't advance past step:0:0 while corroborated pending deliveries exist, reconcile reports pending_flush (retryable).
        socket.trigger('session-reconcile-native-steps', {
            sid: session.id,
            nativeId: 'native-pend',
            steps: [{ anchor: 'step:0:0', fingerprint: computeLocalTranscriptFingerprint(s0) }]
        }, (resp) => acks.push(resp))
        expect(acks[1]).toEqual({ ok: true, status: 'pending_flush', confirmedCount: 1 })
        store.close()
    })

    it('tracks dispatched user prompts via messages-steer-state until disk corroborates, demotes dispatching to indeterminate, and does not falsely diverge', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'agy-uncertain-dispatch',
            { path: '/work', host: 'h1', agyImportedAt: 100, agySessionId: 'native-uncertain' },
            null,
            'default'
        )
        const s0 = userContent('seed prompt')
        const m0 = store.messages.addImportedMessage(session.id, s0, 'agy:native-uncertain:step:0:0', 10).message
        store.nativeSteps.recordSteps(session.id, 'native-uncertain', [
            { anchor: 'step:0:0', fingerprint: computeLocalTranscriptFingerprint(s0), messageId: m0.id }
        ])

        const events: SyncEvent[] = []
        const socket = new FakeSocket()
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: (sid, opts) => {
                void opts
                const found = store.sessions.getSession(sid)
                return found ? { ok: true, value: found } : { ok: false, reason: 'not-found' }
            },
            emitAccessError() {},
            onWebappEvent: (event) => events.push(event)
        })

        // Dispatch before disk flush: stays un-invoked in deliveryState='dispatching' with pending delivery record.
        const queued = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'uncertain turn' } }, 'u-dispatch', null, 20)
        expect(queued.invokedAt).toBeNull()
        const steerAcks: Array<unknown> = []
        socket.trigger('messages-steer-state', {
            sid: session.id,
            localIds: ['u-dispatch'],
            state: 'dispatching',
            nativeId: 'native-uncertain'
        }, (resp) => steerAcks.push(resp))
        expect(steerAcks[0]).toEqual({ ok: true })
        expect(store.messages.lookupQueuedMessage(session.id, 'u-dispatch').status).toBe('dispatching')
        expect(store.nativeSteps.getPendingDeliveries(session.id, 'native-uncertain')).toHaveLength(1)

        // Crash & reopen while disk did not advance past step:0:0: demotes dispatching -> indeterminate,
        // emits messages-indeterminate, and returns up_to_date with unresolvedLocalIds (NOT diverged).
        const reconcileAcks: Array<unknown> = []
        socket.trigger('session-reconcile-native-steps', {
            sid: session.id,
            nativeId: 'native-uncertain',
            steps: [{ anchor: 'step:0:0', fingerprint: computeLocalTranscriptFingerprint(s0) }]
        }, (resp) => reconcileAcks.push(resp))
        expect(reconcileAcks[0]).toEqual({
            ok: true,
            status: 'up_to_date',
            confirmedCount: 1,
            unresolvedLocalIds: ['u-dispatch']
        })
        expect(store.messages.lookupQueuedMessage(session.id, 'u-dispatch').status).toBe('indeterminate')
        expect(events).toContainEqual({ type: 'messages-indeterminate', sessionId: session.id, localIds: ['u-dispatch'] })

        // Once disk later persists that prompt, reconcile returns needs_reconcile with uncertain: true,
        // and session-commit-native-steps corroborates the row (stamping invokedAt + emitting messages-consumed).
        const s1 = userContent('uncertain turn')
        socket.trigger('session-reconcile-native-steps', {
            sid: session.id,
            nativeId: 'native-uncertain',
            steps: [
                { anchor: 'step:0:0', fingerprint: computeLocalTranscriptFingerprint(s0) },
                { anchor: 'step:1:0', fingerprint: computeLocalTranscriptFingerprint(s1) }
            ]
        }, (resp) => reconcileAcks.push(resp))
        expect(reconcileAcks[1]).toEqual({
            ok: true,
            status: 'needs_reconcile',
            fromIndex: 1,
            pendingDeliveries: [{
                kind: 'user',
                localIds: ['u-dispatch'],
                texts: ['uncertain turn'],
                uncertain: true,
                awaitingResolution: true
            }]
        })

        const commitAcks: Array<unknown> = []
        socket.trigger('session-commit-native-steps', {
            sid: session.id,
            nativeId: 'native-uncertain',
            expectedOffset: 1,
            entries: [{
                kind: 'link',
                anchor: 'step:1:0',
                fingerprint: computeLocalTranscriptFingerprint(s1),
                targetLocalIds: ['u-dispatch'],
                content: s1,
                createdAt: 21
            }]
        }, (resp) => commitAcks.push(resp))
        expect(commitAcks[0]).toEqual({ ok: true, confirmedCount: 2, inserted: 0, updated: 0 })
        expect(store.messages.lookupQueuedMessage(session.id, 'u-dispatch').status).toBe('invoked')
        expect(store.nativeSteps.getPendingDeliveries(session.id, 'native-uncertain')).toEqual([])
        expect(events).toContainEqual(expect.objectContaining({ type: 'messages-consumed', sessionId: session.id, localIds: ['u-dispatch'] }))
        store.close()
    })

    it('rejects session-commit-native-steps when agyImportedAt is missing or nativeId does not match metadata', () => {
        const store = new Store(':memory:')
        const unimported = store.sessions.getOrCreateSession(
            'agy-plain',
            { path: '/work', host: 'h1', agySessionId: 'native-1' },
            null,
            'default'
        )
        const imported = store.sessions.getOrCreateSession(
            'agy-mismatch',
            { path: '/work', host: 'h1', agyImportedAt: 100, agySessionId: 'native-actual' },
            null,
            'default'
        )
        const socket = new FakeSocket()
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: (sid) => {
                const found = store.sessions.getSession(sid)
                return found ? { ok: true, value: found } : { ok: false, reason: 'not-found' }
            },
            emitAccessError() {}
        })

        const entry = {
            kind: 'backfill' as const,
            anchor: 'step:0:0',
            fingerprint: computeLocalTranscriptFingerprint(userContent('hi')),
            localId: 'agy:native-1:step:0:0',
            content: userContent('hi'),
            createdAt: 10
        }
        const acks: Array<unknown> = []
        socket.trigger('session-commit-native-steps', {
            sid: unimported.id,
            nativeId: 'native-1',
            expectedOffset: 0,
            entries: [entry]
        }, (resp) => acks.push(resp))
        socket.trigger('session-commit-native-steps', {
            sid: imported.id,
            nativeId: 'native-wrong',
            expectedOffset: 0,
            entries: [{ ...entry, localId: 'agy:native-wrong:step:0:0' }]
        }, (resp) => acks.push(resp))

        expect(acks).toEqual([{ ok: false }, { ok: false }])
        expect(store.nativeSteps.getSteps(unimported.id, 'native-1')).toEqual([])
        expect(store.nativeSteps.getSteps(imported.id, 'native-wrong')).toEqual([])
        store.close()
    })
})

describe('session-reconcile-native-steps and session-backfill-native-messages handlers', () => {
    const hash = (tag: string) => tag.repeat(64).slice(0, 64)
    const userContent = (text: string) => ({ role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'cli' } })
    const agentContent = (message: string) => ({
        role: 'agent',
        content: { type: 'codex', data: { type: 'message', message } },
        meta: { sentFrom: 'cli' }
    })

    it('returns up_to_date, needs_backfill, or diverged against durable ledger, message_id links, and uncommitted live turns', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'agy-reconcile',
            { path: '/work', host: 'h1', agyImportedAt: 100, agySessionId: 'native-rec' },
            null,
            'default'
        )
        const c0 = userContent('first')
        const c1 = agentContent('second')
        const m0 = store.messages.addImportedMessage(session.id, c0, 'agy:native-rec:step:0:0', 10).message
        const m1 = store.messages.addImportedMessage(session.id, c1, 'agy:native-rec:step:1:text', 11).message

        const socket = new FakeSocket()
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: (sid, opts) => {
                expect(opts?.fresh).toBe(true)
                const found = store.sessions.getSession(sid)
                return found ? { ok: true, value: found } : { ok: false, reason: 'not-found' }
            },
            emitAccessError() {}
        })

        // Legacy mismatch diverges cleanly.
        const acks: unknown[] = []
        socket.trigger('session-reconcile-native-steps', {
            sid: session.id,
            nativeId: 'native-rec',
            steps: [
                { anchor: 'step:0:0', fingerprint: hash('0') }
            ]
        }, (resp) => acks.push(resp))
        expect(acks[0]).toEqual({ ok: true, status: 'diverged' })

        store.nativeSteps.recordSteps(session.id, 'native-rec', [
            { anchor: 'step:0:0', fingerprint: computeLocalTranscriptFingerprint(c0), messageId: m0.id },
            { anchor: 'step:1:text', fingerprint: computeLocalTranscriptFingerprint(c1), messageId: m1.id }
        ])

        // Mismatching step:0:0 vs stored ledger returns diverged.
        socket.trigger('session-reconcile-native-steps', {
            sid: session.id,
            nativeId: 'native-rec',
            steps: [
                { anchor: 'step:0:0', fingerprint: hash('e') },
                { anchor: 'step:1:text', fingerprint: computeLocalTranscriptFingerprint(c1) }
            ]
        }, (resp) => acks.push(resp))
        expect(acks[1]).toEqual({ ok: true, status: 'diverged' })

        // /swarm board control row after lastRecordedSeq does not falsely diverge.
        const boardPrompt = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: '/swarm board' }, meta: { sentFrom: 'web' } }, 'board-1', null, 15)
        store.messages.markMessagesInvoked(session.id, [boardPrompt.localId!], 15)
        const c2 = userContent('offline next turn')
        socket.trigger('session-reconcile-native-steps', {
            sid: session.id,
            nativeId: 'native-rec',
            steps: [
                { anchor: 'step:0:0', fingerprint: computeLocalTranscriptFingerprint(c0) },
                { anchor: 'step:1:text', fingerprint: computeLocalTranscriptFingerprint(c1) },
                { anchor: 'step:2:0', fingerprint: computeLocalTranscriptFingerprint(c2) }
            ]
        }, (resp) => acks.push(resp))
        expect(acks[2]).toEqual({ ok: true, status: 'needs_backfill', fromIndex: 2 })

        // Trailing uncommitted invoked user prompt matching pending step:2:0 returns diverged instead of duplicating.
        const uLive = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'offline next turn' }, meta: { sentFrom: 'web' } }, 'live-u-1', null, 16)
        store.messages.markMessagesInvoked(session.id, [uLive.localId!], 16)
        socket.trigger('session-reconcile-native-steps', {
            sid: session.id,
            nativeId: 'native-rec',
            steps: [
                { anchor: 'step:0:0', fingerprint: computeLocalTranscriptFingerprint(c0) },
                { anchor: 'step:1:text', fingerprint: computeLocalTranscriptFingerprint(c1) },
                { anchor: 'step:2:0', fingerprint: computeLocalTranscriptFingerprint(c2) }
            ]
        }, (resp) => acks.push(resp))
        expect(acks[3]).toEqual({ ok: true, status: 'diverged' })

        // Trailing uncommitted agy-live: agent row past lastRecordedSeq returns needs_reconcile with the live row for conflict verification, or diverged when disk didn't advance.
        const session2 = store.sessions.getOrCreateSession(
            'agy-reconcile-live',
            { path: '/work', host: 'h1', agyImportedAt: 100, agySessionId: 'native-rec-2' },
            null,
            'default'
        )
        const r0 = store.messages.addImportedMessage(session2.id, c0, 'agy:native-rec-2:step:0:0', 10).message
        store.nativeSteps.recordSteps(session2.id, 'native-rec-2', [
            { anchor: 'step:0:0', fingerprint: computeLocalTranscriptFingerprint(c0), messageId: r0.id }
        ])
        store.messages.addMessage(session2.id, c1, 'agy-live:agent-uncommitted', null, 12)
        socket.trigger('session-reconcile-native-steps', {
            sid: session2.id,
            nativeId: 'native-rec-2',
            steps: [
                { anchor: 'step:0:0', fingerprint: computeLocalTranscriptFingerprint(c0) },
                { anchor: 'step:1:text', fingerprint: computeLocalTranscriptFingerprint(agentContent('different native')) }
            ]
        }, (resp) => acks.push(resp))
        expect(acks[4]).toEqual({
            ok: true,
            status: 'needs_reconcile',
            fromIndex: 1,
            pendingDeliveries: [
                { kind: 'agent', localId: 'agy-live:agent-uncommitted', data: { type: 'message', message: 'second' } }
            ]
        })
        store.close()
    })

    it('reconciles legacy prefix, rejects diverged/unimported, and backfills unseen native messages atomically with broadcasts', () => {
        const { createHash } = require('node:crypto') as typeof import('node:crypto')
        const { canonicalizeLocalTranscriptContent } = require('@hapi/protocol/localTranscript') as typeof import('@hapi/protocol/localTranscript')
        const fp = (content: unknown) => createHash('sha256').update(canonicalizeLocalTranscriptContent(content)).digest('hex')

        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'agy-backfill',
            { path: '/work', host: 'h1', agyImportedAt: 100, agySessionId: 'native-bf' },
            null,
            'default'
        )
        const c0 = userContent('hello')
        const c1 = agentContent('hi')
        const c2 = userContent('offline native follow-up')
        const c3 = agentContent('offline native reply')
        store.messages.addImportedMessage(session.id, c0, 'agy:native-bf:step:0:0', 10)
        store.messages.addImportedMessage(session.id, c1, 'agy:native-bf:step:1:text', 11)

        const socket = new FakeSocket()
        const events: SyncEvent[] = []
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: (sid) => {
                const found = store.sessions.getSession(sid)
                return found ? { ok: true, value: found } : { ok: false, reason: 'not-found' }
            },
            emitAccessError() {},
            onWebappEvent: (event) => events.push(event)
        })

        // Legacy backfill detects steps 2 & 3 need backfill and seeds ledger rows 0..1.
        const acks: unknown[] = []
        socket.trigger('session-reconcile-native-steps', {
            sid: session.id,
            nativeId: 'native-bf',
            steps: [
                { anchor: 'step:0:0', fingerprint: fp(c0) },
                { anchor: 'step:1:text', fingerprint: fp(c1) },
                { anchor: 'step:2:0', fingerprint: fp(c2) },
                { anchor: 'step:3:text', fingerprint: fp(c3) }
            ]
        }, (resp) => acks.push(resp))
        expect(acks[0]).toEqual({ ok: true, status: 'needs_backfill', fromIndex: 2 })
        expect(store.nativeSteps.getSteps(session.id, 'native-bf').map((s) => s.anchor)).toEqual(['step:0:0', 'step:1:text'])

        // Wrong expectedOffset fails closed without inserting messages or advancing ledger.
        socket.trigger('session-backfill-native-messages', {
            sid: session.id,
            nativeId: 'native-bf',
            expectedOffset: 0,
            messages: [{ localId: 'agy:native-bf:step:2:0', anchor: 'step:2:0', createdAt: 20, content: c2 }]
        }, (resp) => acks.push(resp))
        expect(acks[1]).toEqual({ ok: false })
        expect(store.messages.getAllMessages(session.id)).toHaveLength(2)

        // Matching expectedOffset atomically inserts messages, records ledger entries, and broadcasts.
        socket.trigger('session-backfill-native-messages', {
            sid: session.id,
            nativeId: 'native-bf',
            expectedOffset: 2,
            messages: [
                { localId: 'agy:native-bf:step:2:0', anchor: 'step:2:0', createdAt: 20, content: c2 },
                { localId: 'agy:native-bf:step:3:text', anchor: 'step:3:text', createdAt: 21, content: c3 }
            ]
        }, (resp) => acks.push(resp))
        expect(acks[2]).toEqual({ ok: true, inserted: 2, confirmedCount: 4 })
        expect(store.messages.getAllMessages(session.id)).toHaveLength(4)
        expect(store.nativeSteps.getSteps(session.id, 'native-bf')).toHaveLength(4)
        expect(socket.roomEvents.filter((e) => e.event === 'update')).toHaveLength(2)
        expect(events.filter((e) => e.type === 'message-received')).toHaveLength(2)

        // Reconciling again returns up_to_date.
        socket.trigger('session-reconcile-native-steps', {
            sid: session.id,
            nativeId: 'native-bf',
            steps: [
                { anchor: 'step:0:0', fingerprint: fp(c0) },
                { anchor: 'step:1:text', fingerprint: fp(c1) },
                { anchor: 'step:2:0', fingerprint: fp(c2) },
                { anchor: 'step:3:text', fingerprint: fp(c3) }
            ]
        }, (resp) => acks.push(resp))
        expect(acks[3]).toEqual({ ok: true, status: 'up_to_date', confirmedCount: 4 })

        // Non-imported session or mismatched nativeId rejects reconcile and backfill.
        const plain = store.sessions.getOrCreateSession('plain', { path: '/w', host: 'h1', agySessionId: 'native-bf' }, null, 'default')
        socket.trigger('session-reconcile-native-steps', {
            sid: plain.id,
            nativeId: 'native-bf',
            steps: []
        }, (resp) => acks.push(resp))
        socket.trigger('session-backfill-native-messages', {
            sid: session.id,
            nativeId: 'native-wrong',
            expectedOffset: 4,
            messages: [{ localId: 'agy:native-wrong:step:4:0', anchor: 'step:4:0', createdAt: 30, content: c2 }]
        }, (resp) => acks.push(resp))
        expect(acks.slice(4)).toEqual([{ ok: false }, { ok: false }])
        store.close()
    })
})
