package com.slopus.happy.chat

import androidx.compose.runtime.Immutable
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.model.claudeAgentSettingsEnabled
import com.slopus.happy.model.isClaudeAgentMirror
import com.slopus.happy.model.isRig
import com.slopus.happy.model.isRigV1
import com.slopus.happy.model.qualifyRigModelKey
import com.slopus.happy.model.rigComposerMode
import com.slopus.happy.model.rigModels
import com.slopus.happy.model.rigSelectedModel
import com.slopus.happy.model.runningModel
import com.slopus.happy.model.settings.AgentDefaultOverrides
import com.slopus.happy.model.settings.AgentDefaults
import com.slopus.happy.model.settings.ModeOption
import com.slopus.happy.model.settings.ModeOptions
import com.slopus.happy.sync.AgentModeField
import com.slopus.happy.sync.ComposerMirror

/**
 * useComposerModes.ts `ComposerModes`: what the composer's permission, model
 * and effort chips list and show. The `can*` flags are rig.ts's
 * `isRig*SelectionEnabled`: a Happy Agent session may lock a picker.
 */
@Immutable
data class ComposerModes(
    val availableModes: List<ModeOption> = emptyList(),
    val permissionMode: ModeOption? = null,
    val availableModels: List<ModeOption> = emptyList(),
    val modelMode: ModeOption? = null,
    val availableEffortLevels: List<ModeOption> = emptyList(),
    val effortLevel: ModeOption? = null,
    val canChangePermission: Boolean = false,
    val canChangeModel: Boolean = false,
    val canChangeEffort: Boolean = false,
) {
    companion object {
        val None = ComposerModes()
    }
}

/**
 * rig.ts `isRigModelSelectionEnabled`. A Mac background session is switched by
 * its mirror, which only a mirror from a CLI with [claudeAgentSettingsEnabled] does.
 */
fun SessionMetadata?.rigModelSelectionEnabled(): Boolean =
    if (isClaudeAgentMirror()) claudeAgentSettingsEnabled() else (!isRigV1() || (this?.session?.modelLocked != true && this?.capabilities?.modelSelection != false))

/** rig.ts `isRigReasoningSelectionEnabled` */
fun SessionMetadata?.rigReasoningSelectionEnabled(): Boolean =
    if (isClaudeAgentMirror()) claudeAgentSettingsEnabled() else (!isRigV1() || this?.capabilities?.reasoningSelection != false)

/** rig.ts `isRigPermissionSelectionEnabled` */
fun SessionMetadata?.rigPermissionSelectionEnabled(): Boolean =
    if (isClaudeAgentMirror()) claudeAgentSettingsEnabled() else (!isRigV1() || this?.capabilities?.permissionModeSelection != false)

object ComposerModeResolver {
    /**
     * useComposerModes: each chip's value is the session's own pick
     * ([mirror]) when the list has it, then, for a Happy Agent session,
     * what the agent reports; for any other, the user's agent default and
     * then what the agent reports. A pick on a retired Claude row shows the
     * row that runs the same model.
     */
    fun resolve(
        metadata: SessionMetadata?,
        mirror: ComposerMirror,
        overrides: AgentDefaultOverrides?,
        translate: (Int) -> String,
    ): ComposerModes {
        if (metadata.isClaudeAgentMirror()) return resolveMacSession(metadata, translate)
        val flavor = metadata?.flavor
        val rig = metadata.isRig()
        val defaults = AgentDefaults.resolve(overrides, flavor, metadata?.version)
        val sessionModel = if (rig) mirror.modelMode else AgentDefaults.retireModelMode(flavor, mirror.modelMode)
        val models = ModeOptions.availableModels(flavor, metadata, translate, sessionModel ?: if (rig) null else defaults.modelMode)
        val modes = ModeOptions.availablePermissionModes(flavor, metadata, translate, mirror.permissionMode)
        val permission = ModeOptions.resolveCurrentOption(
            modes,
            if (rig) {
                listOf(mirror.permissionMode, metadata?.currentOperatingModeCode, metadata?.permissionMode, metadata?.session?.permissionMode)
            } else {
                listOf(mirror.permissionMode, defaults.permissionMode, metadata?.currentOperatingModeCode)
            },
        )
        val rigModelKey = metadata.rigSelectedModel()?.let { (provider, id) -> qualifyRigModelKey(provider, id) }
        val model = ModeOptions.resolveCurrentOption(
            models,
            listOf(sessionModel, if (rig) rigModelKey else defaults.modelMode, if (rig) null else metadata?.currentModelCode),
        )
        val modelKey = model?.key ?: "default"
        val efforts = ModeOptions.effortLevelsForModel(flavor, modelKey, metadata)
        val effort = ModeOptions.resolveCurrentOption(
            efforts,
            listOf(mirror.effortLevel, if (rig) rigReasoningSelection(metadata, modelKey, efforts) else defaults.effortLevel),
        )
        return ComposerModes(
            availableModes = modes,
            permissionMode = permission,
            availableModels = models,
            modelMode = model,
            availableEffortLevels = efforts,
            effortLevel = effort,
            canChangePermission = metadata.rigPermissionSelectionEnabled(),
            canChangeModel = metadata.rigModelSelectionEnabled(),
            canChangeEffort = metadata.rigReasoningSelectionEnabled(),
        )
    }

    /**
     * A Mac background session: each chip shows what the mirror last saw the
     * session run with (the metadata's current codes, else the model of its
     * transcript), never a pick of the phone's or a default; a pick goes to the
     * Mac at once and shows once the mirror reports it back.
     */
    private fun resolveMacSession(metadata: SessionMetadata?, translate: (Int) -> String): ComposerModes {
        val modes = ModeOptions.macSessionPermissionModes(translate)
        val running = metadata?.currentModelCode ?: metadata.runningModel()
        val models = ModeOptions.availableModels("claude", metadata, translate, running)
        val efforts = ModeOptions.effortLevelsForModel("claude", running)
        val enabled = metadata.claudeAgentSettingsEnabled()
        return ComposerModes(
            availableModes = modes,
            permissionMode = ModeOptions.resolveCurrentOption(modes, listOf(metadata?.currentOperatingModeCode)),
            availableModels = models,
            modelMode = running?.let { key -> models.find { it.key == key } ?: ModeOption(key, key) },
            availableEffortLevels = efforts,
            effortLevel = ModeOptions.resolveCurrentOption(efforts, listOf(metadata?.currentThoughtLevelCode)),
            canChangePermission = enabled,
            canChangeModel = enabled,
            canChangeEffort = enabled,
        )
    }

    // rig.ts getRigReasoningSelection, against the levels already resolved for the model.
    private fun rigReasoningSelection(metadata: SessionMetadata?, modelKey: String, levels: List<ModeOption>): String? {
        val keys = levels.map { it.key }
        val explicit = metadata.rigComposerMode()?.effort ?: metadata?.reasoning?.current ?: metadata?.currentThoughtLevelCode
        if (explicit != null && explicit in keys) return explicit
        val modelDefault = metadata.rigModels().find { it.key == modelKey }?.defaultThinkingLevel
        return modelDefault?.takeIf { it in keys }
    }

    /**
     * SessionView.tsx's `update*` handlers: only the field picked, except
     * that a model whose levels lack the session's effort pick also resets
     * effort to the model's default (null clears the pick).
     */
    fun patch(field: AgentModeField, option: ModeOption, metadata: SessionMetadata?, mirror: ComposerMirror): Map<AgentModeField, String?> {
        if (field != AgentModeField.MODEL_MODE) return mapOf(field to option.key)
        val effort = mirror.effortLevel ?: return mapOf(field to option.key)
        val levels = ModeOptions.effortLevelsForModel(metadata?.flavor, option.key, metadata)
        if (levels.any { it.key == effort }) return mapOf(field to option.key)
        return mapOf(field to option.key, AgentModeField.EFFORT_LEVEL to option.defaultThinkingLevel)
    }
}
