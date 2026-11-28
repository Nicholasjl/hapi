import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
    normalizeHermesCurrentModelId,
    resolveHermesConfigModels
} from './hermesConfiguredModels'

const tempDirs: string[] = []

function writeTempConfig(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-cfg-'))
    tempDirs.push(dir)
    const filePath = join(dir, 'config.yaml')
    writeFileSync(filePath, content, 'utf8')
    return filePath
}

describe('resolveHermesConfigModels', () => {
    afterEach(() => {
        while (tempDirs.length > 0) {
            rmSync(tempDirs.pop()!, { recursive: true, force: true })
        }
    })

    it('uses normalized custom:<provider>:<model> for every named provider including the configured default', () => {
        const filePath = writeTempConfig(`
model:
  provider: DashScope
  default: qwen-plus
providers:
  DashScope:
    models:
      - qwen-plus
      - gemini/gemini-3.5-flash-lite
  magpie-anthropic:
    models:
      - qwen-plus
      - agy-wsl/claude-opus-5-5-high
`)
        const models = resolveHermesConfigModels(filePath, 'custom:qwen-plus')
        expect(models).toEqual([
            {
                modelId: 'custom:dashscope:qwen-plus',
                name: 'qwen-plus',
                description: 'Provider: DashScope'
            },
            {
                modelId: 'custom:dashscope:gemini/gemini-3.5-flash-lite',
                name: 'gemini/gemini-3.5-flash-lite',
                description: 'Provider: DashScope'
            },
            {
                modelId: 'custom:magpie-anthropic:qwen-plus',
                name: 'qwen-plus',
                description: 'Provider: magpie-anthropic'
            },
            {
                modelId: 'custom:magpie-anthropic:agy-wsl/claude-opus-5-5-high',
                name: 'agy-wsl/claude-opus-5-5-high',
                description: 'Provider: magpie-anthropic'
            }
        ])
        expect(normalizeHermesCurrentModelId('custom:qwen-plus', models!, filePath)).toBe('custom:dashscope:qwen-plus')
    })

    it('uses generic custom:<model> only when the provider itself is generic custom', () => {
        const filePath = writeTempConfig(`
model:
  provider: custom
providers:
  custom:
    models:
      - local-qwen
  backup:
    models:
      - local-qwen
`)
        const models = resolveHermesConfigModels(filePath, 'custom:local-qwen')
        expect(models).toEqual([
            {
                modelId: 'custom:local-qwen',
                name: 'local-qwen',
                description: 'Provider: custom'
            },
            {
                modelId: 'custom:backup:local-qwen',
                name: 'local-qwen',
                description: 'Provider: backup'
            }
        ])
    })

    it('preserves ACP-advertised model IDs when available and avoids duplicating bare custom:<model>', () => {
        const filePath = writeTempConfig(`
model:
  provider: magpie
providers:
  magpie:
    models:
      - qwen-plus
  backup:
    models:
      - qwen-plus
`)
        const models = resolveHermesConfigModels(filePath, 'custom:qwen-plus', [
            { modelId: 'custom:qwen-plus', name: 'qwen-plus' },
            { modelId: 'custom:backup:qwen-plus', name: 'Backup Qwen', description: 'ACP backup' },
            { modelId: 'openrouter:anthropic/claude-sonnet-4', name: 'claude-sonnet-4' }
        ])
        expect(models).toEqual([
            {
                modelId: 'custom:magpie:qwen-plus',
                name: 'qwen-plus',
                description: 'Provider: magpie'
            },
            {
                modelId: 'custom:backup:qwen-plus',
                name: 'Backup Qwen',
                description: 'ACP backup'
            },
            {
                modelId: 'openrouter:anthropic/claude-sonnet-4',
                name: 'claude-sonnet-4'
            }
        ])
    })

    it('returns null for built-in providers not defined under providers', () => {
        const filePath = writeTempConfig(`
model:
  provider: openrouter
`)
        expect(resolveHermesConfigModels(filePath, 'openrouter:anthropic/claude-sonnet-4')).toBeNull()
    })
})
