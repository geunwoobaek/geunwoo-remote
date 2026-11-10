package com.slopus.happy.sync

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// A new Claude chat started as a Mac background session: the daemon's
// `start-claude-agent` runs `claude --bg` in the folder and opens its mirror;
// `discard-claude-agent` stops and removes one it started, and only such a one.

/** The longest a background session's name is (the first line of the first message, cut). */
const val CLAUDE_AGENT_NAME_MAX = 40

/**
 * The name a new background session is given: the first line of [firstMessage],
 * trimmed and cut to [CLAUDE_AGENT_NAME_MAX]; if that is empty, the last
 * segment of [directory].
 */
fun claudeAgentName(firstMessage: String, directory: String): String =
    claudeAgentNameFromMessage(firstMessage) ?: directory.trimEnd('/').substringAfterLast('/').ifEmpty { directory }

/** The message's part of [claudeAgentName]; null when its first line is blank. */
fun claudeAgentNameFromMessage(firstMessage: String): String? =
    firstMessage.trimStart().lineSequence().firstOrNull()?.trim()?.take(CLAUDE_AGENT_NAME_MAX)?.trim()?.takeIf { it.isNotEmpty() }

/** `start-claude-agent`'s request. Null modes are left out: the Mac's `claude` uses its own. */
data class StartClaudeAgentRequest(
    val directory: String,
    val name: String,
    val model: String? = null,
    val permissionMode: String? = null,
    val effort: String? = null,
    val approvedNewDirectoryCreation: Boolean = false,
    /** The same id for a retry of the same start: the daemon answers it with the first one's session. */
    val clientRequestId: String? = null,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("directory", directory)
        put("name", name)
        putIfNotNull("model", model)
        putIfNotNull("permissionMode", permissionMode)
        putIfNotNull("effort", effort)
        put("approvedNewDirectoryCreation", approvedNewDirectoryCreation)
        putIfNotNull("clientRequestId", clientRequestId)
    }
}

/** What `start-claude-agent` came to. */
sealed interface StartClaudeAgentResult {
    /** The background session [agentId] runs, mirrored by the Happy session [sessionId]. */
    data class Success(val sessionId: String, val agentId: String) : StartClaudeAgentResult

    /** The folder is not there; ask again with approval to create it. */
    data class NeedsDirectoryApproval(val directory: String) : StartClaudeAgentResult

    /** Claude on the Mac has not been trusted in [directory] yet. */
    data class Untrusted(val directory: String, val message: String) : StartClaudeAgentResult

    /**
     * [code]: the daemon's `claude-missing`, `tmux-missing` or `start-failed`;
     * this app's `unreadable` for an answer it could not read, or
     * `call-failed` when no answer came back (the start may still be running).
     */
    data class Failed(val code: String, val message: String) : StartClaudeAgentResult

    companion object {
        const val UNREADABLE = "unreadable"
        const val CALL_FAILED = "call-failed"
        const val START_FAILED = "start-failed"
        const val UNTRUSTED_FOLDER = "untrusted-folder"

        /** The daemon's answer; anything of a shape this app does not know is unreadable. */
        fun parse(json: JsonElement?, requestedDirectory: String? = null): StartClaudeAgentResult {
            val answer = json as? JsonObject ?: return Failed(UNREADABLE, SpawnSessionResult.UNREADABLE)
            return when (answer.string("type")) {
                "success" -> {
                    val sessionId = answer.string("sessionId")?.takeIf { it.isNotEmpty() }
                    val agentId = answer.string("agentId")?.takeIf { it.isNotEmpty() }
                    if (sessionId != null && agentId != null) Success(sessionId, agentId) else null
                }
                "requestToApproveDirectoryCreation" -> answer.string("directory")?.takeIf { it.isNotEmpty() }?.let(::NeedsDirectoryApproval)
                "error" -> {
                    val code = answer.string("code")?.takeIf { it.isNotEmpty() } ?: START_FAILED
                    val message = answer.string("errorMessage")?.takeIf { it.isNotEmpty() } ?: "Failed to start session"
                    if (code == UNTRUSTED_FOLDER) {
                        Untrusted(answer.string("directory")?.takeIf { it.isNotEmpty() } ?: requestedDirectory.orEmpty(), message)
                    } else {
                        Failed(code, message)
                    }
                }
                else -> null
            } ?: Failed(UNREADABLE, SpawnSessionResult.UNREADABLE)
        }
    }
}

/** What `discard-claude-agent` came to. */
sealed interface DiscardClaudeAgentResult {
    data object Success : DiscardClaudeAgentResult

    /** [code]: `not-started-here`, `discard-failed`, or `unreadable`. */
    data class Failed(val code: String, val message: String) : DiscardClaudeAgentResult

    companion object {
        fun parse(json: JsonElement?): DiscardClaudeAgentResult {
            val answer = json as? JsonObject ?: return Failed(StartClaudeAgentResult.UNREADABLE, SpawnSessionResult.UNREADABLE)
            return when (answer.string("type")) {
                "success" -> Success
                "error" -> Failed(
                    answer.string("code")?.takeIf { it.isNotEmpty() } ?: "discard-failed",
                    answer.string("errorMessage")?.takeIf { it.isNotEmpty() } ?: "Failed to discard session",
                )
                else -> Failed(StartClaudeAgentResult.UNREADABLE, SpawnSessionResult.UNREADABLE)
            }
        }
    }
}
