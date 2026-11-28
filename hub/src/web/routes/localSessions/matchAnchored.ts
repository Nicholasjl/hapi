import { isDeepStrictEqual } from 'node:util'
import type { LocalTranscript, LocalTranscriptMessage } from '@hapi/protocol/localTranscript'
import type { StoredMessage } from '../../../store'
import { truncateOversizedMessageContent } from '../../../store/contentCodec'

/**
 * Anchored target matching: the imported prefix P of the HAPI
 * session must still line up with the source transcript S; the delta is what
 * follows the anchor. Reproduces OpenCode's strict prefix check and Pi's
 * append-after-leaf behavior.
 *
 * R1 imported messages must appear in S in order with equal content
 * R2 a stored cursor must still be on the transcript's anchor order
 * R3 anchor = max(last imported position, cursor position)
 * R4 gaps before the anchor are only allowed with a cursor
 * R5 no imports and no cursor but stored messages -> already_in_hapi
 * R6 active session with a delta -> session_active (enforced by the importer)
 */

export type AnchoredMatchResult =
    | { status: 'ok'; delta: LocalTranscriptMessage[] }
    | { status: 'transcript_diverged'; message: string }
    | { status: 'already_in_hapi'; message: string }

export type LiveNativeTurnRecord = {
    localIds: string[]
    promptText: string
    userStepIndex?: number | null
    endStepIndex?: number | null
}

function parseStepIndexFromAnchor(anchor: string | undefined): number | null {
    if (!anchor) return null
    const match = /^step:(\d+):/.exec(anchor)
    return match ? Number(match[1]) : null
}

function normalizePromptText(text: string): string {
    return text.replace(/\r\n/g, '\n').trim()
}

function matchProvenanceSegment(options: {
    segmentStored: StoredMessage[]
    segmentSource: LocalTranscriptMessage[]
    exactEnd: boolean
    sourceContentById: Map<string, unknown>
    liveCompareKey: (content: unknown, callIds?: Map<string, number>) => string | null
    allNativeTurns: LiveNativeTurnRecord[]
    claimedTurnIndices: Set<number>
    storedCallIds: Map<string, number>
    sourceCallIds: Map<string, number>
}): MatchSegmentResult | null {
    const {
        segmentStored,
        segmentSource,
        exactEnd,
        sourceContentById,
        liveCompareKey,
        allNativeTurns,
        claimedTurnIndices
    } = options
    const storedCallIds = new Map(options.storedCallIds)
    const sourceCallIds = new Map(options.sourceCallIds)

    const segmentLocalIds = new Set<string>()
    const storedByLocalId = new Map<string, StoredMessage>()
    const liveAgents: StoredMessage[] = []
    for (const stored of segmentStored) {
        if (typeof stored.localId === 'string') {
            segmentLocalIds.add(stored.localId)
            storedByLocalId.set(stored.localId, stored)
        }
        const payload = stored.content as { role?: unknown } | null
        if (payload?.role !== 'user' && liveCompareKey(stored.content) !== null) {
            liveAgents.push(stored)
        }
    }

    const segmentStepIndices = new Set<number>()
    for (const source of segmentSource) {
        const step = parseStepIndexFromAnchor(source.anchor)
        if (step !== null) segmentStepIndices.add(step)
    }

    const segmentTurns: LiveNativeTurnRecord[] = []
    for (let idx = 0; idx < allNativeTurns.length; idx += 1) {
        if (claimedTurnIndices.has(idx)) continue
        const turn = allNativeTurns[idx]!
        const matchesLocal = turn.localIds.some((id) => segmentLocalIds.has(id))
        const matchesStepFallback = turn.localIds.length === 0
            && turn.userStepIndex != null
            && segmentStepIndices.has(turn.userStepIndex)
        if (matchesLocal || matchesStepFallback) {
            claimedTurnIndices.add(idx)
            segmentTurns.push(turn)
        }
    }

    let srcIdx = 0
    let turnIdx = 0
    let agentIdx = 0
    let lastTurnMinSeq: number | null = null
    let lastTurnInvokedAt: number | null = null

    const turnTimingBounds = (turn: LiveNativeTurnRecord): { minSeq: number | null; minPos: number | null } => {
        const rows = turn.localIds
            .map((id) => storedByLocalId.get(id))
            .filter((row): row is StoredMessage => row !== undefined)
        if (rows.length === 0) return { minSeq: null, minPos: null }
        return {
            minSeq: Math.min(...rows.map((r) => r.seq)),
            minPos: Math.min(...rows.map((r) => r.invokedAt ?? r.createdAt))
        }
    }

    while (srcIdx < segmentSource.length) {
        if (!exactEnd && turnIdx === segmentTurns.length && agentIdx === liveAgents.length) {
            return { matchedEnd: srcIdx, storedCallIds, sourceCallIds }
        }
        const source = segmentSource[srcIdx]!
        const nativeContent = sourceContentById.get(source.id)
        const nativeRecord = nativeContent && typeof nativeContent === 'object'
            ? (nativeContent as { role?: unknown; content?: unknown })
            : null

        if (nativeRecord?.role === 'user') {
            if (turnIdx >= segmentTurns.length) return null
            const turn = segmentTurns[turnIdx]!
            if (turn.userStepIndex != null && parseStepIndexFromAnchor(source.anchor) !== turn.userStepIndex) {
                return null
            }
            const nativeBody = nativeRecord.content && typeof nativeRecord.content === 'object' && !Array.isArray(nativeRecord.content)
                ? (nativeRecord.content as { type?: unknown; text?: unknown })
                : null
            if (nativeBody?.type !== 'text' || typeof nativeBody.text !== 'string') {
                return null
            }
            if (normalizePromptText(nativeBody.text) !== normalizePromptText(turn.promptText)) {
                return null
            }
            const bounds = turnTimingBounds(turn)
            if (bounds.minSeq !== null) lastTurnMinSeq = bounds.minSeq
            if (bounds.minPos !== null) lastTurnInvokedAt = bounds.minPos
            srcIdx += 1
            turnIdx += 1
            continue
        }

        const sourceKey = liveCompareKey(nativeContent, sourceCallIds)
        if (sourceKey === null) {
            srcIdx += 1
            continue
        }
        if (agentIdx >= liveAgents.length) return null
        const liveAgent = liveAgents[agentIdx]!
        const agentPos = liveAgent.invokedAt ?? liveAgent.createdAt
        if (lastTurnMinSeq !== null && liveAgent.seq <= lastTurnMinSeq) {
            return null
        }
        if (lastTurnInvokedAt !== null && agentPos < lastTurnInvokedAt) {
            return null
        }
        const nextTurn = segmentTurns[turnIdx]
        if (nextTurn) {
            const nextBounds = turnTimingBounds(nextTurn)
            if (
                nextBounds.minSeq !== null
                && nextBounds.minSeq < liveAgent.seq
                && nextBounds.minPos !== null
                && agentPos > nextBounds.minPos
            ) {
                return null
            }
        }
        const storedKey = liveCompareKey(liveAgent.content, storedCallIds)
        if (storedKey !== sourceKey) return null
        srcIdx += 1
        agentIdx += 1
    }

    if (turnIdx !== segmentTurns.length || agentIdx !== liveAgents.length) {
        return null
    }
    if (exactEnd && srcIdx !== segmentSource.length) {
        return null
    }
    return { matchedEnd: srcIdx, storedCallIds, sourceCallIds }
}

type MatchSegmentResult = {
    matchedEnd: number
    storedCallIds: Map<string, number>
    sourceCallIds: Map<string, number>
}

function getUserBatchEnd(liveUsers: StoredMessage[], start: number): number {
    const first = liveUsers[start]
    if (!first || first.invokedAt === null) return start + 1
    let end = start + 1
    while (end < liveUsers.length && liveUsers[end]?.invokedAt === first.invokedAt) {
        end += 1
    }
    return end
}

function matchLiveSegment(options: {
    segmentStored: StoredMessage[]
    segmentSource: LocalTranscriptMessage[]
    exactEnd: boolean
    sourceContentById: Map<string, unknown>
    liveCompareKey: (content: unknown, callIds?: Map<string, number>) => string | null
    liveUserBatchMatches?: (batch: StoredMessage[], nativeContent: unknown) => boolean
    storedCallIds: Map<string, number>
    sourceCallIds: Map<string, number>
}): MatchSegmentResult | null {
    const {
        segmentStored,
        segmentSource,
        exactEnd,
        sourceContentById,
        liveCompareKey,
        liveUserBatchMatches
    } = options

    const liveUsers: StoredMessage[] = []
    const liveAgents: StoredMessage[] = []
    for (const stored of segmentStored) {
        const payload = stored.content as { role?: unknown } | null
        if (payload?.role === 'user') {
            const undelivered = stored.deliveryState === 'indeterminate'
                || (stored.localId != null && stored.invokedAt == null)
            if (!undelivered) {
                liveUsers.push(stored)
            }
            continue
        }
        if (liveCompareKey(stored.content) !== null) {
            liveAgents.push(stored)
        }
    }
    liveUsers.sort((a, b) => ((a.invokedAt ?? a.createdAt) - (b.invokedAt ?? b.createdAt)) || (a.seq - b.seq))

    const failedStates = new Set<string>()

    function dfs(
        srcIdx: number,
        userIdx: number,
        agentIdx: number,
        lastUserFirstSeq: number | null,
        lastUserInvokedAt: number | null,
        curStoredCalls: Map<string, number>,
        curSourceCalls: Map<string, number>
    ): MatchSegmentResult | null {
        if (userIdx === liveUsers.length && agentIdx === liveAgents.length) {
            if (!exactEnd || srcIdx === segmentSource.length) {
                return {
                    matchedEnd: srcIdx,
                    storedCallIds: curStoredCalls,
                    sourceCallIds: curSourceCalls
                }
            }
        }
        if (srcIdx >= segmentSource.length) {
            return null
        }

        const stateKey = `${srcIdx}|${userIdx}|${agentIdx}|${lastUserFirstSeq ?? ''}|${lastUserInvokedAt ?? ''}`
        if (failedStates.has(stateKey)) {
            return null
        }

        const source = segmentSource[srcIdx]!
        const nativeContent = sourceContentById.get(source.id)
        const nativeRole = nativeContent && typeof nativeContent === 'object'
            ? (nativeContent as { role?: unknown }).role
            : undefined

        if (nativeRole === 'user') {
            if (userIdx >= liveUsers.length) {
                failedStates.add(stateKey)
                return null
            }
            const batchEnd = getUserBatchEnd(liveUsers, userIdx)
            for (let k = batchEnd - userIdx; k >= 1; k -= 1) {
                const batch = liveUsers.slice(userIdx, userIdx + k)
                const matches = liveUserBatchMatches
                    ? liveUserBatchMatches(batch, nativeContent)
                    : k === 1 && liveCompareKey(batch[0]!.content) === liveCompareKey(nativeContent)
                if (!matches) continue
                const result = dfs(
                    srcIdx + 1,
                    userIdx + k,
                    agentIdx,
                    batch[0]!.seq,
                    batch[0]!.invokedAt,
                    curStoredCalls,
                    curSourceCalls
                )
                if (result) return result
            }
            failedStates.add(stateKey)
            return null
        }

        const nextSourceCalls = new Map(curSourceCalls)
        const sourceKey = liveCompareKey(nativeContent, nextSourceCalls)
        if (sourceKey === null) {
            const result = dfs(
                srcIdx + 1,
                userIdx,
                agentIdx,
                lastUserFirstSeq,
                lastUserInvokedAt,
                curStoredCalls,
                nextSourceCalls
            )
            if (result) return result
            failedStates.add(stateKey)
            return null
        }

        if (agentIdx >= liveAgents.length) {
            failedStates.add(stateKey)
            return null
        }
        const liveAgent = liveAgents[agentIdx]!
        const agentPos = liveAgent.invokedAt ?? liveAgent.createdAt
        if (lastUserFirstSeq !== null && liveAgent.seq <= lastUserFirstSeq) {
            failedStates.add(stateKey)
            return null
        }
        if (lastUserInvokedAt !== null && agentPos < lastUserInvokedAt) {
            failedStates.add(stateKey)
            return null
        }
        const nextUser = liveUsers[userIdx]
        if (nextUser && nextUser.seq < liveAgent.seq && nextUser.invokedAt !== null && agentPos > nextUser.invokedAt) {
            failedStates.add(stateKey)
            return null
        }

        const nextStoredCalls = new Map(curStoredCalls)
        const storedKey = liveCompareKey(liveAgent.content, nextStoredCalls)
        if (storedKey !== sourceKey) {
            failedStates.add(stateKey)
            return null
        }

        const result = dfs(
            srcIdx + 1,
            userIdx,
            agentIdx + 1,
            lastUserFirstSeq,
            lastUserInvokedAt,
            nextStoredCalls,
            nextSourceCalls
        )
        if (result) return result
        failedStates.add(stateKey)
        return null
    }

    return dfs(
        0,
        0,
        0,
        null,
        null,
        new Map(options.storedCallIds),
        new Map(options.sourceCallIds)
    )
}

export function matchAnchored(options: {
    storedMessages: StoredMessage[]
    transcript: LocalTranscript
    importPrefix: string
    cursor: string | null
    /** Source-specific compare form (defaults to the full content). */
    canonicalContent?: (content: unknown) => unknown
    liveCompareKey?: (content: unknown, callIds?: Map<string, number>) => string | null
    liveUserBatchMatches?: (batch: StoredMessage[], nativeContent: unknown) => boolean
    liveNativeTurns?: LiveNativeTurnRecord[]
}): AnchoredMatchResult {
    const { storedMessages, transcript, importPrefix, cursor } = options
    const canonical = options.canonicalContent ?? ((content: unknown) => content)
    const sameContent = (source: unknown, stored: unknown): boolean =>
        isDeepStrictEqual(canonical(source), canonical(stored))
    const sourceMessages = transcript.messages
    const sourceIndexById = new Map(sourceMessages.map((message, index) => [message.id, index]))
    const sourceContentById = new Map(sourceMessages.map((message) => [
        message.id,
        truncateOversizedMessageContent(message.content)
    ]))
    const imported = storedMessages.filter((message) => message.localId?.startsWith(importPrefix))
    const cursorValue = cursor
    if (cursorValue !== null && transcript.anchorOrder !== undefined) {
        const anchorOrder = transcript.anchorOrder
        if (!anchorOrder.includes(cursorValue)) {
            return {
                status: 'transcript_diverged',
                message: 'The local transcript no longer contains the previously imported cursor position'
            }
        }
        // R1: stored imports stay an in-order subsequence of the transcript
        // with unchanged content.
        let priorSourceIndex = -1
        for (const message of imported) {
            const sourceIndex = sourceIndexById.get(message.localId!)
            if (sourceIndex === undefined || sourceIndex <= priorSourceIndex) {
                return {
                    status: 'transcript_diverged',
                    message: 'Local transcript no longer extends the previously imported history'
                }
            }
            priorSourceIndex = sourceIndex
        }
        const changed = imported.find((message) => !sameContent(sourceContentById.get(message.localId!), message.content))
        if (changed?.localId) {
            return {
                status: 'transcript_diverged',
                message: `Local transcript changed imported entry ${changed.localId}`
            }
        }
        // R3: anchor is the later of the last import and the cursor.
        const positionByAnchor = new Map(anchorOrder.map((anchor, index) => [anchor, index]))
        const lastImported = imported.at(-1)
        const lastImportedAnchor = lastImported?.localId != null
            ? sourceMessages[sourceIndexById.get(lastImported.localId)!]?.anchor
            : undefined
        const lastImportedPosition = lastImportedAnchor !== undefined
            ? positionByAnchor.get(lastImportedAnchor)
            : undefined
        const cursorPosition = positionByAnchor.get(cursorValue)
        const anchorPosition = Math.max(lastImportedPosition ?? -1, cursorPosition ?? -1)
        const deltaAnchors = new Set(anchorOrder.slice(anchorPosition + 1))
        // Delta: every transcript entry after the anchor (already-imported
        // localIds are deduped again on insert).
        const delta = sourceMessages.filter((message) => message.anchor !== undefined && deltaAnchors.has(message.anchor))
        return { status: 'ok', delta }
    }

    if (options.liveCompareKey && imported.length && storedMessages.length > imported.length) {
        const pins: Array<{ storedIndex: number; sourceIndex: number; message: StoredMessage }> = []
        let prevPinSourceIndex = -1
        for (let storedIndex = 0; storedIndex < storedMessages.length; storedIndex += 1) {
            const stored = storedMessages[storedIndex]!
            if (!stored.localId?.startsWith(importPrefix)) continue
            const sourceIndex = sourceIndexById.get(stored.localId)
            if (sourceIndex === undefined || sourceIndex <= prevPinSourceIndex) {
                return { status: 'transcript_diverged', message: 'The stored conversation no longer matches the native transcript prefix' }
            }
            const nativeContent = sourceContentById.get(stored.localId)
            if (!sameContent(nativeContent, stored.content)) {
                return { status: 'transcript_diverged', message: 'The stored conversation no longer matches the native transcript prefix' }
            }
            pins.push({ storedIndex, sourceIndex, message: stored })
            prevPinSourceIndex = sourceIndex
        }

        const nativeTurns = options.liveNativeTurns
        const claimedTurnIndices = new Set<number>()
        let storedCallIds = new Map<string, number>()
        let sourceCallIds = new Map<string, number>()
        let prevStoredIndex = -1
        let prevSourceIndex = -1
        for (const pin of pins) {
            const segmentStored = storedMessages.slice(prevStoredIndex + 1, pin.storedIndex)
            const segmentSource = sourceMessages.slice(prevSourceIndex + 1, pin.sourceIndex)
            const gapMatch = nativeTurns !== undefined
                ? matchProvenanceSegment({
                    segmentStored,
                    segmentSource,
                    exactEnd: true,
                    sourceContentById,
                    liveCompareKey: options.liveCompareKey,
                    allNativeTurns: nativeTurns,
                    claimedTurnIndices,
                    storedCallIds,
                    sourceCallIds
                })
                : matchLiveSegment({
                    segmentStored,
                    segmentSource,
                    exactEnd: true,
                    sourceContentById,
                    liveCompareKey: options.liveCompareKey,
                    liveUserBatchMatches: options.liveUserBatchMatches,
                    storedCallIds,
                    sourceCallIds
                })
            if (!gapMatch) {
                return { status: 'transcript_diverged', message: 'The stored conversation no longer matches the native transcript prefix' }
            }
            storedCallIds = gapMatch.storedCallIds
            sourceCallIds = gapMatch.sourceCallIds
            options.liveCompareKey(pin.message.content, storedCallIds)
            options.liveCompareKey(sourceContentById.get(pin.message.localId!), sourceCallIds)
            prevStoredIndex = pin.storedIndex
            prevSourceIndex = pin.sourceIndex
        }

        const tailStored = storedMessages.slice(prevStoredIndex + 1)
        const tailSource = sourceMessages.slice(prevSourceIndex + 1)
        const tailMatch = nativeTurns !== undefined
            ? matchProvenanceSegment({
                segmentStored: tailStored,
                segmentSource: tailSource,
                exactEnd: false,
                sourceContentById,
                liveCompareKey: options.liveCompareKey,
                allNativeTurns: nativeTurns,
                claimedTurnIndices,
                storedCallIds,
                sourceCallIds
            })
            : matchLiveSegment({
                segmentStored: tailStored,
                segmentSource: tailSource,
                exactEnd: false,
                sourceContentById,
                liveCompareKey: options.liveCompareKey,
                liveUserBatchMatches: options.liveUserBatchMatches,
                storedCallIds,
                sourceCallIds
            })
        if (!tailMatch) {
            return { status: 'transcript_diverged', message: 'The stored conversation no longer matches the native transcript prefix' }
        }
        if (nativeTurns !== undefined && claimedTurnIndices.size !== nativeTurns.length) {
            return { status: 'transcript_diverged', message: 'The stored conversation no longer matches the native transcript prefix' }
        }
        return { status: 'ok', delta: sourceMessages.slice(prevSourceIndex + 1 + tailMatch.matchedEnd) }
    }

    // No cursor: the imported prefix must align exactly with the head of the
    // transcript (OpenCode's strict prefix rule; Pi without a stored leaf).
    for (let index = 0; index < imported.length; index += 1) {
        const stored = imported[index]!
        const source = sourceMessages[index]
        if (!source || source.id !== stored.localId) {
            return {
                status: 'transcript_diverged',
                message: `Local transcript changed or dropped imported entry ${stored.localId}`
            }
        }
        if (!sameContent(sourceContentById.get(source.id), stored.content)) {
            return {
                status: 'transcript_diverged',
                message: `Local transcript changed or dropped imported entry ${stored.localId}`
            }
        }
    }
    const delta = sourceMessages.slice(imported.length)
    const storedExtras = storedMessages.length - imported.length
    if (storedExtras > 0 && delta.length > 0) {
        // R4/R5: without a cursor the HAPI side must not have messages outside
        // the imported prefix when the source still advances.
        if (imported.length === 0) {
            return {
                status: 'already_in_hapi',
                message: 'This HAPI session was not imported from the local history; importing would duplicate its messages'
            }
        }
        return {
            status: 'transcript_diverged',
            message: 'The HAPI session continued past the imported history; re-importing would duplicate or reorder messages'
        }
    }
    return { status: 'ok', delta }
}
