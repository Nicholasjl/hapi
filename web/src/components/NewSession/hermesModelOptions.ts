import type { HermesModelSummary } from '@/types/api'

function extractProviderLabel(description: string | undefined): string | null {
    if (!description) return null
    const strippedCurrent = description.replace(/\s*[•·-]\s*current\s*$/i, '').trim()
    const match = /^Provider:\s*(.+)$/i.exec(strippedCurrent)
    const candidate = (match ? match[1] : strippedCurrent).trim()
    return candidate.length > 0 ? candidate : null
}

/**
 * Formats Hermes model picker options while disambiguating entries whose base
 * display names collide across configured providers.
 */
export function buildHermesModelOptions(
    models: ReadonlyArray<HermesModelSummary>
): Array<{ value: string; label: string }> {
    const baseLabels = models.map((entry) => entry.name?.trim() || entry.modelId)
    const baseCounts = new Map<string, number>()
    for (const base of baseLabels) {
        baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1)
    }

    const withProviderLabels = models.map((entry, index) => {
        const base = baseLabels[index]!
        if ((baseCounts.get(base) ?? 0) <= 1) {
            return base
        }
        const provider = extractProviderLabel(entry.description)
        return provider ? `${base} (${provider})` : `${base} (${entry.modelId})`
    })

    const labelCounts = new Map<string, number>()
    for (const label of withProviderLabels) {
        labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1)
    }

    return models.map((entry, index) => {
        const candidate = withProviderLabels[index]!
        if ((labelCounts.get(candidate) ?? 0) <= 1) {
            return { value: entry.modelId, label: candidate }
        }
        const base = baseLabels[index]!
        return { value: entry.modelId, label: `${base} (${entry.modelId})` }
    })
}
