import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { HermesModelSummary } from '@hapi/protocol/apiTypes'

interface HermesYamlProviderConfig {
    models?: unknown
}

interface HermesYamlConfig {
    model?: {
        provider?: unknown
    }
    providers?: Record<string, HermesYamlProviderConfig | undefined>
}

export function normalizeHermesCustomProvider(providerName: string): string {
    let normalized = providerName.trim().toLowerCase()
    if (normalized.startsWith('custom:')) {
        normalized = normalized.slice('custom:'.length).trim()
    }
    return normalized
}

export function formatHermesCustomModelId(providerName: string, modelName: string): string {
    const normalizedProvider = normalizeHermesCustomProvider(providerName)
    if (!normalizedProvider || normalizedProvider === 'custom') {
        return `custom:${modelName}`
    }
    return `custom:${normalizedProvider}:${modelName}`
}

function readParsedHermesConfig(configPath: string): HermesYamlConfig | null {
    if (!existsSync(configPath)) return null

    let parsed: HermesYamlConfig | null = null
    try {
        parsed = parseYaml(readFileSync(configPath, 'utf8')) as HermesYamlConfig | null
    } catch {
        return null
    }
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
}

function displayModelName(modelId: string, normalizedProvider: string): string {
    if (normalizedProvider && normalizedProvider !== 'custom') {
        const qualifiedPrefix = `custom:${normalizedProvider}:`
        if (modelId.toLowerCase().startsWith(qualifiedPrefix)) {
            return modelId.slice(qualifiedPrefix.length)
        }
        const barePrefix = `${normalizedProvider}:`
        if (modelId.toLowerCase().startsWith(barePrefix)) {
            return modelId.slice(barePrefix.length)
        }
    }
    return modelId.includes(':') ? modelId.slice(modelId.indexOf(':') + 1) : modelId
}

function findMatchingAcpModel(
    acpModels: ReadonlyArray<HermesModelSummary>,
    providerName: string,
    modelName: string
): HermesModelSummary | undefined {
    const normalizedProvider = normalizeHermesCustomProvider(providerName)
    const canonicalId = formatHermesCustomModelId(providerName, modelName).toLowerCase()
    const rawProvider = providerName.trim().toLowerCase()
    const candidateIds = new Set<string>([canonicalId])
    if (rawProvider && rawProvider !== 'custom') {
        candidateIds.add(`custom:${rawProvider}:${modelName}`.toLowerCase())
        candidateIds.add(`${normalizedProvider}:${modelName}`.toLowerCase())
        candidateIds.add(`${rawProvider}:${modelName}`.toLowerCase())
    } else {
        candidateIds.add(modelName.toLowerCase())
    }
    return acpModels.find((entry) => candidateIds.has(entry.modelId.trim().toLowerCase()))
}

export function normalizeHermesCurrentModelId(
    currentModelId: string | null | undefined,
    availableModels: ReadonlyArray<HermesModelSummary>,
    configPath: string = join(process.env.HERMES_HOME || join(homedir(), '.hermes'), 'config.yaml')
): string | null {
    const current = typeof currentModelId === 'string' ? currentModelId.trim() : ''
    if (!current) return null
    if (availableModels.some((entry) => entry.modelId === current)) {
        return current
    }
    const parsed = readParsedHermesConfig(configPath)
    const activeProvider = typeof parsed?.model?.provider === 'string'
        ? parsed.model.provider.trim()
        : ''
    const normalizedActive = normalizeHermesCustomProvider(activeProvider)
    if (normalizedActive && normalizedActive !== 'custom' && current.toLowerCase().startsWith('custom:')) {
        const suffix = current.slice('custom:'.length).trim()
        const qualified = `custom:${normalizedActive}:${suffix}`
        if (availableModels.some((entry) => entry.modelId === qualified)) {
            return qualified
        }
    }
    return current
}

export function resolveHermesConfigModels(
    configPath: string = join(process.env.HERMES_HOME || join(homedir(), '.hermes'), 'config.yaml'),
    currentModelId?: string | null,
    acpAvailableModels?: ReadonlyArray<HermesModelSummary> | null
): HermesModelSummary[] | null {
    const parsed = readParsedHermesConfig(configPath)
    if (!parsed) return null

    const activeProvider = typeof parsed.model?.provider === 'string'
        ? parsed.model.provider.trim()
        : ''
    const providers = parsed.providers
    if (!activeProvider || !providers || typeof providers !== 'object') return null

    const activeConfig = providers[activeProvider]
    if (!activeConfig || !Array.isArray(activeConfig.models) || activeConfig.models.length === 0) {
        return null
    }

    const normalizedActiveProvider = normalizeHermesCustomProvider(activeProvider)
    const activeNamedModels = new Set(
        activeConfig.models
            .filter((entry): entry is string => typeof entry === 'string')
            .map((entry) => entry.trim())
            .filter(Boolean)
    )
    const acpModels = Array.isArray(acpAvailableModels)
        ? acpAvailableModels.filter((entry) => typeof entry.modelId === 'string' && entry.modelId.trim().length > 0)
        : []

    const result: HermesModelSummary[] = []
    const seen = new Set<string>()

    const addProviderModels = (providerName: string, rawModels: unknown) => {
        if (!Array.isArray(rawModels)) return
        for (const entry of rawModels) {
            if (typeof entry !== 'string') continue
            const modelName = entry.trim()
            if (!modelName) continue
            const acpMatch = findMatchingAcpModel(acpModels, providerName, modelName)
            const modelId = acpMatch?.modelId.trim() || formatHermesCustomModelId(providerName, modelName)
            if (seen.has(modelId)) continue
            seen.add(modelId)
            result.push({
                modelId,
                name: acpMatch?.name?.trim() || modelName,
                description: acpMatch?.description?.trim() || `Provider: ${providerName}`
            })
        }
    }

    addProviderModels(activeProvider, activeConfig.models)
    for (const [providerName, providerConfig] of Object.entries(providers)) {
        if (providerName === activeProvider || !providerConfig) continue
        addProviderModels(providerName, providerConfig.models)
    }

    for (const entry of acpModels) {
        const modelId = entry.modelId.trim()
        if (seen.has(modelId)) continue
        // Avoid re-adding an unqualified generic `custom:<model>` ACP row when the
        // named default provider already emitted `custom:<provider>:<model>`.
        if (
            normalizedActiveProvider
            && normalizedActiveProvider !== 'custom'
            && modelId.toLowerCase().startsWith('custom:')
        ) {
            const suffix = modelId.slice('custom:'.length).trim()
            if (activeNamedModels.has(suffix) && seen.has(`custom:${normalizedActiveProvider}:${suffix}`)) {
                continue
            }
        }
        seen.add(modelId)
        result.push({
            modelId,
            ...(entry.name ? { name: entry.name } : {}),
            ...(entry.description ? { description: entry.description } : {})
        })
    }

    const resolvedCurrent = normalizeHermesCurrentModelId(currentModelId, result, configPath)
    if (resolvedCurrent && !seen.has(resolvedCurrent)) {
        result.unshift({
            modelId: resolvedCurrent,
            name: displayModelName(resolvedCurrent, normalizedActiveProvider),
            description: `Provider: ${activeProvider} • current`
        })
    }

    return result.length > 0 ? result : null
}
