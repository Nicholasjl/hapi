import { describe, expect, it } from 'bun:test'
import type { LocalTranscript, LocalTranscriptMessage } from '@hapi/protocol/localTranscript'
import { TRUNCATE_STRING_LIMIT, truncateOversizedMessageContent } from '../../../store/contentCodec'
import type { StoredMessage } from '../../../store'
import { computeLocalTranscriptFingerprint, matchAnchored } from './matchAnchored'
import { AGY_LOCAL_SESSION_SOURCE } from './sources'

const PREFIX = 'opencode:ses-1:'

function userContent(text: string) {
    return { role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'cli' } } as const
}

function transcriptMessage(id: string, text: string, anchor?: string): LocalTranscriptMessage {
    return {
        id,
        createdAt: 1,
        content: userContent(text),
        ...(anchor !== undefined ? { anchor } : {})
    }
}

function storedMessage(localId: string, text: string): StoredMessage {
    return {
        id: `stored-${localId}`,
        sessionId: 'hapi-1',
        content: userContent(text),
        createdAt: 1,
        seq: 1,
        localId,
        invokedAt: localId.startsWith(PREFIX) ? null : 1,
        scheduledAt: null
    }
}

function transcript(messages: LocalTranscriptMessage[], anchorOrder?: string[], cursor?: string | null): LocalTranscript {
    return {
        flavor: 'opencode',
        id: 'ses-1',
        title: 't',
        file: '/tmp/db',
        modifiedAt: 1,
        messages,
        ...(anchorOrder !== undefined ? { anchorOrder } : {}),
        ...(cursor !== undefined ? { cursor } : {})
    }
}

describe('anchored match: R1 order and content', () => {
    it('appends only the delta for an extended transcript', () => {
        const stored = [storedMessage(`${PREFIX}a`, 'one')]
        const result = matchAnchored({
            storedMessages: stored,
            transcript: transcript([transcriptMessage(`${PREFIX}a`, 'one'), transcriptMessage(`${PREFIX}b`, 'two')]),
            importPrefix: PREFIX,
            cursor: null
        })
        expect(result).toEqual({ status: 'ok', delta: [transcriptMessage(`${PREFIX}b`, 'two')] })
    })

    it('rejects a changed imported entry', () => {
        const stored = [storedMessage(`${PREFIX}a`, 'one')]
        const result = matchAnchored({
            storedMessages: stored,
            transcript: transcript([transcriptMessage(`${PREFIX}a`, 'one changed')]),
            importPrefix: PREFIX,
            cursor: null
        })
        expect(result.status).toBe('transcript_diverged')
    })

    it('rejects a reordered transcript', () => {
        const stored = [storedMessage(`${PREFIX}a`, 'one'), storedMessage(`${PREFIX}b`, 'two')]
        const result = matchAnchored({
            storedMessages: stored,
            transcript: transcript([transcriptMessage(`${PREFIX}b`, 'two'), transcriptMessage(`${PREFIX}a`, 'one')]),
            importPrefix: PREFIX,
            cursor: null
        })
        expect(result.status).toBe('transcript_diverged')
    })

    it('rejects a dropped imported entry', () => {
        const stored = [storedMessage(`${PREFIX}a`, 'one'), storedMessage(`${PREFIX}b`, 'two')]
        const result = matchAnchored({
            storedMessages: stored,
            transcript: transcript([transcriptMessage(`${PREFIX}a`, 'one')]),
            importPrefix: PREFIX,
            cursor: null
        })
        expect(result.status).toBe('transcript_diverged')
    })
})

describe('anchored match: R2-R4 with a cursor', () => {
    const anchorOrder = ['a', 'b', 'c', 'd']

    function cursorTranscript(messages: LocalTranscriptMessage[], cursor: string | null): LocalTranscript {
        return {
            flavor: 'pi',
            id: 'ses-1',
            title: 't',
            file: '/tmp/pi.jsonl',
            modifiedAt: 1,
            messages,
            anchorOrder,
            cursor
        }
    }

    it('fails when the stored cursor left the active branch (R2)', () => {
        const result = matchAnchored({
            storedMessages: [storedMessage('pi:ses-1:a:user', 'one')],
            transcript: cursorTranscript([transcriptMessage('pi:ses-1:a:user', 'one', 'a')], 'z'),
            importPrefix: 'pi:ses-1:',
            cursor: 'z'
        })
        expect(result.status).toBe('transcript_diverged')
    })

    it('appends entries after the cursor (R3) and tolerates gaps before the anchor (R4)', () => {
        const result = matchAnchored({
            storedMessages: [storedMessage('pi:ses-1:a:user', 'one')],
            transcript: cursorTranscript([
                transcriptMessage('pi:ses-1:a:user', 'one', 'a'),
                transcriptMessage('pi:ses-1:c:user', 'three', 'c')
            ], 'b'),
            importPrefix: 'pi:ses-1:',
            cursor: 'b'
        })
        expect(result).toMatchObject({ status: 'ok' })
        if (result.status === 'ok') {
            expect(result.delta.map((message) => message.anchor)).toEqual(['c'])
        }
    })

    it('uses the later of the last import and the cursor as the anchor (R3)', () => {
        const result = matchAnchored({
            storedMessages: [
                storedMessage('pi:ses-1:a:user', 'one'),
                storedMessage('pi:ses-1:c:user', 'three')
            ],
            transcript: cursorTranscript([
                transcriptMessage('pi:ses-1:a:user', 'one', 'a'),
                transcriptMessage('pi:ses-1:c:user', 'three', 'c')
            ], 'b'),
            importPrefix: 'pi:ses-1:',
            cursor: 'b'
        })
        expect(result).toMatchObject({ status: 'ok', delta: [] })
    })
})

describe('anchored match: R4/R5 without a cursor', () => {
    it('rejects entries inserted ahead of the imported boundary', () => {
        const stored = [storedMessage(`${PREFIX}b`, 'two')]
        const result = matchAnchored({
            storedMessages: stored,
            transcript: transcript([transcriptMessage(`${PREFIX}a`, 'one'), transcriptMessage(`${PREFIX}b`, 'two')]),
            importPrefix: PREFIX,
            cursor: null
        })
        expect(result.status).toBe('transcript_diverged')
    })

    it('reports already_in_hapi for a HAPI-created session with a delta (R5)', () => {
        const stored = [storedMessage('local-1', 'hello from hapi')]
        const result = matchAnchored({
            storedMessages: stored,
            transcript: transcript([transcriptMessage(`${PREFIX}a`, 'one')]),
            importPrefix: PREFIX,
            cursor: null
        })
        expect(result.status).toBe('already_in_hapi')
    })

    it('keeps a fully imported transcript unchanged', () => {
        const stored = [storedMessage(`${PREFIX}a`, 'one')]
        const result = matchAnchored({
            storedMessages: stored,
            transcript: transcript([transcriptMessage(`${PREFIX}a`, 'one')]),
            importPrefix: PREFIX,
            cursor: null
        })
        expect(result).toEqual({ status: 'ok', delta: [] })
    })

    it('ignores HAPI-side extras when the transcript has no delta', () => {
        const stored = [storedMessage(`${PREFIX}a`, 'one'), storedMessage('local-1', 'hapi turn')]
        const result = matchAnchored({
            storedMessages: stored,
            transcript: transcript([transcriptMessage(`${PREFIX}a`, 'one')]),
            importPrefix: PREFIX,
            cursor: null
        })
        expect(result).toEqual({ status: 'ok', delta: [] })
    })
})

describe('anchored match: Antigravity native step ledger', () => {
    const AGY_PREFIX = 'agy:ses-1:'

    function agyStoredUser(seq: number, localId: string | null, text: string, createdAt = seq): StoredMessage {
        return {
            id: `stored-${seq}`,
            sessionId: 'hapi-agy',
            content: { role: 'user', content: { type: 'text', text }, meta: { sentFrom: localId?.startsWith(AGY_PREFIX) ? 'cli' : 'web' } },
            createdAt,
            seq,
            localId,
            invokedAt: createdAt,
            scheduledAt: null
        }
    }

    function agyStoredAgent(seq: number, data: Record<string, unknown>, createdAt = seq, localId: string | null = null): StoredMessage {
        return {
            id: `stored-${seq}`,
            sessionId: 'hapi-agy',
            content: { role: 'agent', content: { type: 'codex', data }, meta: { sentFrom: 'cli' } },
            createdAt,
            seq,
            localId,
            invokedAt: createdAt,
            scheduledAt: null
        }
    }

    function agyNativeUser(id: string, text: string): LocalTranscriptMessage {
        return {
            id: `${AGY_PREFIX}${id}`,
            createdAt: 1,
            content: { role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'cli' } },
            anchor: id
        }
    }

    function agyNativeAgent(id: string, data: Record<string, unknown>): LocalTranscriptMessage {
        return {
            id: `${AGY_PREFIX}${id}`,
            createdAt: 1,
            content: { role: 'agent', content: { type: 'codex', data }, meta: { sentFrom: 'cli' } },
            anchor: id
        }
    }

    function agyTranscript(messages: LocalTranscriptMessage[]): LocalTranscript {
        return { flavor: 'agy', id: 'ses-1', title: 't', file: '/tmp/transcript.jsonl', modifiedAt: 1, messages }
    }

    function ledgerFor(messages: LocalTranscriptMessage[]) {
        return messages.map((message) => ({
            anchor: message.anchor!,
            fingerprint: computeLocalTranscriptFingerprint(message.content)
        }))
    }

    it('reconciles despite /swarm board, pre-dispatch restores, and completed background steer divergence between HAPI and AGY placeholder', () => {
        expect(AGY_LOCAL_SESSION_SOURCE.match.strategy === 'anchored' && AGY_LOCAL_SESSION_SOURCE.match.nativeStepLedger).toBe(true)

        const initialUser = agyNativeUser('step:0:0', 'imported start')
        const initialAgent = agyNativeAgent('step:1:text', { type: 'message', message: 'initial reply' })
        const liveBatchUser = agyNativeUser('step:2:0', 'first batch\nsecond batch')
        const liveCmdCall = agyNativeAgent('step:3:call:0', { type: 'tool-call', name: 'Bash', callId: 'agy-wakeup-ses-1-3-0', input: { command: 'sleep 2' } })
        const liveCmdBgResult = agyNativeAgent('step:4:0', { type: 'tool-call-result', callId: 'agy-wakeup-ses-1-3-0', output: 'Command moved to background.', is_error: false })
        const liveFinalText = agyNativeAgent('step:5:text', { type: 'message', message: 'real answer' })
        const tailNative = [
            agyNativeUser('step:6:0', 'continued in native cli'),
            agyNativeAgent('step:7:text', { type: 'message', message: 'native answer' })
        ]

        // HAPI stores /swarm board, pre-dispatch abort-restore, and the completed ACP command output
        // whereas native transcript step:4:0 stays AGY_BACKGROUND_COMMAND_RESULT.
        const stored: StoredMessage[] = [
            agyStoredUser(1, initialUser.id, 'imported start', 10),
            agyStoredAgent(2, { type: 'message', message: 'initial reply' }, 11, initialAgent.id),
            agyStoredUser(3, 'board-1', '/swarm board', 15),
            agyStoredAgent(4, { type: 'message', message: '### Swarm Board' }, 16),
            agyStoredUser(5, 'restore-1', 'restored prompt before dispatch', 18),
            agyStoredUser(6, 'live-1', 'first batch', 20),
            agyStoredUser(7, 'live-2', 'second batch', 21),
            agyStoredAgent(8, { type: 'tool-call', name: 'Bash', callId: 'live-call-1', input: { command: 'sleep 2' } }, 22),
            agyStoredAgent(9, { type: 'tool-call-result', callId: 'live-call-1', output: { stdout: 'completed during steer', exit_code: 0 }, is_error: false }, 23),
            agyStoredAgent(10, { type: 'message', message: 'real answer' }, 25)
        ]

        const confirmed = [initialUser, initialAgent, liveBatchUser, liveCmdCall, liveCmdBgResult, liveFinalText]
        const ledger = ledgerFor(confirmed)

        const ok = matchAnchored({
            storedMessages: stored,
            transcript: agyTranscript([...confirmed, ...tailNative]),
            importPrefix: AGY_PREFIX,
            cursor: null,
            recordedNativeSteps: ledger
        })
        expect(ok).toEqual({ status: 'ok', delta: tailNative })
    })

    it('matches oversized (>64KB) agent outputs using truncated canonical fingerprints across ledger and transcript', () => {
        const bigOutput = `${'A'.repeat(TRUNCATE_STRING_LIMIT + 5_000)}END`
        const s0 = agyNativeUser('step:0:0', 'run huge command')
        const s1 = agyNativeAgent('step:1:0', { type: 'tool-call-result', callId: 'c1', output: bigOutput, is_error: false })
        const s2 = agyNativeUser('step:2:0', 'follow up')

        const ledger = ledgerFor([s0, s1])
        const result = matchAnchored({
            storedMessages: [
                agyStoredUser(1, s0.id, 'run huge command', 10),
                {
                    id: 'stored-2',
                    sessionId: 'hapi-agy',
                    content: truncateOversizedMessageContent({ role: 'agent', content: { type: 'codex', data: { type: 'tool-call-result', callId: 'c1', output: bigOutput, is_error: false } }, meta: { sentFrom: 'cli' } }) as StoredMessage['content'],
                    createdAt: 11,
                    seq: 2,
                    localId: s1.id,
                    invokedAt: 11,
                    scheduledAt: null
                }
            ],
            transcript: agyTranscript([s0, s1, s2]),
            importPrefix: AGY_PREFIX,
            cursor: null,
            recordedNativeSteps: ledger
        })
        expect(result).toEqual({ status: 'ok', delta: [s2] })
    })

    it('rejects modified, reordered, or dropped confirmed steps in the native ledger', () => {
        const s0 = agyNativeUser('step:0:0', 'start')
        const s1 = agyNativeAgent('step:1:text', { type: 'message', message: 'reply' })
        const s2 = agyNativeUser('step:2:0', 'live turn')
        const s3 = agyNativeAgent('step:3:text', { type: 'message', message: 'live reply' })
        const ledger = ledgerFor([s0, s1, s2, s3])
        const stored: StoredMessage[] = [
            agyStoredUser(1, s0.id, 'start', 10),
            agyStoredAgent(2, { type: 'message', message: 'reply' }, 11, s1.id),
            agyStoredUser(3, 'live-1', 'live turn', 20),
            agyStoredAgent(4, { type: 'message', message: 'live reply' }, 21)
        ]

        // Modified confirmed live step content.
        expect(matchAnchored({
            storedMessages: stored,
            transcript: agyTranscript([s0, s1, agyNativeUser('step:2:0', 'edited live turn'), s3]),
            importPrefix: AGY_PREFIX,
            cursor: null,
            recordedNativeSteps: ledger
        }).status).toBe('transcript_diverged')

        // Reordered confirmed steps.
        expect(matchAnchored({
            storedMessages: stored,
            transcript: agyTranscript([s0, s1, s3, s2]),
            importPrefix: AGY_PREFIX,
            cursor: null,
            recordedNativeSteps: ledger
        }).status).toBe('transcript_diverged')

        // Dropped confirmed step.
        expect(matchAnchored({
            storedMessages: stored,
            transcript: agyTranscript([s0, s1, s2]),
            importPrefix: AGY_PREFIX,
            cursor: null,
            recordedNativeSteps: ledger
        }).status).toBe('transcript_diverged')

        // Imported row removed even when native tail shortened cleanly.
        expect(matchAnchored({
            storedMessages: stored,
            transcript: agyTranscript([s0, s2, s3]),
            importPrefix: AGY_PREFIX,
            cursor: null,
            recordedNativeSteps: ledger
        }).status).toBe('transcript_diverged')
    })

    it('enforces linked messageId existence and rejects uncommitted agy-live rows past lastRecordedSeq when native tail advances', () => {
        const s0 = agyNativeUser('step:0:0', 'start')
        const s1 = agyNativeAgent('step:1:text', { type: 'message', message: 'reply' })
        const s2 = agyNativeUser('step:2:0', 'offline continuation')

        const stored0 = agyStoredUser(1, s0.id, 'start', 10)
        const stored1 = agyStoredAgent(2, { type: 'message', message: 'reply' }, 11, s1.id)
        const linkedLedger = [
            { anchor: s0.anchor!, fingerprint: computeLocalTranscriptFingerprint(s0.content), messageId: stored0.id },
            { anchor: s1.anchor!, fingerprint: computeLocalTranscriptFingerprint(s1.content), messageId: stored1.id }
        ]

        // Missing linked message row diverges.
        expect(matchAnchored({
            storedMessages: [stored0],
            transcript: agyTranscript([s0, s1]),
            importPrefix: AGY_PREFIX,
            cursor: null,
            recordedNativeSteps: linkedLedger
        }).status).toBe('transcript_diverged')

        // Uncommitted agy-live row at seq > lastRecordedSeq diverges when delta is non-empty.
        expect(matchAnchored({
            storedMessages: [
                stored0,
                stored1,
                agyStoredUser(3, 'board-1', '/swarm board', 12),
                agyStoredAgent(4, { type: 'message', message: 'uncommitted live reply' }, 13, 'agy-live:r-1')
            ],
            transcript: agyTranscript([s0, s1, s2]),
            importPrefix: AGY_PREFIX,
            cursor: null,
            recordedNativeSteps: linkedLedger
        }).status).toBe('transcript_diverged')

        // Non-agy-live control/restore rows alone without agy-live rows still reconcile cleanly.
        expect(matchAnchored({
            storedMessages: [
                stored0,
                stored1,
                agyStoredUser(3, 'board-1', '/swarm board', 12),
                agyStoredAgent(4, { type: 'message', message: '### Swarm Board' }, 13)
            ],
            transcript: agyTranscript([s0, s1, s2]),
            importPrefix: AGY_PREFIX,
            cursor: null,
            recordedNativeSteps: linkedLedger
        })).toEqual({ status: 'ok', delta: [s2] })
    })
})
