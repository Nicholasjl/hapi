import type { Flavors, PermissionModeOf } from '@hapi/protocol/types'

export type HermesPermissionMode = PermissionModeOf<typeof Flavors.hermes>

export type HermesMode = {
    permissionMode?: HermesPermissionMode
    model?: string | null
}

export function hermesModeForPreference(
    permissionMode: HermesPermissionMode | undefined,
    model: string | null | undefined
): HermesMode {
    const mode: HermesMode = {}
    if (permissionMode) {
        mode.permissionMode = permissionMode
    }
    if (model === null) {
        mode.model = null
    } else if (typeof model === 'string' && model.trim().length > 0) {
        mode.model = model.trim()
    }
    return mode
}
