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
    resolveHermesConfigModels: vi.fn(() => null),
    normalizeHermesCurrentModelId: vi.fn((currentModelId: string | null | undefined) => currentModelId ?? null)
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

    it('keeps execute and untyped command requests interactive in read-only mode while auto-approving known read-only requests', async () => {
        const { session, handlers, getAgentState } = makeSession('read-only')
        const running = new HermesRemoteLauncher(session as never).launch()

        let releaseFirstPrompt!: () => void
        try {
            await vi.waitFor(() => expect(handlers.has('permission')).toBe(true))
            const firstBackend = harness.backends[0]!

            harness.nextPromptScript = async (backend, onUpdate) => {
                // Known read-only request auto-approves once.
                backend.permissionHandler!({
                    id: 'perm-ro-read',
                    sessionId: 'hermes-session-1',
                    toolCallId: 'call-ro-read',
                    title: 'Read file',
                    kind: 'read',
                    rawInput: { path: 'README.md' },
                    options: [
                        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
                        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }
                    ]
                })
                // Command request (kind: 'execute') must stay interactive.
                backend.permissionHandler!(makeCommandRequest('perm-ro-exec'))
                // Untyped command request without kind must also stay interactive.
                backend.permissionHandler!({
                    id: 'perm-ro-untyped',
                    sessionId: 'hermes-session-1',
                    toolCallId: 'call-ro-untyped',
                    title: 'Run shell command',
                    rawInput: { command: 'touch pwned' },
                    options: [
                        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
                        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }
                    ]
                })
                await new Promise<void>((resolve) => {
                    releaseFirstPrompt = resolve
                })
                onUpdate({ type: 'text', text: 'done ro 1' })
            }
            session.queue.push('run in read-only', { permissionMode: 'read-only' })

            await vi.waitFor(() => expect(firstBackend.respondToPermission).toHaveBeenCalledWith(
                'hermes-session-1',
                expect.objectContaining({ id: 'perm-ro-read' }),
                { outcome: 'selected', optionId: 'allow_once' }
            ))
            await vi.waitFor(() => {
                expect(getAgentState().requests?.['perm-ro-exec']).toBeDefined()
                expect(getAgentState().requests?.['perm-ro-untyped']).toBeDefined()
            })
            expect(firstBackend.respondToPermission).toHaveBeenCalledTimes(1)

            await handlers.get('permission')!({ id: 'perm-ro-exec', approved: false })
            await handlers.get('permission')!({ id: 'perm-ro-untyped', approved: true })
            await vi.waitFor(() => expect(firstBackend.respondToPermission).toHaveBeenCalledWith(
                'hermes-session-1',
                expect.objectContaining({ id: 'perm-ro-exec' }),
                { outcome: 'selected', optionId: 'reject_once' }
            ))
            await vi.waitFor(() => expect(firstBackend.respondToPermission).toHaveBeenCalledWith(
                'hermes-session-1',
                expect.objectContaining({ id: 'perm-ro-untyped' }),
                { outcome: 'selected', optionId: 'allow_once' }
            ))
            releaseFirstPrompt()

            // Reconnect must also keep read-only execution requests interactive.
            let releaseSecondPrompt!: () => void
            try {
                firstBackend.prompt.mockRejectedValueOnce(new Error('ACP transport is closed'))
                harness.nextPromptScript = async (backend, onUpdate) => {
                    backend.permissionHandler!(makeCommandRequest('perm-ro-reconnect'))
                    await new Promise<void>((resolve) => {
                        releaseSecondPrompt = resolve
                    })
                    onUpdate({ type: 'text', text: 'done ro 2' })
                }
                session.queue.push('second turn in read-only', { permissionMode: 'read-only' })

                await vi.waitFor(() => expect(harness.backends).toHaveLength(2))
                const secondBackend = harness.backends[1]!
                await vi.waitFor(() => expect(getAgentState().requests?.['perm-ro-reconnect']).toBeDefined())
                expect(secondBackend.respondToPermission).not.toHaveBeenCalled()

                await handlers.get('permission')!({ id: 'perm-ro-reconnect', approved: true })
                await vi.waitFor(() => expect(secondBackend.respondToPermission).toHaveBeenCalledWith(
                    'hermes-session-1',
                    expect.objectContaining({ id: 'perm-ro-reconnect' }),
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

    it('surfaces model confirmation permission requests issued during startup and reconnect setModel', async () => {
        const { session, handlers, getAgentState } = makeSession('default')
        let startupPhase = true
        let nextBackend = harness.backends[0]
        const confirmPermissionDuringSetModel = async (backend: FakeHermesBackend, permId: string) => {
            await new Promise<void>((resolve, reject) => {
                if (!backend.permissionHandler) {
                    reject(new Error('permission handler was not registered before setModel'))
                    return
                }
                backend.respondToPermission.mockImplementationOnce(async (_sid, req, response) => {
                    expect(req.id).toBe(permId)
                    expect(response).toEqual({ outcome: 'selected', optionId: 'allow_once' })
                    resolve()
                })
                backend.permissionHandler({
                    id: permId,
                    sessionId: 'hermes-session-1',
                    toolCallId: `call-${permId}`,
                    title: 'Switch model',
                    kind: 'other',
                    rawInput: { model: 'custom:magpie:qwen-plus' },
                    options: [
                        { optionId: 'allow_once', name: 'Switch anyway', kind: 'allow_once' },
                        { optionId: 'deny', name: 'Cancel', kind: 'reject_once' }
                    ]
                })
            })
        }

        const { createHermesBackend } = await import('./utils/hermesBackend')
        const createSpy = vi.mocked(createHermesBackend)
        const baseImpl = createSpy.getMockImplementation()!
        createSpy.mockImplementation(() => {
            const created = baseImpl() as unknown as FakeHermesBackend
            nextBackend = created
            created.getSessionModelsMetadata.mockImplementation(() => ({
                availableModels: [
                    { modelId: 'custom:magpie:initial', name: 'initial' },
                    { modelId: 'custom:magpie:qwen-plus', name: 'qwen-plus' }
                ],
                currentModelId: 'custom:magpie:initial'
            }))
            if (startupPhase) {
                startupPhase = false
                created.setModel.mockImplementationOnce(async () => {
                    await confirmPermissionDuringSetModel(created, 'perm-startup-model')
                })
            } else {
                created.setModel.mockImplementationOnce(async () => {
                    await confirmPermissionDuringSetModel(created, 'perm-reconnect-model')
                })
            }
            return created as unknown as ReturnType<typeof createHermesBackend>
        })

        const running = new HermesRemoteLauncher(session as never, {
            model: 'custom:magpie:qwen-plus'
        }).launch()

        try {
            await vi.waitFor(() => expect(getAgentState().requests?.['perm-startup-model']).toBeDefined())
            expect(session.client.emitSessionReady).not.toHaveBeenCalled()
            await handlers.get('permission')!({ id: 'perm-startup-model', approved: true })
            await vi.waitFor(() => expect(session.client.emitSessionReady).toHaveBeenCalledOnce())

            // Trigger transport close -> reconnect, which restores custom:magpie:qwen-plus via setModel.
            nextBackend!.prompt.mockRejectedValueOnce(new Error('ACP transport is closed'))
            session.queue.push('after reconnect', { permissionMode: 'default', model: 'custom:magpie:qwen-plus' })

            await vi.waitFor(() => expect(getAgentState().requests?.['perm-reconnect-model']).toBeDefined())
            await handlers.get('permission')!({ id: 'perm-reconnect-model', approved: true })
            await vi.waitFor(() => expect(harness.backends).toHaveLength(2))
            await vi.waitFor(() => expect(harness.backends[1]!.prompt).toHaveBeenCalledTimes(1))
        } finally {
            createSpy.mockImplementation(baseImpl)
            session.queue.close()
            await running
        }
    })
})
