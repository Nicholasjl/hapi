import { afterEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { LocalTranscript, LocalTranscriptSummary } from '@hapi/protocol/localTranscript'
import type { Machine, SyncEngine } from '../../../sync/syncEngine'
import type { WebAppEnv } from '../../middleware/auth'
import { Store } from '../../../store'
import { AGY_LOCAL_SESSION_SOURCE, CLAUDE_LOCAL_SESSION_SOURCE, CODEX_LOCAL_SESSION_SOURCE, OPENCODE_LOCAL_SESSION_SOURCE, PI_LOCAL_SESSION_SOURCE } from './sources'
import { createLocalSessionRoutes } from './createLocalSessionRoutes'
import { fetchLocalTranscriptSummaries, fetchLocalTranscriptsByIds } from './fetchLocalTranscripts'
import { computeLocalTranscriptFingerprint } from './matchAnchored'
import { registerSessionHandlers } from '../../../socket/handlers/cli/sessionHandlers'
import type { CliSocketWithData } from '../../../socket/socketTypes'

function machine(id = 'm-1', capabilities: string[] = ['local-session-import', 'agy-imported-resume']): Machine {
    return {
        id,
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: { host: `${id}.local`, platform: 'darwin', happyCliVersion: 'test', capabilities },
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 1,
        health: null
    }
}

function piSummary(): LocalTranscriptSummary {
    return {
        flavor: 'pi',
        id: 'pi-1',
        title: 'Pi session',
        lastUserMessage: 'hello',
        cwd: '/tmp/project',
        file: '/tmp/pi-1.jsonl',
        modifiedAt: 1,
        messageCount: 3,
        launch: { model: 'gemini-3.8-flash', effort: 'low' },
        extra: { model: 'gemini-3.8-flash', thinkingLevel: 'low', leafEntryId: 'e3' }
    }
}

function piTranscript(): LocalTranscript {
    return {
        ...piSummary(),
        messages: [
            {
                id: 'pi:pi-1:e1:user',
                createdAt: 1,
                content: { role: 'user', content: { type: 'text', text: 'hello' }, meta: { sentFrom: 'cli' } },
                anchor: 'e1',
                historyPoint: 'e1'
            }
        ],
        anchorOrder: ['e1'],
        cursor: 'e1'
    }
}

function harness(overrides: {
    summaries?: Array<LocalTranscriptSummary | LocalTranscript>
    transcripts?: Array<LocalTranscriptSummary | LocalTranscript>
    machineCapabilities?: string[]
    rpcError?: string
    namespace?: string
    onlineMachines?: Machine[]
    sources?: import('./sources').HubLocalSessionSource[]
} = {}) {
    const store = new Store(':memory:')
    const calls: Array<{ method: string; payload: unknown }> = []
    const appliedConfigs: Array<Record<string, unknown>> = []
    const summaries = overrides.summaries ?? [piSummary()]
    const transcripts = overrides.transcripts ?? [piTranscript()]
    const machineInstance = machine('m-1', overrides.machineCapabilities ?? ['local-session-import', 'agy-imported-resume'])
    const onlineMachines = overrides.onlineMachines ?? [machineInstance]
    const engine = {
        getOnlineMachinesByNamespace: () => onlineMachines,
        getSessionsByNamespace: () => [],
        listLocalSessionsForMachine: async (_machineId: string, payload: { flavor: string; sessionIds?: string[] | null }) => {
            calls.push({ method: 'listLocalSessions', payload })
            if (overrides.rpcError) return { success: false, error: overrides.rpcError }
            const wanted = payload.sessionIds ?? null
            const source = wanted ? transcripts : summaries
            return {
                success: true,
                sessions: wanted
                    ? source.filter((session) => 'messages' in session && (wanted as string[]).includes(session.id))
                    : source
            }
        },
        recordSessionActivity: () => {},
        handleRealtimeEvent: () => {},
        applySessionConfig: async (_sessionId: string, config: Record<string, unknown>) => {
            appliedConfigs.push(config)
        }
    } as unknown as SyncEngine
    const namespace = overrides.namespace ?? 'default'
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', namespace)
        await next()
    })
    app.route('/api', createLocalSessionRoutes({
        store,
        getSyncEngine: () => engine,
        sources: overrides.sources ?? [PI_LOCAL_SESSION_SOURCE, OPENCODE_LOCAL_SESSION_SOURCE, CODEX_LOCAL_SESSION_SOURCE]
    }))
    return { store, engine, app, calls, appliedConfigs }
}

describe('generic local session routes', () => {
    const stores: Store[] = []
    afterEach(() => {
        for (const store of stores.splice(0)) store.close()
    })

    it('lists Pi summaries with flattened extra fields and no flavor/launch keys', async () => {
        const { app } = harness()
        const response = await app.request('/api/pi/sessions')
        const body = await response.json() as { success: boolean; sessions: Array<Record<string, unknown>>; machineId?: string }
        expect(body.success).toBe(true)
        expect(body.machineId).toBe('m-1')
        expect(body.sessions[0]).toMatchObject({
            id: 'pi-1',
            model: 'gemini-3.8-flash',
            thinkingLevel: 'low',
            leafEntryId: 'e3',
            messageCount: 3
        })
        expect(body.sessions[0]).not.toHaveProperty('flavor')
        expect(body.sessions[0]).not.toHaveProperty('launch')
        expect(body.sessions[0]).not.toHaveProperty('extra')
    })

    it('annotates anchored lists with hapiSessionId and import state', async () => {
        const { app, store } = harness()
        const created = store.sessions.getOrCreateSession('tag-1', {
            flavor: 'pi',
            piSessionId: 'pi-1',
            machineId: 'm-1',
            piImportState: { state: 'diverged' }
        }, {}, 'default')
        const response = await app.request('/api/pi/sessions')
        const body = await response.json() as { sessions: Array<Record<string, unknown>> }
        expect(body.sessions[0]).toMatchObject({ hapiSessionId: created.id, importState: 'diverged' })
    })

    it('does not annotate contentPrefix lists with hapiSessionId', async () => {
        const { app, store } = harness()
        store.sessions.getOrCreateSession('tag-codex', {
            flavor: 'codex',
            codexSessionId: 'thread-1',
            machineId: 'm-1'
        }, {}, 'default')
        const response = await app.request('/api/codex/sessions')
        const body = await response.json() as { success: boolean; sessions: Array<Record<string, unknown>> }
        expect(body.success).toBe(true)
        expect(body.sessions[0]).not.toHaveProperty('hapiSessionId')
    })

    it('rejects AGY listing on an older generic-import runner before sending the RPC', async () => {
        const { app, calls, store } = harness({ sources: [AGY_LOCAL_SESSION_SOURCE], machineCapabilities: ['local-session-import'] })
        stores.push(store)
        const response = await app.request('/api/agy/sessions')
        expect(response.status).toBe(503)
        expect(calls).toEqual([])
    })

    it('returns 503 when no machine is online', async () => {
        const { app } = harness({ onlineMachines: [] })
        const response = await app.request('/api/pi/sessions')
        expect(response.status).toBe(503)
    })

    it('returns 503 with the RPC error when the machine fetch fails', async () => {
        const { app } = harness({ rpcError: 'runner exploded' })
        const response = await app.request('/api/pi/sessions')
        const body = await response.json() as { success: boolean; error: string }
        expect(response.status).toBe(503)
        expect(body.error).toBe('runner exploded')
    })

    it('imports through the generic path and preserves the legacy result id key', async () => {
        const { app, store, calls } = harness()
        const response = await app.request('/api/pi/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['pi-1'] })
        })
        const body = await response.json() as { success: boolean; results: Array<Record<string, unknown>> }
        expect(body.success).toBe(true)
        expect(body.results[0]).toMatchObject({ sessionId: 'pi-1', piSessionId: 'pi-1', action: 'created', appended: 1 })
        const session = store.sessions.getSessionsByNamespace('default')
            .find((candidate) => (candidate.metadata as Record<string, unknown>).flavor === 'pi')
        expect(session).toBeDefined()
        expect(calls[0]).toMatchObject({ method: 'listLocalSessions' })
    })

    it('rejects empty selections and enforces the flavor import limit', async () => {
        const { app } = harness()
        const empty = await app.request('/api/pi/import-sessions', { method: 'POST', body: JSON.stringify({ sessionIds: [] }) })
        expect(empty.status).toBe(400)
        const oversized = await app.request('/api/opencode/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: Array.from({ length: 201 }, (_, index) => `ses-${index}`) })
        })
        expect(oversized.status).toBe(400)
        // Pi carries the same 200 cap.
        const piOversized = await app.request('/api/pi/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: Array.from({ length: 201 }, (_, index) => `pi-${index}`) })
        })
        expect(piOversized.status).toBe(400)
    })

    it('marks a missing transcript as not_found', async () => {
        const { app } = harness()
        const response = await app.request('/api/pi/import-sessions', { method: 'POST', body: JSON.stringify({ sessionIds: ['missing'] }) })
        const body = await response.json() as { results: Array<Record<string, unknown>> }
        expect(body.results[0]).toMatchObject({ sessionId: 'missing', error: { code: 'not_found' } })
    })

    it('stops the codex batch on the first error', async () => {
        const { app } = harness()
        const response = await app.request('/api/codex/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['missing-1', 'missing-2'] })
        })
        const body = await response.json() as { results: Array<Record<string, unknown>> }
        expect(body.results).toHaveLength(1)
        expect(body.results[0]).toMatchObject({ error: { code: 'not_found' } })
    })

    it('applies the requested Claude model, effort and permission mode to the import', async () => {
        const claude: LocalTranscript = {
            flavor: 'claude',
            id: 'claude-1',
            title: 'Claude session',
            lastUserMessage: 'hello',
            cwd: '/tmp/project',
            file: '/tmp/claude-1.jsonl',
            modifiedAt: 1,
            messages: [{
                id: 'claude:u1',
                createdAt: 1,
                content: { role: 'user', content: { type: 'text', text: 'hello' }, meta: { sentFrom: 'cli' } },
                anchor: 'u1'
            }]
        }
        const { app, store, appliedConfigs } = harness({ sources: [CLAUDE_LOCAL_SESSION_SOURCE], summaries: [claude], transcripts: [claude] })
        stores.push(store)
        const response = await app.request('/api/claude/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['claude-1'], model: 'opus', effort: 'high', permissionMode: 'plan' })
        })
        const body = await response.json() as { results: Array<Record<string, unknown>> }
        expect(body.results[0]).toMatchObject({ claudeSessionId: 'claude-1', action: 'created' })
        expect(appliedConfigs).toEqual([{ model: 'opus', effort: 'high', permissionMode: 'plan' }])
    })

    it('enforces the claude import limit with a 400 before any RPC', async () => {
        const { app, calls } = harness({ sources: [CLAUDE_LOCAL_SESSION_SOURCE] })
        const response = await app.request('/api/claude/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: Array.from({ length: 201 }, (_, index) => `claude-${index}`) })
        })
        expect(response.status).toBe(400)
        const body = await response.json() as { success: boolean; error?: string }
        expect(body.success).toBe(false)
        expect(body.error).toContain('200')
        expect(calls).toHaveLength(0)
    })

    it('lists and imports local Antigravity sessions with permissionMode and model', async () => {
        const agySummary: LocalTranscriptSummary = {
            flavor: 'agy',
            id: 'agy-1',
            title: 'Antigravity session',
            lastUserMessage: 'hello agy',
            cwd: '/tmp/agy-project',
            file: '/tmp/.gemini/antigravity-cli/brain/agy-1/.system_generated/logs/transcript.jsonl',
            modifiedAt: 10
        }
        const agyTranscript: LocalTranscript = {
            ...agySummary,
            messages: [{
                id: 'agy:agy-1:step:0:0',
                createdAt: 10,
                content: { role: 'user', content: { type: 'text', text: 'hello agy' }, meta: { sentFrom: 'cli' } },
                anchor: 'step:0:0'
            }]
        }
        const { app, store, appliedConfigs } = harness({
            sources: [AGY_LOCAL_SESSION_SOURCE],
            summaries: [agySummary],
            transcripts: [agyTranscript]
        })
        stores.push(store)

        const listRes = await app.request('/api/agy/sessions')
        expect(listRes.status).toBe(200)
        const listBody = await listRes.json() as { success: boolean; sessions: Array<Record<string, unknown>> }
        expect(listBody.success).toBe(true)
        expect(listBody.sessions).toHaveLength(1)
        expect(listBody.sessions[0]).toMatchObject({ id: 'agy-1', title: 'Antigravity session' })

        const importRes = await app.request('/api/agy/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['agy-1'], model: 'gemini-3-pro', effort: 'high', permissionMode: 'request-review' })
        })
        expect(importRes.status).toBe(200)
        const importBody = await importRes.json() as { success: boolean; results: Array<Record<string, unknown>> }
        expect(importBody.success).toBe(true)
        expect(importBody.results[0]).toMatchObject({ agySessionId: 'agy-1', action: 'created', appended: 1 })
        expect(appliedConfigs).toEqual([{ model: 'gemini-3-pro', effort: 'high', permissionMode: 'request-review' }])

        const secondListRes = await app.request('/api/agy/sessions')
        const secondListBody = await secondListRes.json() as { sessions: Array<Record<string, unknown>> }
        expect(secondListBody.sessions[0]).toMatchObject({ id: 'agy-1', hapiSessionId: importBody.results[0]!.hapiSessionId })
    })

    it('refuses transcript-only Antigravity imports without a working directory instead of saving .system_generated/logs', async () => {
        const agySummary: LocalTranscriptSummary = {
            flavor: 'agy',
            id: 'agy-no-cwd',
            title: 'No workspace session',
            lastUserMessage: 'hi',
            cwd: null,
            file: '/tmp/.gemini/antigravity-cli/brain/agy-no-cwd/.system_generated/logs/transcript.jsonl',
            modifiedAt: 10
        }
        const agyTranscript: LocalTranscript = {
            ...agySummary,
            messages: [{
                id: 'agy:agy-no-cwd:step:0:0',
                createdAt: 10,
                content: { role: 'user', content: { type: 'text', text: 'hi' }, meta: { sentFrom: 'cli' } },
                anchor: 'step:0:0'
            }]
        }
        const { app, store } = harness({
            sources: [AGY_LOCAL_SESSION_SOURCE],
            summaries: [agySummary],
            transcripts: [agyTranscript]
        })
        stores.push(store)

        const res = await app.request('/api/agy/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['agy-no-cwd'] })
        })
        expect(res.status).toBe(200)
        const body = await res.json() as { success: boolean; results: Array<{ error?: { code: string } }> }
        expect(body.success).toBe(false)
        expect(body.results[0]?.error?.code).toBe('missing_cwd')
        expect(store.sessions.getSessionsByNamespace('default')).toHaveLength(0)
    })

    it('appends late action steps onto an already-imported Antigravity session without divergence', async () => {
        const baseSummary: LocalTranscriptSummary = {
            flavor: 'agy',
            id: 'agy-grow',
            title: 'Growing session',
            lastUserMessage: 'run checks',
            cwd: '/tmp/agy-project',
            file: '/tmp/.gemini/antigravity-cli/brain/agy-grow/.system_generated/logs/transcript.jsonl',
            modifiedAt: 10
        }
        const plannerCall0 = {
            id: 'agy:agy-grow:step:1:call:0',
            createdAt: 11,
            content: { role: 'agent', content: { type: 'codex', data: { type: 'tool-call', name: 'Read', callId: 'c0', input: { file_path: 'a.ts' }, status: 'completed' } }, meta: { sentFrom: 'cli' } },
            anchor: 'step:1:call:0'
        } as const
        const plannerCall1 = {
            id: 'agy:agy-grow:step:1:call:1',
            createdAt: 11,
            content: { role: 'agent', content: { type: 'codex', data: { type: 'tool-call', name: 'Read', callId: 'c1', input: { file_path: 'b.ts' }, status: 'completed' } }, meta: { sentFrom: 'cli' } },
            anchor: 'step:1:call:1'
        } as const
        const initial: LocalTranscript = { ...baseSummary, messages: [plannerCall0, plannerCall1] }
        const grown: LocalTranscript = {
            ...baseSummary,
            messages: [
                plannerCall0,
                plannerCall1,
                {
                    id: 'agy:agy-grow:step:2:0',
                    createdAt: 12,
                    content: { role: 'agent', content: { type: 'codex', data: { type: 'tool-call-result', callId: 'c0', output: 'file A', is_error: false } }, meta: { sentFrom: 'cli' } },
                    anchor: 'step:2:0'
                }
            ]
        }
        let current = initial
        const store = new Store(':memory:')
        stores.push(store)
        const engine = {
            getOnlineMachinesByNamespace: () => [machine()],
            listLocalSessionsForMachine: async (_machineId: string, payload: { sessionIds?: string[] | null }) => {
                if (payload.sessionIds) return { success: true, sessions: [current] }
                const { messages: _messages, ...summary } = current
                return { success: true, sessions: [summary] }
            },
            recordSessionActivity: () => {},
            handleRealtimeEvent: () => {},
            applySessionConfig: async () => {}
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createLocalSessionRoutes({ store, getSyncEngine: () => engine, sources: [AGY_LOCAL_SESSION_SOURCE] }))

        const first = await (await app.request('/api/agy/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['agy-grow'] })
        })).json() as { results: Array<Record<string, unknown>> }
        expect(first.results[0]).toMatchObject({ action: 'created', appended: 2 })

        current = grown
        const second = await (await app.request('/api/agy/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['agy-grow'] })
        })).json() as { results: Array<Record<string, unknown>> }
        expect(second.results[0]).toMatchObject({ agySessionId: 'agy-grow', action: 'updated', appended: 1 })
    })

    it('uses body cwd on first import of a transcript-only Antigravity session and preserves it on re-import from another directory', async () => {
        const initial: LocalTranscript = {
            flavor: 'agy',
            id: 'agy-no-cwd',
            title: 'Transcript-only session',
            lastUserMessage: 'first prompt',
            cwd: null,
            file: '/tmp/.gemini/antigravity-cli/brain/agy-no-cwd/.system_generated/logs/transcript.jsonl',
            modifiedAt: 10,
            messages: [
                { id: 'agy:agy-no-cwd:step:0:0', createdAt: 10, content: { role: 'user', content: { type: 'text', text: 'first prompt' }, meta: { sentFrom: 'cli' } }, anchor: 'step:0:0' }
            ]
        }
        const grown: LocalTranscript = {
            ...initial,
            lastUserMessage: 'second prompt',
            modifiedAt: 20,
            messages: [
                ...initial.messages,
                { id: 'agy:agy-no-cwd:step:1:0', createdAt: 20, content: { role: 'user', content: { type: 'text', text: 'second prompt' }, meta: { sentFrom: 'cli' } }, anchor: 'step:1:0' }
            ]
        }
        let current = initial
        const store = new Store(':memory:')
        stores.push(store)
        const engine = {
            getOnlineMachinesByNamespace: () => [machine()],
            listLocalSessionsForMachine: async (_machineId: string, payload: { sessionIds?: string[] | null }) => {
                if (payload.sessionIds) return { success: true, sessions: [current] }
                const { messages: _messages, ...summary } = current
                return { success: true, sessions: [summary] }
            },
            recordSessionActivity: () => {},
            handleRealtimeEvent: () => {},
            applySessionConfig: async () => {}
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createLocalSessionRoutes({ store, getSyncEngine: () => engine, sources: [AGY_LOCAL_SESSION_SOURCE] }))

        const first = await (await app.request('/api/agy/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['agy-no-cwd'], cwd: '/proj-a' })
        })).json() as { results: Array<{ hapiSessionId?: string; action?: string }> }
        expect(first.results[0]).toMatchObject({ action: 'created' })
        const sessionId = first.results[0]!.hapiSessionId!
        expect((store.sessions.getSessionByNamespace(sessionId, 'default')?.metadata as { path?: string }).path).toBe('/proj-a')

        current = grown
        const second = await (await app.request('/api/agy/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['agy-no-cwd'], cwd: '/proj-b' })
        })).json() as { results: Array<{ hapiSessionId?: string; action?: string; appended?: number }> }
        expect(second.results[0]).toMatchObject({ hapiSessionId: sessionId, action: 'updated', appended: 1 })
        expect((store.sessions.getSessionByNamespace(sessionId, 'default')?.metadata as { path?: string }).path).toBe('/proj-a')

        const listed = await (await app.request('/api/agy/sessions')).json() as {
            sessions: Array<{ id: string; cwd: string | null; savedCwd?: string; hapiSessionId?: string }>
        }
        expect(listed.sessions[0]).toMatchObject({
            id: 'agy-no-cwd',
            cwd: null,
            savedCwd: '/proj-a',
            hapiSessionId: sessionId
        })
    })

    it('keeps a mixed Antigravity batch going when one transcript is still flushing, requires a matching live prefix on re-import, and does not apply fallbackCwd to Claude', async () => {
        const makeAgyTranscript = (id: string): LocalTranscript => ({
            flavor: 'agy',
            id,
            title: `Antigravity ${id}`,
            lastUserMessage: 'first prompt',
            cwd: '/work',
            file: `/tmp/.gemini/antigravity-cli/brain/${id}/.system_generated/logs/transcript.jsonl`,
            modifiedAt: 10,
            messages: [
                {
                    id: `agy:${id}:step:0:user`,
                    createdAt: 10,
                    content: { role: 'user', content: { type: 'text', text: 'first prompt' }, meta: { sentFrom: 'cli' } },
                    anchor: 'step:0:user'
                }
            ]
        })
        const flushing: LocalTranscript = {
            ...makeAgyTranscript('agy-flushing'),
            messages: [],
            extra: { importError: 'Antigravity full transcript is still flushing; please retry import shortly' }
        }
        let agyContinued: LocalTranscript = makeAgyTranscript('agy-continued')
        const claudeNullCwd: LocalTranscript = {
            flavor: 'claude',
            id: 'claude-null-cwd',
            title: 'Claude without cwd',
            lastUserMessage: 'hello claude',
            cwd: null,
            file: '/claude-projects/my-proj/claude-null-cwd.jsonl',
            modifiedAt: 10,
            messages: [
                {
                    id: 'claude:uuid-1',
                    createdAt: 10,
                    content: { role: 'user', content: { type: 'text', text: 'hello claude' }, meta: { sentFrom: 'cli' } }
                }
            ]
        }
        const store = new Store(':memory:')
        stores.push(store)
        const engine = {
            getOnlineMachinesByNamespace: () => [machine()],
            listLocalSessionsForMachine: async (_machineId: string, payload: { flavor: string }) => ({
                success: true,
                sessions: payload.flavor === 'claude' ? [claudeNullCwd] : [flushing, agyContinued]
            }),
            recordSessionActivity: () => {},
            handleRealtimeEvent: () => {},
            applySessionConfig: async () => {}
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createLocalSessionRoutes({
            store,
            getSyncEngine: () => engine,
            sources: [AGY_LOCAL_SESSION_SOURCE, CLAUDE_LOCAL_SESSION_SOURCE]
        }))

        const batchRes = await (await app.request('/api/agy/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['agy-flushing', 'agy-continued'], cwd: '/work' })
        })).json() as {
            success: boolean
            results: Array<{ agySessionId: string; hapiSessionId?: string; action?: string; error?: { code: string; message: string } }>
        }
        expect(batchRes.success).toBe(false)
        expect(batchRes.results).toEqual([
            expect.objectContaining({
                agySessionId: 'agy-flushing',
                error: {
                    code: 'transcript_flushing',
                    message: 'Antigravity full transcript is still flushing; please retry import shortly'
                }
            }),
            expect.objectContaining({
                agySessionId: 'agy-continued',
                action: 'created'
            })
        ])
        const hapiId = batchRes.results[1]!.hapiSessionId!

        const prompt = { type: 'text', text: 'live follow-up' } as const
        store.messages.addMessage(hapiId, { role: 'user', content: prompt, meta: { sentFrom: 'web' } }, 'live')
        store.messages.markMessagesInvoked(hapiId, ['live'], 20)
        store.messages.addMessage(hapiId, {
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'reasoning', message: 'Checking workspace files', id: 'acp-generated-reasoning-uuid' }
            }
        })
        store.messages.addMessage(hapiId, {
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'tool-call',
                    callId: 'acp_call_1',
                    name: 'Bash',
                    input: { command: 'ls -la' },
                    status: 'in_progress',
                    nativeTitle: 'ls -la',
                    nativeKind: 'execute'
                }
            }
        })
        store.messages.addMessage(hapiId, {
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'tool-call-result',
                    callId: 'acp_call_1',
                    output: { stdout: 'README.md', exit_code: 0 }
                }
            }
        })
        store.messages.addMessage(hapiId, {
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'message', message: 'Found README.md', id: 'acp-text-stream-uuid' }
            }
        })
        store.messages.addMessage(hapiId, {
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'round-summary',
                    summary: { provider: 'agy', model: 'gemini-3-pro', duration_ms: 1200 }
                }
            }
        })
        const native = (id: string, text: string) => ({
            id: `agy:agy-continued:${id}`, createdAt: 20, anchor: id,
            content: { role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'cli' } } as const
        })
        const nativeAgent = (id: string, data: Record<string, unknown>) => ({
            id: `agy:agy-continued:${id}`, createdAt: 20, anchor: id,
            content: { role: 'agent', content: { type: 'codex', data }, meta: { sentFrom: 'cli' } } as const
        })
        const nativeTurn = (userText: string, stdout = 'README.md') => [
            native('step:1:0', userText),
            nativeAgent('step:2:reasoning', {
                type: 'reasoning',
                message: 'Checking workspace files',
                id: 'agy:agy-continued:step:2:reasoning'
            }),
            nativeAgent('step:2:call:0', {
                type: 'tool-call',
                callId: 'agy-wakeup-agy-continued-2-0',
                name: 'Bash',
                input: { command: 'ls -la' },
                status: 'completed',
                nativeTitle: 'run_command'
            }),
            nativeAgent('step:3:0', {
                type: 'tool-call-result',
                callId: 'agy-wakeup-agy-continued-2-0',
                output: { stdout, exit_code: 0 }
            }),
            nativeAgent('step:4:text', {
                type: 'message',
                message: 'Found README.md'
            })
        ]
        store.nativeSteps.recordSteps(
            hapiId,
            'agy-continued',
            nativeTurn(prompt.text).map((message) => ({
                anchor: message.anchor,
                fingerprint: computeLocalTranscriptFingerprint(message.content)
            }))
        )
        const initial = agyContinued.messages
        const sync = async () => (await app.request('/api/agy/import-sessions', {
            method: 'POST', body: JSON.stringify({ sessionIds: ['agy-continued'], cwd: '/work' })
        })).json() as Promise<{ results: Array<{ action?: string; appended?: number; error?: { code: string } }> }>
        agyContinued = { ...agyContinued, messages: [...initial, ...nativeTurn(prompt.text), native('tail', 'external')] }
        expect((await sync()).results[0]).toMatchObject({ hapiSessionId: hapiId, appended: 1 })
        expect((await sync()).results[0]).toMatchObject({ hapiSessionId: hapiId, appended: 0 })
        const prior = store.messages.getAllMessages(hapiId)
        agyContinued = { ...agyContinued, messages: [...initial, ...nativeTurn(prompt.text, 'DIFFERENT.md'), native('tail', 'external')] }
        expect((await sync()).results[0]?.error?.code).toBe('transcript_diverged')
        agyContinued = { ...agyContinued, messages: [...initial, ...nativeTurn('different'), native('tail', 'external')] }
        expect((await sync()).results[0]?.error?.code).toBe('transcript_diverged')
        expect(store.messages.getAllMessages(hapiId)).toEqual(prior)
        expect(store.sessions.getSessionsByNamespace('default')).toHaveLength(1)

        // Claude with cwd: null keeps dirname(transcript.file) instead of request fallbackCwd.
        const claudeRes = await (await app.request('/api/claude/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['claude-null-cwd'], cwd: '/form-unrelated-dir' })
        })).json() as { success: boolean; results: Array<{ hapiSessionId?: string }> }
        expect(claudeRes.success).toBe(true)
        const claudeHapiId = claudeRes.results[0]!.hapiSessionId!
        expect((store.sessions.getSessionByNamespace(claudeHapiId, 'default')?.metadata as { path?: string }).path)
            .toBe('/claude-projects/my-proj')
    })

    it('keeps imported Antigravity sessions with the same native ID distinct across two machines', async () => {
        const store = new Store(':memory:')
        stores.push(store)
        const m1 = machine('m-1')
        const m2 = machine('m-2')
        const engine = {
            getOnlineMachinesByNamespace: () => [m1, m2],
            listLocalSessionsForMachine: async (machineId: string) => ({
                success: true,
                sessions: [{
                    flavor: 'agy' as const,
                    id: 'agy-shared-conv',
                    title: 'Shared conv',
                    lastUserMessage: `from ${machineId}`,
                    cwd: '/work',
                    file: '/tmp/.gemini/antigravity-cli/brain/agy-shared-conv/.system_generated/logs/transcript.jsonl',
                    modifiedAt: 10,
                    messages: [{
                        id: 'agy:agy-shared-conv:step:0:user',
                        createdAt: 10,
                        content: { role: 'user', content: { type: 'text', text: `from ${machineId}` }, meta: { sentFrom: 'cli' } },
                        anchor: 'step:0:user'
                    }]
                }]
            }),
            recordSessionActivity: () => {},
            handleRealtimeEvent: () => {},
            applySessionConfig: async () => {}
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createLocalSessionRoutes({
            store,
            getSyncEngine: () => engine,
            sources: [AGY_LOCAL_SESSION_SOURCE]
        }))

        const importM1 = await (await app.request('/api/agy/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['agy-shared-conv'], machineId: 'm-1', cwd: '/work' })
        })).json() as { results: Array<{ hapiSessionId?: string; action?: string }> }
        const importM2 = await (await app.request('/api/agy/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['agy-shared-conv'], machineId: 'm-2', cwd: '/work' })
        })).json() as { results: Array<{ hapiSessionId?: string; action?: string }> }

        const hapiM1 = importM1.results[0]!.hapiSessionId!
        const hapiM2 = importM2.results[0]!.hapiSessionId!
        expect(hapiM1).not.toBe(hapiM2)
        expect(store.messages.getAllMessages(hapiM1)[0]?.content).toMatchObject({
            content: { text: 'from m-1' }
        })
        expect(store.messages.getAllMessages(hapiM2)[0]?.content).toMatchObject({
            content: { text: 'from m-2' }
        })
    })

    it('re-imports queued, out-of-seq-order, and batched ACP turns backed by the native step ledger across multiple sync rounds', async () => {
        const store = new Store(':memory:')
        stores.push(store)
        const baseMsg = (id: string, text: string, createdAt = 10) => ({
            id: `agy:agy-batch:${id}`,
            createdAt,
            content: { role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'cli' } } as const,
            anchor: id
        })
        const nativeAgent = (id: string, data: Record<string, unknown>, createdAt = 10) => ({
            id: `agy:agy-batch:${id}`,
            createdAt,
            content: { role: 'agent', content: { type: 'codex', data }, meta: { sentFrom: 'cli' } } as const,
            anchor: id
        })

        let agySession = {
            flavor: 'agy' as const,
            id: 'agy-batch',
            title: 'Batch re-import',
            lastUserMessage: 'initial prompt',
            cwd: '/work',
            file: '/tmp/.gemini/antigravity-cli/brain/agy-batch/.system_generated/logs/transcript.jsonl',
            modifiedAt: 10,
            messages: [
                baseMsg('step:0:user', 'initial prompt', 10),
                nativeAgent('step:0:agent', { type: 'message', message: 'initial reply' }, 11)
            ]
        }

        const engine = {
            getOnlineMachinesByNamespace: () => [machine()],
            listLocalSessionsForMachine: async () => ({ success: true, sessions: [agySession] }),
            recordSessionActivity: () => {},
            handleRealtimeEvent: () => {},
            applySessionConfig: async () => {}
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createLocalSessionRoutes({
            store,
            getSyncEngine: () => engine,
            sources: [AGY_LOCAL_SESSION_SOURCE]
        }))

        const initRes = await (await app.request('/api/agy/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['agy-batch'], cwd: '/work' })
        })).json() as { results: Array<{ hapiSessionId?: string; action?: string }> }
        expect(initRes.results[0]?.action).toBe('created')
        const hapiId = initRes.results[0]!.hapiSessionId!

        // HAPI stores interleaved queued/batched live messages plus oversized >64KB output.
        store.messages.addMessage(hapiId, { role: 'user', content: { type: 'text', text: 'first live turn' }, meta: { sentFrom: 'web' } }, 'u1', null, 20)
        store.messages.markMessagesInvoked(hapiId, ['u1'], 20)
        store.messages.addMessage(hapiId, {
            role: 'agent',
            content: { type: 'codex', data: { type: 'reasoning', message: 'Thinking', id: 'acp-r1' } }
        }, undefined, null, 21)
        store.messages.addMessage(hapiId, { role: 'user', content: { type: 'text', text: 'queued during reply' }, meta: { sentFrom: 'web' } }, 'u2', null, 22)
        store.messages.addMessage(hapiId, {
            role: 'agent',
            content: { type: 'codex', data: { type: 'message', message: 'first reply' } }
        }, undefined, null, 25)
        store.messages.markMessagesInvoked(hapiId, ['u2'], 30)
        store.messages.addMessage(hapiId, {
            role: 'agent',
            content: { type: 'codex', data: { type: 'message', message: 'second reply' } }
        }, undefined, null, 35)
        store.messages.addMessage(hapiId, {
            role: 'user',
            content: {
                type: 'text',
                text: 'Inspect attachment',
                attachments: [
                    { path: '.hapi/uploads/spec.md', mimeType: 'text/markdown' },
                    { path: '.hapi/uploads/shot.png', mimeType: 'image/png' }
                ]
            },
            meta: { sentFrom: 'web' }
        }, 'u3-a', null, 36)
        store.messages.addMessage(hapiId, {
            role: 'user',
            content: { type: 'text', text: 'And check tests' },
            meta: { sentFrom: 'web' }
        }, 'u3-b', null, 37)
        store.messages.markMessagesInvoked(hapiId, ['u3-a', 'u3-b'], 40)
        store.messages.addMessage(hapiId, {
            role: 'agent',
            content: { type: 'codex', data: { type: 'message', message: 'batch reply' } }
        }, undefined, null, 45)
        store.messages.addMessage(hapiId, { role: 'user', content: { type: 'text', text: 'still queued' }, meta: { sentFrom: 'web' } }, 'u4-pending', null, 50)

        const bigToolOutput = `Exit 0\n${'L'.repeat(70_000)}END`
        const livePrefixInNative = [
            baseMsg('step:1:0', 'first live turn', 20),
            nativeAgent('step:2:reasoning', { type: 'reasoning', message: 'Thinking', id: 'agy:agy-batch:step:2:reasoning' }, 21),
            nativeAgent('step:2:text', { type: 'message', message: 'first reply' }, 25),
            baseMsg('step:3:0', 'queued during reply', 30),
            nativeAgent('step:4:text', { type: 'message', message: 'second reply' }, 35),
            baseMsg('step:5:0', '@.hapi/uploads/spec.md\n\nInspect attachment\nAnd check tests', 40),
            nativeAgent('step:6:0', { type: 'tool-call-result', callId: 'c1', output: bigToolOutput, is_error: false }, 42),
            nativeAgent('step:6:text', { type: 'message', message: 'batch reply' }, 45)
        ]
        // Runner incrementally persisted confirmed live native steps into the SQLite ledger.
        store.nativeSteps.recordSteps(
            hapiId,
            'agy-batch',
            livePrefixInNative.map((message) => ({
                anchor: message.anchor,
                fingerprint: computeLocalTranscriptFingerprint(message.content)
            }))
        )

        const nativeTail = [
            baseMsg('step:7:0', 'native follow-up', 60),
            nativeAgent('step:8:text', { type: 'message', message: 'native answer' }, 61)
        ]
        const initial = agySession.messages
        agySession = { ...agySession, messages: [...initial, ...livePrefixInNative, ...nativeTail] }

        const sync = async () => (await app.request('/api/agy/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['agy-batch'], cwd: '/work' })
        })).json() as Promise<{ results: Array<{ hapiSessionId?: string; action?: string; appended?: number; error?: { code: string } }> }>

        const firstSync = await sync()
        expect(firstSync.results[0]).toMatchObject({ hapiSessionId: hapiId, action: 'updated', appended: 2 })
        const countAfterFirstSync = store.messages.getAllMessages(hapiId).length
        expect(store.messages.getAllMessages(hapiId).filter((m) => m.localId === 'agy:agy-batch:step:7:0')).toHaveLength(1)
        expect(store.messages.getAllMessages(hapiId).filter((m) => m.localId === 'agy:agy-batch:step:8:text')).toHaveLength(1)

        // Second re-import is idempotent and preserves all recorded steps including oversized output.
        const secondSync = await sync()
        expect(secondSync.results[0]).toMatchObject({ hapiSessionId: hapiId, action: 'unchanged', appended: 0 })
        expect(store.messages.getAllMessages(hapiId)).toHaveLength(countAfterFirstSync)

        // Subsequent native continuation appends strictly after step:8:text.
        const roundTwoTail = [baseMsg('step:9:0', 'second native follow-up', 70)]
        agySession = { ...agySession, messages: [...initial, ...livePrefixInNative, ...nativeTail, ...roundTwoTail] }
        expect((await sync()).results[0]).toMatchObject({ hapiSessionId: hapiId, action: 'updated', appended: 1 })

        // Altering a confirmed native step reports transcript_diverged.
        agySession = {
            ...agySession,
            messages: [
                ...initial,
                ...livePrefixInNative.slice(0, 5),
                baseMsg('step:5:0', 'Inspect attachment\nAnd check tests', 40),
                livePrefixInNative[6]!,
                nativeAgent('step:6:text', { type: 'message', message: 'batch reply' }, 45),
                ...nativeTail,
                ...roundTwoTail
            ]
        }
        expect((await sync()).results[0]?.error?.code).toBe('transcript_diverged')
    })

    it('reconciles completed steer command output vs native background placeholder, /swarm board, and pre-dispatch restores via the ledger', async () => {
        const store = new Store(':memory:')
        stores.push(store)
        const nativeUser = (id: string, text: string, createdAt = 10) => ({
            id: `agy:agy-prov:${id}`,
            createdAt,
            content: { role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'cli' } } as const,
            anchor: id
        })
        const nativeAgent = (id: string, data: Record<string, unknown>, createdAt = 10) => ({
            id: `agy:agy-prov:${id}`,
            createdAt,
            content: { role: 'agent', content: { type: 'codex', data }, meta: { sentFrom: 'cli' } } as const,
            anchor: id
        })

        let agySession = {
            flavor: 'agy' as const,
            id: 'agy-prov',
            title: 'Provenance re-import',
            lastUserMessage: 'initial prompt',
            cwd: '/work',
            file: '/tmp/.gemini/antigravity-cli/brain/agy-prov/.system_generated/logs/transcript.jsonl',
            modifiedAt: 10,
            messages: [
                nativeUser('step:0:0', 'initial prompt', 10),
                nativeAgent('step:1:text', { type: 'message', message: 'initial answer' }, 11)
            ]
        }

        const engine = {
            getOnlineMachinesByNamespace: () => [machine()],
            listLocalSessionsForMachine: async () => ({ success: true, sessions: [agySession] }),
            recordSessionActivity: () => {},
            handleRealtimeEvent: () => {},
            applySessionConfig: async () => {}
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createLocalSessionRoutes({
            store,
            getSyncEngine: () => engine,
            sources: [AGY_LOCAL_SESSION_SOURCE]
        }))

        const created = await (await app.request('/api/agy/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['agy-prov'], cwd: '/work' })
        })).json() as { results: Array<{ hapiSessionId?: string }> }
        const hapiId = created.results[0]!.hapiSessionId!

        // HAPI stores /swarm board, pre-dispatch abort-restore, and completed background steer output.
        store.messages.addMessage(hapiId, { role: 'user', content: { type: 'text', text: '/swarm board' }, meta: { sentFrom: 'web' } }, 'board-1', null, 20)
        store.messages.markMessagesInvoked(hapiId, ['board-1'], 20)
        store.messages.addMessage(hapiId, {
            role: 'agent',
            content: { type: 'codex', data: { type: 'message', message: '### Swarm Board' } }
        }, undefined, null, 21)
        store.messages.addMessage(hapiId, { role: 'user', content: { type: 'text', text: 'failed pre-dispatch' }, meta: { sentFrom: 'web' } }, 'restore-1', null, 22)
        store.messages.markMessagesInvoked(hapiId, ['restore-1'], 22)
        store.messages.addMessage(hapiId, { role: 'user', content: { type: 'text', text: 'real dispatched turn' }, meta: { sentFrom: 'web' } }, 'real-1', null, 30)
        store.messages.markMessagesInvoked(hapiId, ['real-1'], 30)
        store.messages.addMessage(hapiId, {
            role: 'agent',
            content: { type: 'codex', data: { type: 'tool-call', name: 'Bash', callId: 'live-cmd-1', input: { command: 'sleep 2' } } }
        }, undefined, null, 31)
        store.messages.addMessage(hapiId, {
            role: 'agent',
            content: { type: 'codex', data: { type: 'tool-call-result', callId: 'live-cmd-1', output: { stdout: 'finished on steer', exit_code: 0 }, is_error: false } }
        }, undefined, null, 32)
        store.messages.addMessage(hapiId, {
            role: 'agent',
            content: { type: 'codex', data: { type: 'message', message: 'real reply' } }
        }, undefined, null, 35)

        // Meanwhile native step:4:0 retains AGY_BACKGROUND_COMMAND_RESULT ('Command moved to background.').
        const nativeLivePrefix = [
            nativeUser('step:2:0', 'real dispatched turn', 30),
            nativeAgent('step:3:call:0', { type: 'tool-call', name: 'Bash', callId: 'agy-wakeup-agy-prov-3-0', input: { command: 'sleep 2' } }, 31),
            nativeAgent('step:4:0', { type: 'tool-call-result', callId: 'agy-wakeup-agy-prov-3-0', output: 'Command moved to background.', is_error: false }, 32),
            nativeAgent('step:5:text', { type: 'message', message: 'real reply' }, 35)
        ]
        store.nativeSteps.recordSteps(
            hapiId,
            'agy-prov',
            nativeLivePrefix.map((message) => ({
                anchor: message.anchor,
                fingerprint: computeLocalTranscriptFingerprint(message.content)
            }))
        )

        const nativeTail = [
            nativeUser('step:6:0', 'continued in cli', 50),
            nativeAgent('step:7:text', { type: 'message', message: 'cli response' }, 55)
        ]
        const initial = agySession.messages
        agySession = { ...agySession, messages: [...initial, ...nativeLivePrefix, ...nativeTail] }

        const sync = async () => (await app.request('/api/agy/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['agy-prov'], cwd: '/work' })
        })).json() as Promise<{ results: Array<{ hapiSessionId?: string; action?: string; appended?: number; error?: { code: string } }> }>

        const first = await sync()
        expect(first.results[0]).toMatchObject({ hapiSessionId: hapiId, action: 'updated', appended: 2 })
        const msgsAfterFirst = store.messages.getAllMessages(hapiId)
        expect(msgsAfterFirst.filter((m) => m.localId === 'agy:agy-prov:step:6:0')).toHaveLength(1)
        expect(msgsAfterFirst.some((m) => m.localId === 'board-1')).toBe(true)
        expect(msgsAfterFirst.some((m) => m.localId === 'restore-1')).toBe(true)

        // Second re-import must be idempotent even with interleaved /swarm board, restore, and background command divergence.
        const second = await sync()
        expect(second.results[0]).toMatchObject({ hapiSessionId: hapiId, action: 'unchanged', appended: 0 })
        expect(store.messages.getAllMessages(hapiId)).toHaveLength(msgsAfterFirst.length)

        // Tampering a confirmed native step or dropping one diverges cleanly.
        agySession = {
            ...agySession,
            messages: [
                ...initial,
                nativeUser('step:2:0', 'tampered dispatched turn', 30),
                ...nativeLivePrefix.slice(1),
                ...nativeTail
            ]
        }
        expect((await sync()).results[0]?.error?.code).toBe('transcript_diverged')
    })

    it('backfills native step ledger entries for legacy imported AGY sessions without prior ledger rows', async () => {
        const store = new Store(':memory:')
        stores.push(store)
        const s0 = {
            id: 'agy:agy-legacy:step:0:0',
            createdAt: 10,
            content: { role: 'user', content: { type: 'text', text: 'legacy prompt' }, meta: { sentFrom: 'cli' } } as const,
            anchor: 'step:0:0'
        }
        const s1 = {
            id: 'agy:agy-legacy:step:1:text',
            createdAt: 11,
            content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'legacy reply' } }, meta: { sentFrom: 'cli' } } as const,
            anchor: 'step:1:text'
        }
        const s2 = {
            id: 'agy:agy-legacy:step:2:0',
            createdAt: 20,
            content: { role: 'user', content: { type: 'text', text: 'new tail after upgrade' }, meta: { sentFrom: 'cli' } } as const,
            anchor: 'step:2:0'
        }

        // Simulate a legacy imported session created before session_native_steps existed.
        const legacySession = store.sessions.getOrCreateSession(
            'agy-import:m-1:agy-legacy',
            { path: '/work', host: 'm-1.local', machineId: 'm-1', flavor: 'agy', agySessionId: 'agy-legacy', agyImportedAt: 15 },
            {},
            'default'
        )
        store.messages.addImportedMessage(legacySession.id, s0.content, s0.id, 10)
        store.messages.addImportedMessage(legacySession.id, s1.content, s1.id, 11)
        expect(store.nativeSteps.getSteps(legacySession.id, 'agy-legacy')).toEqual([])

        let agySession = {
            flavor: 'agy' as const,
            id: 'agy-legacy',
            title: 'Legacy AGY session',
            lastUserMessage: 'legacy prompt',
            cwd: '/work',
            file: '/tmp/.gemini/antigravity-cli/brain/agy-legacy/.system_generated/logs/transcript.jsonl',
            modifiedAt: 20,
            messages: [s0, s1, s2]
        }

        const engine = {
            getOnlineMachinesByNamespace: () => [machine()],
            listLocalSessionsForMachine: async () => ({ success: true, sessions: [agySession] }),
            recordSessionActivity: () => {},
            handleRealtimeEvent: () => {},
            applySessionConfig: async () => {}
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createLocalSessionRoutes({
            store,
            getSyncEngine: () => engine,
            sources: [AGY_LOCAL_SESSION_SOURCE]
        }))

        const res = await (await app.request('/api/agy/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['agy-legacy'], cwd: '/work' })
        })).json() as { results: Array<{ action?: string; appended?: number }> }
        expect(res.results[0]).toMatchObject({ action: 'updated', appended: 1 })
        expect(store.nativeSteps.getSteps(legacySession.id, 'agy-legacy').map((row) => row.anchor)).toEqual([
            'step:0:0',
            'step:1:text',
            'step:2:0'
        ])
    })

    it('reconciles offline native turns via socket handlers on direct reopen and preserves late unrecorded disk replies for next re-import', async () => {
        const store = new Store(':memory:')
        stores.push(store)
        const nativeUser = (nativeId: string, id: string, text: string, createdAt = 10) => ({
            id: `agy:${nativeId}:${id}`,
            createdAt,
            content: { role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'cli' } } as const,
            anchor: id
        })
        const nativeAgent = (nativeId: string, id: string, message: string, createdAt = 10) => ({
            id: `agy:${nativeId}:${id}`,
            createdAt,
            content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message } }, meta: { sentFrom: 'cli' } } as const,
            anchor: id
        })

        let agySession = {
            flavor: 'agy' as const,
            id: 'agy-e2e',
            title: 'E2E reconcile session',
            lastUserMessage: 'initial prompt',
            cwd: '/work',
            file: '/tmp/.gemini/antigravity-cli/brain/agy-e2e/.system_generated/logs/transcript.jsonl',
            modifiedAt: 10,
            messages: [
                nativeUser('agy-e2e', 'step:0:0', 'initial prompt', 10),
                nativeAgent('agy-e2e', 'step:1:text', 'initial reply', 11)
            ]
        }

        const engine = {
            getOnlineMachinesByNamespace: () => [machine()],
            listLocalSessionsForMachine: async () => ({ success: true, sessions: [agySession] }),
            recordSessionActivity: () => {},
            handleRealtimeEvent: () => {},
            applySessionConfig: async () => {}
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createLocalSessionRoutes({
            store,
            getSyncEngine: () => engine,
            sources: [AGY_LOCAL_SESSION_SOURCE]
        }))

        const created = await (await app.request('/api/agy/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['agy-e2e'], cwd: '/work' })
        })).json() as { results: Array<{ hapiSessionId?: string }> }
        const hapiId = created.results[0]!.hapiSessionId!

        const handlers = new Map<string, (data: unknown, ack?: (response: unknown) => void) => void>()
        const socket = {
            on(event: string, fn: (data: unknown, ack?: (response: unknown) => void) => void) {
                handlers.set(event, fn)
                return this
            },
            to: () => ({ emit: () => {} })
        }
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: (sid) => {
                const found = store.sessions.getSession(sid)
                return found ? { ok: true, value: found } : { ok: false, reason: 'not-found' }
            },
            emitAccessError() {}
        })

        // 1. User continued in native AGY CLI while archived; HAPI directly reopens without explicit UI re-import.
        const s2 = nativeUser('agy-e2e', 'step:2:0', 'offline cli turn', 20)
        const s3 = nativeAgent('agy-e2e', 'step:3:text', 'offline cli reply', 21)
        const allSteps = [...agySession.messages, s2, s3]
        let reconcileAck: unknown
        handlers.get('session-reconcile-native-steps')!(
            {
                sid: hapiId,
                nativeId: 'agy-e2e',
                steps: allSteps.map((m) => ({ anchor: m.anchor, fingerprint: computeLocalTranscriptFingerprint(m.content) }))
            },
            (resp) => { reconcileAck = resp }
        )
        expect(reconcileAck).toEqual({ ok: true, status: 'needs_backfill', fromIndex: 2 })

        let backfillAck: unknown
        handlers.get('session-backfill-native-messages')!(
            {
                sid: hapiId,
                nativeId: 'agy-e2e',
                expectedOffset: 2,
                messages: [
                    { localId: s2.id, anchor: s2.anchor, createdAt: s2.createdAt, content: s2.content },
                    { localId: s3.id, anchor: s3.anchor, createdAt: s3.createdAt, content: s3.content }
                ]
            },
            (resp) => { backfillAck = resp }
        )
        expect(backfillAck).toEqual({ ok: true, inserted: 2, confirmedCount: 4 })

        // 2. Live HAPI turn runs next and incrementally records steps 4 & 5; step 6 finishes disk-only unrecorded.
        store.messages.addMessage(hapiId, { role: 'user', content: { type: 'text', text: 'live turn in hapi' }, meta: { sentFrom: 'web' } }, 'live-1', null, 30)
        store.messages.markMessagesInvoked(hapiId, ['live-1'], 30)
        store.messages.addMessage(hapiId, {
            role: 'agent',
            content: { type: 'codex', data: { type: 'message', message: 'live reply' } }
        }, undefined, null, 35)
        const s4 = nativeUser('agy-e2e', 'step:4:0', 'live turn in hapi', 30)
        const s5 = nativeAgent('agy-e2e', 'step:5:text', 'live reply', 35)
        let recordAck: unknown
        handlers.get('session-native-steps')!(
            {
                sid: hapiId,
                nativeId: 'agy-e2e',
                steps: [s4, s5].map((m) => ({ anchor: m.anchor, fingerprint: computeLocalTranscriptFingerprint(m.content) }))
            },
            (resp) => { recordAck = resp }
        )
        expect(recordAck).toEqual({ ok: true, inserted: 2 })

        // 3. A late disk-only reply (step:6:text) wasn't rendered in HAPI or recorded in ledger, plus step:7..8 follow natively.
        const lateDiskReply = nativeAgent('agy-e2e', 'step:6:text', 'late disk-only reply', 40)
        const nativeTail = [
            nativeUser('agy-e2e', 'step:7:0', 'later native prompt', 50),
            nativeAgent('agy-e2e', 'step:8:text', 'later native answer', 55)
        ]
        agySession = { ...agySession, messages: [...allSteps, s4, s5, lateDiskReply, ...nativeTail] }

        const syncRes = await (await app.request('/api/agy/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['agy-e2e'], cwd: '/work' })
        })).json() as { results: Array<{ hapiSessionId?: string; action?: string; appended?: number }> }

        expect(syncRes.results[0]).toMatchObject({ hapiSessionId: hapiId, action: 'updated', appended: 3 })
        const storedLocalIds = store.messages.getAllMessages(hapiId).map((m) => m.localId)
        expect(storedLocalIds).toContain('agy:agy-e2e:step:2:0')
        expect(storedLocalIds).toContain('agy:agy-e2e:step:3:text')
        expect(storedLocalIds).toContain('agy:agy-e2e:step:6:text')
        expect(storedLocalIds).toContain('agy:agy-e2e:step:7:0')
        expect(storedLocalIds).toContain('agy:agy-e2e:step:8:text')
    })

})

describe('fetchLocalTranscripts', () => {
    const stores: Store[] = []
    afterEach(() => {
        for (const store of stores.splice(0)) store.close()
    })

    it('uses the registry RPC when the machine advertises the capability', async () => {
        const calls: Array<{ method: string; payload: unknown }> = []
        const engine = {
            listLocalSessionsForMachine: async (_machineId: string, payload: unknown) => {
                calls.push({ method: 'listLocalSessions', payload })
                return { success: true, sessions: [piSummary()] }
            }
        } as unknown as SyncEngine
        const result = await fetchLocalTranscriptSummaries({
            source: PI_LOCAL_SESSION_SOURCE,
            engine,
            machine: machine()
        })
        expect(result.success).toBe(true)
        expect(calls[0]).toMatchObject({ method: 'listLocalSessions' })
    })

    it('falls back to the legacy RPC and converts raw rows without the capability', async () => {
        const store = new Store(':memory:')
        stores.push(store)
        const legacyCalls: unknown[] = []
        const engine = {
            listPiSessionsForMachine: async () => {
                legacyCalls.push('legacy')
                return { success: true, sessions: [piSummary()] }
            }
        } as unknown as SyncEngine
        const result = await fetchLocalTranscriptSummaries({
            source: PI_LOCAL_SESSION_SOURCE,
            engine,
            machine: machine('m-1', [])
        })
        expect(legacyCalls).toEqual(['legacy'])
        expect(result.success).toBe(true)
        if (result.success) {
            expect(result.sessions[0]).toMatchObject({ flavor: 'pi', id: 'pi-1' })
        }
    })

    it('fails closed when neither the capability nor a legacy fetch exists', async () => {
        const store = new Store(':memory:')
        stores.push(store)
        const source = { ...OPENCODE_LOCAL_SESSION_SOURCE, legacy: undefined }
        const result = await fetchLocalTranscriptSummaries({
            source,
            engine: { listOpencodeSessionsForMachine: async () => ({ success: true, sessions: [] }) } as unknown as SyncEngine,
            machine: machine('m-1', [])
        })
        expect(result.success).toBe(false)
    })

    it('returns transcripts for requested ids', async () => {
        const calls: Array<{ method: string; payload: unknown }> = []
        const engine = {
            listLocalSessionsForMachine: async (_machineId: string, payload: unknown) => {
                calls.push({ method: 'listLocalSessions', payload })
                return { success: true, sessions: [piTranscript()] }
            }
        } as unknown as SyncEngine
        const result = await fetchLocalTranscriptsByIds({
            source: PI_LOCAL_SESSION_SOURCE,
            engine,
            machine: machine(),
            sessionIds: ['pi-1']
        })
        expect(result.success).toBe(true)
        expect(calls[0]).toMatchObject({ method: 'listLocalSessions', payload: { flavor: 'pi', sessionIds: ['pi-1'] } })
        if (result.success) {
            expect('messages' in result.sessions[0]).toBe(true)
        }
    })
})
