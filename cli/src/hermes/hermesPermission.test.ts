import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PermissionRequest } from '@/agent/types'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import type { HermesMode } from './types'

type FakeHermesBackend = {
    permissionHandler: ((request: PermissionRequest) => void) | null
    respondToPermission: ReturnType<typeof vi.fn>
    setMode: ReturnType<typeof vi.fn>
    setModel: ReturnType<typeof vi.fn>
    prompt: ReturnType<typeof vi.fn>
    cancelPrompt: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
    initialize: ReturnType<typeof vi.fn>
    newSession: ReturnType<typeof vi.fn>
    loadSession: ReturnType<typeof vi.fn>
    getSessionModelsMetadata: ReturnType<typeof vi.fn>
    onSessionInfoUpdate: ReturnType<typeof vi.fn>
    onStderrError: ReturnType<typeof vi.fn>
    onPermissionRequest: ReturnType<typeof vi.fn>
}

const harness = vi.hoisted(() => ({
    backends: [] as FakeHermesBackend[],
    nextPromptScript: null as null | ((
        backend: FakeHermesBackend,
        onUpdate: (msg: unknown) => void
    ) => Promise<void>)
}))

vi.mock('./utils/hermesConfiguredModels', () => ({
    resolveHermesConfigModels: vi.fn(() => null)
}))

vi.mock('./utils/hermesBackend', () => ({
    createHermesBackend: vi.fn(() => {
        const backend: (typeof harness.backends)[number] = {
            permissionHandler: null,
            initialize: vi.fn(async () => {}),
            newSession: vi.fn(async () => 'hermes-session-1'),
            loadSession: vi.fn(async (config: { sessionId: string }) => config.sessionId),
            prompt: vi.fn(async (
                _sessionId: string,
                _content: unknown[],
                onUpdate: (message: unknown) => void,
                options?: { shouldSend?: () => boolean; timing?: { onSent?: () => void } }
            ) => {
                if (options?.shouldSend && !options.shouldSend()) return false
                options?.timing?.onSent?.()
                if (harness.nextPromptScript) {
                    const script = harness.nextPromptScript
                    harness.nextPromptScript = null
                    await script(backend, onUpdate)
                } else {
                    onUpdate({ type: 'text', text: 'ok' })
                }
                return true
            }),
            cancelPrompt: vi.fn(async () => {}),
            getSessionModelsMetadata: vi.fn(() => ({ availableModels: [], currentModelId: null })),
            setModel: vi.fn(async () => {}),
            setMode: vi.fn(async () => {}),
            onSessionInfoUpdate: vi.fn(),
            onStderrError: vi.fn(),
            onPermissionRequest: vi.fn((handler: (request: PermissionRequest) => void) => {
                backend.permissionHandler = handler
            }),
            respondToPermission: vi.fn(async () => {}),
            disconnect: vi.fn(async () => {})
        }
        harness.backends.push(backend)
        return backend
    })
}))

vi.mock('@/codex/utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: vi.fn(async () => ({
        server: { stop: vi.fn() },
        mcpServers: {}
    }))
}))

vi.mock('@/agent/acpSessionTitle', () => ({
    createAcpSessionTitleSync: vi.fn(() => ({ markManualTitle: vi.fn() })),
    registerAcpSessionTitleSync: vi.fn()
}))

vi.mock('@/ui/ink/RemoteModeDisplay', () => ({ RemoteModeDisplay: () => null }))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }))

import { HermesRemoteLauncher } from './hermesRemoteLauncher'

function makeSession(permissionMode: 'default' | 'read-only' | 'safe-yolo' | 'yolo') {
    const queue = new MessageQueue2<HermesMode>((m) => JSON.stringify(m))
    const handlers = new Map<string, (params?: unknown) => Promise<unknown>>()
    let sessionId: string | null = null
    let agentState: {
        requests?: Record<string, unknown>
        completedRequests?: Record<string, unknown>
    } = {}

    const session = {
        path: '/tmp/project',
        logPath: '/tmp/hermes.log',
        get sessionId() {
            return sessionId
        },
        getPermissionMode: () => permissionMode,
        queue,
        onSessionFound: vi.fn((id: string) => {
            sessionId = id
        }),
        onThinkingChange: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn(),
        client: {
            emitSessionReady: vi.fn(),
            getAgentStateSnapshot: () => agentState,
            updateAgentState: vi.fn((updater: (state: typeof agentState) => typeof agentState) => {
                agentState = updater(agentState)
            }),
            rpcHandlerManager: {
                registerHandler: vi.fn((name: string, fn: (params?: unknown) => Promise<unknown>) => {
                    handlers.set(name, fn)
                })
            }
        }
    }

    return { session, handlers, getAgentState: () => agentState }
}

function makeCommandRequest(id: string): PermissionRequest {
    return {
        id,
        sessionId: 'hermes-session-1',
        toolCallId: `call-${id}`,
        title: 'Run shell command: rm -rf /tmp/demo',
        kind: 'execute',
        rawInput: { command: 'rm -rf /tmp/demo' },
        options: [
            { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
            { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }
        ]
    }
}

describe('HermesRemoteLauncher real ACP permission handling', () => {
    afterEach(() => {
        harness.backends = []
        harness.nextPromptScript = null
    })

    it('keeps safe-yolo permission requests interactive on initial launch and after reconnect', async () => {
        const { session, handlers, getAgentState } = makeSession('safe-yolo')
        const running = new HermesRemoteLauncher(session as never).launch()

        let releaseFirstPrompt!: () => void
        try {
            await vi.waitFor(() => expect(handlers.has('permission')).toBe(true))
            const firstBackend = harness.backends[0]!

            harness.nextPromptScript = async (backend, onUpdate) => {
                backend.permissionHandler!(makeCommandRequest('perm-safe-1'))
                await new Promise<void>((resolve) => {
                    releaseFirstPrompt = resolve
                })
                onUpdate({ type: 'text', text: 'done 1' })
            }
            session.queue.push('run command in safe-yolo', { permissionMode: 'safe-yolo' })

            await vi.waitFor(() => expect(getAgentState().requests?.['perm-safe-1']).toBeDefined())
            expect(firstBackend.setMode).toHaveBeenCalledWith('hermes-session-1', 'accept_edits')
            expect(firstBackend.respondToPermission).not.toHaveBeenCalled()

            await handlers.get('permission')!({ id: 'perm-safe-1', approved: true })
            await vi.waitFor(() => expect(firstBackend.respondToPermission).toHaveBeenCalledWith(
                'hermes-session-1',
                expect.objectContaining({ id: 'perm-safe-1' }),
                { outcome: 'selected', optionId: 'allow_once' }
            ))
            releaseFirstPrompt()

            // Force reconnect on closed transport during prompt dispatch and verify safe-yolo stays interactive.
            let releaseSecondPrompt!: () => void
            try {
                firstBackend.prompt.mockRejectedValueOnce(new Error('ACP transport is closed'))
                harness.nextPromptScript = async (backend, onUpdate) => {
                    backend.permissionHandler!(makeCommandRequest('perm-safe-2'))
                    await new Promise<void>((resolve) => {
                        releaseSecondPrompt = resolve
                    })
                    onUpdate({ type: 'text', text: 'done 2' })
                }
                session.queue.push('second turn after reconnect', { permissionMode: 'safe-yolo' })

                await vi.waitFor(() => expect(harness.backends).toHaveLength(2))
                const secondBackend = harness.backends[1]!
                await vi.waitFor(() => expect(getAgentState().requests?.['perm-safe-2']).toBeDefined())
                expect(secondBackend.respondToPermission).not.toHaveBeenCalled()

                await handlers.get('permission')!({ id: 'perm-safe-2', approved: true })
                await vi.waitFor(() => expect(secondBackend.respondToPermission).toHaveBeenCalledWith(
                    'hermes-session-1',
                    expect.objectContaining({ id: 'perm-safe-2' }),
                    { outcome: 'selected', optionId: 'allow_once' }
                ))
            } finally {
                releaseSecondPrompt?.()
            }
        } finally {
            releaseFirstPrompt?.()
            session.queue.close()
            await running
        }
    })

    it('still auto-approves command permission requests in yolo mode', async () => {
        const { session, handlers, getAgentState } = makeSession('yolo')
        const running = new HermesRemoteLauncher(session as never).launch()

        try {
            await vi.waitFor(() => expect(handlers.has('permission')).toBe(true))
            const backend = harness.backends[0]!
            harness.nextPromptScript = async (activeBackend, onUpdate) => {
                activeBackend.permissionHandler!(makeCommandRequest('perm-yolo-1'))
                onUpdate({ type: 'text', text: 'yolo done' })
            }
            session.queue.push('run command in yolo', { permissionMode: 'yolo' })

            await vi.waitFor(() => expect(backend.respondToPermission).toHaveBeenCalledWith(
                'hermes-session-1',
                expect.objectContaining({ id: 'perm-yolo-1' }),
                { outcome: 'selected', optionId: 'allow_always' }
            ))
            expect(getAgentState().requests ?? {}).toEqual({})
        } finally {
            session.queue.close()
            await running
        }
    })
})
