import { describe, expect, it } from 'vitest'
import { buildHermesModelOptions } from './hermesModelOptions'

describe('buildHermesModelOptions', () => {
    it('keeps unique model labels unchanged', () => {
        expect(buildHermesModelOptions([
            { modelId: 'custom:gpt-5', name: 'GPT-5', description: 'Provider: openai' },
            { modelId: 'custom:claude-4', name: 'Claude 4', description: 'Provider: anthropic' }
        ])).toEqual([
            { value: 'custom:gpt-5', label: 'GPT-5' },
            { value: 'custom:claude-4', label: 'Claude 4' }
        ])
    })

    it('qualifies duplicate model names with their provider (stripping current suffix)', () => {
        expect(buildHermesModelOptions([
            { modelId: 'custom:qwen-plus', name: 'qwen-plus', description: 'Provider: dashscope • current' },
            { modelId: 'custom:openrouter:qwen-plus', name: 'qwen-plus', description: 'Provider: openrouter' },
            { modelId: 'custom:unique', name: 'unique-model', description: 'Provider: openrouter' }
        ])).toEqual([
            { value: 'custom:qwen-plus', label: 'qwen-plus (dashscope)' },
            { value: 'custom:openrouter:qwen-plus', label: 'qwen-plus (openrouter)' },
            { value: 'custom:unique', label: 'unique-model' }
        ])
    })

    it('falls back to modelId when descriptions are missing or still collide', () => {
        expect(buildHermesModelOptions([
            { modelId: 'custom:shared', name: 'shared' },
            { modelId: 'custom:backup:shared', name: 'shared' }
        ])).toEqual([
            { value: 'custom:shared', label: 'shared (custom:shared)' },
            { value: 'custom:backup:shared', label: 'shared (custom:backup:shared)' }
        ])

        expect(buildHermesModelOptions([
            { modelId: 'provider-a:same', name: 'same', description: 'Provider: proxy' },
            { modelId: 'provider-b:same', name: 'same', description: 'Provider: proxy' }
        ])).toEqual([
            { value: 'provider-a:same', label: 'same (provider-a:same)' },
            { value: 'provider-b:same', label: 'same (provider-b:same)' }
        ])
    })
})
