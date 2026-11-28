import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import {
    AGY_BACKGROUND_COMMAND_RESULT,
    canonicalizeLocalTranscriptContent,
    isAgyBackgroundCommandPlaceholderOutput,
    isOversizedTruncatedPrefixMatch,
    type LocalTranscriptMessage
} from '@hapi/protocol/localTranscript'
import type { StoredMessage, StoredPendingNativeDelivery } from '../../../store'
import { truncateOversizedMessageContent } from '../../../store/contentCodec'

export { AGY_BACKGROUND_COMMAND_RESULT }

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rowUserTextCandidates(row: StoredMessage): string[] | null {
    const record = unwrapRoleWrappedRecordEnvelope(row.content)
    if (!record || record.role !== 'user' || !isPlainRecord(record.content) || record.content.type !== 'text') {
        return null
    }
    const rawText = typeof record.content.text === 'string' ? record.content.text : ''
    const attachments = Array.isArray(record.content.attachments)
        ? record.content.attachments.filter((a): a is Record<string, unknown> => isPlainRecord(a) && typeof a.path === 'string')
        : []
    const allPaths = attachments.map((a) => `@${String(a.path).trim()}`).filter((p) => p.length > 1).join(' ')
    const nonImagePaths = attachments
        .filter((a) => typeof a.mimeType !== 'string' || !a.mimeType.startsWith('image/'))
        .map((a) => `@${String(a.path).trim()}`)
        .filter((p) => p.length > 1)
        .join(' ')
    const candidates = new Set<string>([rawText])
    if (allPaths) candidates.add(rawText ? `${allPaths}\n\n${rawText}` : allPaths)
    if (nonImagePaths) candidates.add(rawText ? `${nonImagePaths}\n\n${rawText}` : nonImagePaths)
    return [...candidates]
}

export function buildUserCandidateTexts(rows: StoredMessage[]): string[] {
    if (rows.length === 0) return []
    let combinations: string[] = ['']
    for (let idx = 0; idx < rows.length; idx += 1) {
        const rowCandidates = rowUserTextCandidates(rows[idx]!)
        if (!rowCandidates) return []
        const next = new Set<string>()
        for (const prefix of combinations) {
            for (const candidate of rowCandidates) {
                next.add(idx === 0 ? candidate : `${prefix}\n${candidate}`)
                if (next.size >= 64) break
            }
            if (next.size >= 64) break
        }
        combinations = [...next]
    }
    return combinations
}

export function userRowsMatchNativeText(rows: StoredMessage[], nativeText: string): boolean {
    if (rows.length === 0) return false
    const allCandidates: string[][] = []
    for (const row of rows) {
        const candidates = rowUserTextCandidates(row)
        if (!candidates) return false
        allCandidates.push(candidates)
    }

    const matchesExact = (idx: number, rest: string): boolean => {
        if (idx === rows.length) return rest.length === 0
        for (const candidate of allCandidates[idx]!) {
            if (!rest.startsWith(candidate)) continue
            const after = rest.slice(candidate.length)
            if (idx === rows.length - 1) {
                if (after.length === 0) return true
            } else if (after.startsWith('\n')) {
                if (matchesExact(idx + 1, after.slice(1))) return true
            }
        }
        return false
    }
    if (matchesExact(0, nativeText)) {
        return true
    }

    const trimmedNative = nativeText.trim()
    if (!trimmedNative) {
        return false
    }

    const canBeWhitespaceFrom = new Array<boolean>(rows.length + 1)
    canBeWhitespaceFrom[rows.length] = true
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        canBeWhitespaceFrom[i] = Boolean(canBeWhitespaceFrom[i + 1]) && allCandidates[i]!.some((c) => c.trim().length === 0)
    }

    const failedStates = new Set<string>()
    const matchTrimmed = (idx: number, rest: string, emittedAny: boolean): boolean => {
        if (idx === rows.length) {
            return emittedAny && rest.length === 0
        }
        const key = `${idx}:${rest.length}:${emittedAny ? 1 : 0}`
        if (failedStates.has(key)) {
            return false
        }
        for (const candidate of allCandidates[idx]!) {
            const segment = emittedAny ? `\n${candidate}` : candidate
            if (!emittedAny) {
                if (segment.trim().length === 0) {
                    if (matchTrimmed(idx + 1, rest, false)) return true
                    continue
                }
                const trimmedStart = segment.trimStart()
                if (rest.startsWith(trimmedStart) && matchTrimmed(idx + 1, rest.slice(trimmedStart.length), true)) {
                    return true
                }
                const trimmedBoth = trimmedStart.trimEnd()
                if (rest === trimmedBoth && canBeWhitespaceFrom[idx + 1]) {
                    return true
                }
            } else {
                if (rest.startsWith(segment) && matchTrimmed(idx + 1, rest.slice(segment.length), true)) {
                    return true
                }
                const trimmedEnd = segment.trimEnd()
                if (rest === trimmedEnd && canBeWhitespaceFrom[idx + 1]) {
                    return true
                }
            }
        }
        failedStates.add(key)
        return false
    }

    return matchTrimmed(0, trimmedNative, false)
}

function unwrapRawAgentPayload(content: unknown): Record<string, unknown> | null {
    const record = unwrapRoleWrappedRecordEnvelope(content)
    if (!record || record.role !== 'agent' || !isPlainRecord(record.content)) return null
    if (record.content.type !== AGENT_MESSAGE_PAYLOAD_TYPE || !isPlainRecord(record.content.data)) return null
    return record.content.data
}

export function unwrapAgentPayload(content: unknown): Record<string, unknown> | null {
    return unwrapRawAgentPayload(truncateOversizedMessageContent(content))
}

export function storedHapiMessagesMatchNativeContent(rows: StoredMessage[], nativeContent: unknown): boolean {
    const canonicalNative = truncateOversizedMessageContent(nativeContent)
    const nativeRecord = unwrapRoleWrappedRecordEnvelope(canonicalNative)
    if (!nativeRecord) return false

    if (nativeRecord.role === 'user' && isPlainRecord(nativeRecord.content) && nativeRecord.content.type === 'text') {
        const nativeText = typeof nativeRecord.content.text === 'string' ? nativeRecord.content.text : ''
        return userRowsMatchNativeText(rows, nativeText)
    }

    if (nativeRecord.role !== 'agent' || rows.length !== 1) {
        return false
    }
    const storedRow = rows[0]!
    if (!storedRow.localId?.startsWith('agy-live:')) {
        return false
    }
    if (isDeepStrictEqual(truncateOversizedMessageContent(storedRow.content), canonicalNative)) {
        return true
    }

    const nativeData = unwrapAgentPayload(canonicalNative)
    const storedData = unwrapAgentPayload(storedRow.content)
    if (!nativeData || !storedData || storedData.type !== nativeData.type) {
        return false
    }
    if (nativeData.type === 'message' || nativeData.type === 'reasoning') {
        return storedData.message === nativeData.message
    }
    if (nativeData.type === 'tool-call') {
        return storedData.name === nativeData.name
            && isDeepStrictEqual(storedData.input ?? null, nativeData.input ?? null)
    }
    if (nativeData.type === 'tool-call-result') {
        return isDeepStrictEqual(
            { ...storedData, callId: nativeData.callId },
            nativeData
        )
    }
    return false
}

export function isPrefixOrRefinedText(liveText: unknown, diskText: unknown): boolean {
    if (typeof liveText !== 'string' || typeof diskText !== 'string') return false
    const liveTrimmed = liveText.trim()
    const diskTrimmed = diskText.trim()
    if (!liveTrimmed || !diskTrimmed) return false
    if (diskText.startsWith(liveText) || diskTrimmed.startsWith(liveTrimmed)) {
        return true
    }
    if (isOversizedTruncatedPrefixMatch(liveText, diskText)) {
        return true
    }
    const unclipped = liveTrimmed.replace(/(?:\.\.\.|…)+$/, '').trimEnd()
    return unclipped.length > 0 && diskTrimmed.startsWith(unclipped)
}

export function isCompatibleNativeUpdate(existingContent: unknown, nativeContent: unknown): boolean {
    const storedData = unwrapRawAgentPayload(existingContent)
    const nativeData = unwrapRawAgentPayload(nativeContent)
    if (!storedData || !nativeData || storedData.type !== nativeData.type) {
        return false
    }
    switch (nativeData.type) {
        case 'message':
        case 'reasoning':
            return isPrefixOrRefinedText(storedData.message, nativeData.message)
        case 'tool-call':
            return storedData.name === nativeData.name
        case 'tool-call-result': {
            if (isAgyBackgroundCommandPlaceholderOutput(storedData.output)) {
                return true
            }
            if (typeof storedData.output === 'string' && typeof nativeData.output === 'string') {
                return storedData.output.trim() === '' || isPrefixOrRefinedText(storedData.output, nativeData.output)
            }
            if (isPlainRecord(storedData.output) && isPlainRecord(nativeData.output)) {
                const storedStdout = typeof storedData.output.stdout === 'string'
                    ? storedData.output.stdout
                    : typeof storedData.output.output === 'string'
                        ? storedData.output.output
                        : null
                const nativeStdout = typeof nativeData.output.stdout === 'string'
                    ? nativeData.output.stdout
                    : typeof nativeData.output.output === 'string'
                        ? nativeData.output.output
                        : null
                if (storedStdout !== null && nativeStdout !== null) {
                    return storedStdout.trim() === '' || isPrefixOrRefinedText(storedStdout, nativeStdout)
                }
            }
            return false
        }
        default:
            return false
    }
}

export function mergeNativeReconcileContentPreservingCallId(existingContent: unknown, incomingContent: unknown): unknown {
    const storedData = unwrapAgentPayload(existingContent)
    const incomingData = unwrapAgentPayload(incomingContent)
    if (
        storedData
        && incomingData
        && (incomingData.type === 'tool-call' || incomingData.type === 'tool-call-result')
        && typeof storedData.callId === 'string'
        && storedData.callId.length > 0
        && storedData.callId !== incomingData.callId
    ) {
        return {
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: { ...incomingData, callId: storedData.callId }
            },
            meta: { sentFrom: 'cli' }
        }
    }
    return incomingContent
}

export type EffectivePendingDelivery =
    | {
        kind: 'user'
        messageId: string
        localIds: string[]
        rows: StoredMessage[]
        texts: string[]
        uncertain: boolean
        awaitingResolution: boolean
    }
    | {
        kind: 'agent'
        messageId: string
        localId: string
        row: StoredMessage
        uncertain: false
    }

export function collectEffectivePendingDeliveries(
    storedMessages: ReadonlyArray<StoredMessage>,
    recordedSteps: ReadonlyArray<{ messageId?: string }>,
    dbPendingDeliveries: ReadonlyArray<StoredPendingNativeDelivery>
): EffectivePendingDelivery[] {
    const byId = new Map<string, StoredMessage>()
    const byLocalId = new Map<string, StoredMessage>()
    for (const msg of storedMessages) {
        byId.set(msg.id, msg)
        if (msg.localId) {
            byLocalId.set(msg.localId, msg)
        }
    }

    const coveredMessageIds = new Set<string>()
    let lastRecordedSeq = -1
    for (const step of recordedSteps) {
        if (step.messageId !== undefined) {
            coveredMessageIds.add(step.messageId)
            const linked = byId.get(step.messageId)
            if (linked && linked.seq > lastRecordedSeq) {
                lastRecordedSeq = linked.seq
            }
        }
    }

    const result: EffectivePendingDelivery[] = []
    for (const entry of dbPendingDeliveries) {
        if (coveredMessageIds.has(entry.messageId)) continue
        const anchorRow = byId.get(entry.messageId)
        if (!anchorRow) continue

        if (entry.kind === 'user') {
            const rows: StoredMessage[] = []
            let valid = true
            for (const lid of entry.localIds) {
                const row = byLocalId.get(lid)
                if (!row) {
                    valid = false
                    break
                }
                rows.push(row)
            }
            if (!valid || rows.length === 0) continue
            rows.sort((a, b) => a.seq - b.seq)
            const texts = buildUserCandidateTexts(rows)
            if (texts.length === 0) continue
            for (const row of rows) {
                coveredMessageIds.add(row.id)
            }
            coveredMessageIds.add(entry.messageId)
            const uncertain = rows.some((row) => row.invokedAt === null)
            const awaitingResolution = rows.some(
                (row) => row.invokedAt === null && row.deliveryState === 'indeterminate'
            )
            result.push({
                kind: 'user',
                messageId: entry.messageId,
                localIds: rows.map((row) => row.localId!),
                rows,
                texts,
                uncertain,
                awaitingResolution
            })
        } else {
            const localId = entry.localIds[0] ?? anchorRow.localId
            if (!localId) continue
            coveredMessageIds.add(entry.messageId)
            result.push({
                kind: 'agent',
                messageId: entry.messageId,
                localId,
                row: anchorRow,
                uncertain: false
            })
        }
    }

    const orderedMessages = [...storedMessages].sort((a, b) => a.seq - b.seq)
    for (const msg of orderedMessages) {
        if (
            msg.seq > lastRecordedSeq
            && typeof msg.localId === 'string'
            && msg.localId.startsWith('agy-live:')
            && !coveredMessageIds.has(msg.id)
        ) {
            coveredMessageIds.add(msg.id)
            result.push({
                kind: 'agent',
                messageId: msg.id,
                localId: msg.localId,
                row: msg,
                uncertain: false
            })
            continue
        }
        if (
            msg.invokedAt === null
            && msg.deliveryState === 'indeterminate'
            && typeof msg.localId === 'string'
            && !coveredMessageIds.has(msg.id)
        ) {
            const texts = buildUserCandidateTexts([msg])
            if (texts.length === 0) continue
            coveredMessageIds.add(msg.id)
            result.push({
                kind: 'user',
                messageId: msg.id,
                localIds: [msg.localId],
                rows: [msg],
                texts,
                uncertain: true,
                awaitingResolution: true
            })
        }
    }

    return [
        ...result.filter((entry) => !entry.uncertain),
        ...result.filter((entry) => entry.uncertain)
    ]
}

export type SerializedPendingNativeDelivery =
    | { kind: 'user'; localIds: string[]; texts: string[]; uncertain: boolean; awaitingResolution: boolean }
    | { kind: 'agent'; localId: string; data: Record<string, unknown> }

export function serializePendingDeliveriesForCli(
    effectivePending: ReadonlyArray<EffectivePendingDelivery>
): SerializedPendingNativeDelivery[] {
    const serialized: SerializedPendingNativeDelivery[] = []
    for (const entry of effectivePending) {
        if (entry.kind === 'user') {
            serialized.push({
                kind: 'user',
                localIds: [...entry.localIds],
                texts: [...entry.texts],
                uncertain: entry.uncertain,
                awaitingResolution: entry.awaitingResolution
            })
        } else {
            const data = unwrapAgentPayload(entry.row.content)
            if (data) {
                serialized.push({
                    kind: 'agent',
                    localId: entry.localId,
                    data
                })
            }
        }
    }
    return serialized
}

function fingerprintContent(content: unknown): string {
    return createHash('sha256')
        .update(canonicalizeLocalTranscriptContent(truncateOversizedMessageContent(content)))
        .digest('hex')
}

export type MatchPendingDeliveriesResult =
    | {
        status: 'ok'
        delta: LocalTranscriptMessage[]
        reconciledSteps: Array<{ anchor: string; fingerprint: string; messageId: string }>
        reconciledUpdates: Array<{ messageId: string; localId: string; anchor: string; nextContent: unknown }>
        resolvedPendingMessageIds: string[]
        corroboratedUserLocalIds: string[]
        demoteDispatchingLocalIds: string[]
        hasUnresolvedUncertain: boolean
    }
    | { status: 'pending_flush'; message: string }
    | { status: 'diverged'; message: string }

export function matchPendingDeliveriesAgainstTranscript(
    tailMessages: ReadonlyArray<LocalTranscriptMessage>,
    effectivePending: ReadonlyArray<EffectivePendingDelivery>
): MatchPendingDeliveriesResult {
    const isExactMatch = (diskMsg: LocalTranscriptMessage, pending: EffectivePendingDelivery): boolean => {
        const rows = pending.kind === 'user' ? pending.rows : [pending.row]
        return storedHapiMessagesMatchNativeContent(rows, diskMsg.content)
    }
    const isCompatibleUpdate = (diskMsg: LocalTranscriptMessage, pending: EffectivePendingDelivery): boolean => {
        if (pending.kind !== 'agent') return false
        return isCompatibleNativeUpdate(pending.row.content, diskMsg.content)
    }

    const reconciledSteps: Array<{ anchor: string; fingerprint: string; messageId: string }> = []
    const reconciledUpdates: Array<{ messageId: string; localId: string; anchor: string; nextContent: unknown }> = []
    const intermediateBackfills: LocalTranscriptMessage[] = []
    const resolvedPendingMessageIds: string[] = []
    const corroboratedUserLocalIds: string[] = []
    const unresolvedUncertain: Array<Extract<EffectivePendingDelivery, { kind: 'user' }>> = []

    let dIdx = 0
    let pIdx = 0
    while (dIdx < tailMessages.length && pIdx < effectivePending.length) {
        const diskMsg = tailMessages[dIdx]!
        const pending = effectivePending[pIdx]!
        const anchor = diskMsg.anchor
        if (typeof anchor !== 'string' || anchor.length === 0) {
            return {
                status: 'diverged',
                message: 'The Antigravity transcript step is missing an anchor during live reconciliation'
            }
        }

        if (isExactMatch(diskMsg, pending)) {
            reconciledSteps.push({
                anchor,
                fingerprint: fingerprintContent(diskMsg.content),
                messageId: pending.messageId
            })
            resolvedPendingMessageIds.push(pending.messageId)
            if (pending.kind === 'user' && pending.uncertain) {
                corroboratedUserLocalIds.push(...pending.localIds)
            }
            dIdx += 1
            pIdx += 1
            continue
        }

        let matchedAheadExact = false
        for (let look = dIdx + 1; look < tailMessages.length; look += 1) {
            if (isExactMatch(tailMessages[look]!, pending)) {
                matchedAheadExact = true
                break
            }
        }
        if (matchedAheadExact) {
            intermediateBackfills.push(diskMsg)
            dIdx += 1
            continue
        }

        if (pending.kind === 'agent' && isCompatibleUpdate(diskMsg, pending)) {
            const nextContent = mergeNativeReconcileContentPreservingCallId(pending.row.content, diskMsg.content)
            reconciledUpdates.push({
                messageId: pending.messageId,
                localId: pending.localId,
                anchor,
                nextContent
            })
            reconciledSteps.push({
                anchor,
                fingerprint: fingerprintContent(diskMsg.content),
                messageId: pending.messageId
            })
            resolvedPendingMessageIds.push(pending.messageId)
            dIdx += 1
            pIdx += 1
            continue
        }

        let matchedAheadCompatible = false
        for (let look = dIdx + 1; look < tailMessages.length; look += 1) {
            if (isCompatibleUpdate(tailMessages[look]!, pending)) {
                matchedAheadCompatible = true
                break
            }
        }
        if (matchedAheadCompatible) {
            intermediateBackfills.push(diskMsg)
            dIdx += 1
            continue
        }

        if (pending.kind === 'user' && pending.uncertain) {
            unresolvedUncertain.push(pending)
            pIdx += 1
            continue
        }

        break
    }

    let hasUnmatchedCorroborated = false
    for (let i = pIdx; i < effectivePending.length; i += 1) {
        const pending = effectivePending[i]!
        if (pending.kind === 'user' && pending.uncertain) {
            unresolvedUncertain.push(pending)
        } else {
            hasUnmatchedCorroborated = true
        }
    }

    if (hasUnmatchedCorroborated) {
        if (dIdx === tailMessages.length) {
            return {
                status: 'pending_flush',
                message: 'Antigravity has not finished writing uncommitted live messages to disk yet; retry shortly.'
            }
        }
        return {
            status: 'diverged',
            message: 'Uncommitted HAPI live turns conflict with the Antigravity native transcript'
        }
    }

    const demoteSet = new Set<string>()
    for (const pending of unresolvedUncertain) {
        for (const row of pending.rows) {
            if (row.invokedAt === null && row.deliveryPending === true && typeof row.localId === 'string') {
                demoteSet.add(row.localId)
            }
        }
    }

    return {
        status: 'ok',
        delta: [...intermediateBackfills, ...tailMessages.slice(dIdx)],
        reconciledSteps,
        reconciledUpdates,
        resolvedPendingMessageIds,
        corroboratedUserLocalIds,
        demoteDispatchingLocalIds: [...demoteSet],
        hasUnresolvedUncertain: unresolvedUncertain.length > 0
    }
}
