package com.slopus.happy.sync

import com.slopus.happy.model.RemoteTask
import com.slopus.happy.model.RemoteTaskKind
import com.slopus.happy.model.RemoteTaskStatus
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

// The Mac's `claude agents` background sessions, as the daemon's
// `list-claude-agents` and `open-claude-agent` machine RPCs answer them.

/** One background session on a Mac. [status] is the daemon's word for it (busy, idle, waiting). */
data class ClaudeAgentEntry(
    val id: String,
    val sessionId: String,
    val name: String?,
    val cwd: String,
    val status: String,
    /** Epoch milliseconds. */
    val startedAt: Long,
    /** The Happy session already mirroring it, once one was opened. */
    val mirrorSessionId: String?,
    /**
     * `claude agents`' own grouping (working, blocked, done), null from a
     * daemon that does not send it. A session done with a shell still open is
     * busy by [status] yet done here, so this one decides.
     */
    val state: String? = null,
    /** Its newest answer line or tool call, read from the Mac's transcript; null from a daemon that does not send it. */
    val lastLine: String? = null,
)

/**
 * What a machine listed. [unavailable] says why it could not: `tmux-missing`,
 * `claude-missing`, `agents-command-failed`, or `unsupported` (a daemon from
 * before the feature, which this app, not the daemon, puts there).
 * [startSupported]: the daemon has `start-claude-agent`, so a new Claude chat
 * can start there as a background session.
 */
data class ClaudeAgentsListing(val agents: List<ClaudeAgentEntry>, val unavailable: String?, val startSupported: Boolean = false)

/** What `open-claude-agent` came to. */
sealed interface OpenClaudeAgentResult {
    data class Success(val sessionId: String) : OpenClaudeAgentResult

    data class Error(val message: String) : OpenClaudeAgentResult
}

/** The server's answer for a machine RPC the daemon does not register. */
internal const val RPC_METHOD_NOT_AVAILABLE = "RPC method not available"

/** Shown when the Mac's daemon predates `revive-claude-agent`. */
const val REVIVE_UNSUPPORTED = "This Mac session has ended, and the Mac's happy is too old to restart it. Update it on the Mac."

/** What `revive-claude-agent` came to; [Success.revived] is false when the session was running anyway. */
sealed interface ReviveClaudeAgentResult {
    data class Success(val revived: Boolean) : ReviveClaudeAgentResult

    data class Error(val message: String) : ReviveClaudeAgentResult
}

/**
 * What a Mac background session runs under itself (`claude-agent-tasks`): its
 * sub-agents and workflows as [RemoteTask]s, running first, and how many typed
 * messages wait for its current step (often a long command) to end.
 */
data class MacSessionTasks(val tasks: List<RemoteTask>, val queuedInputs: Int)

/** What `claude-agent-tasks` came to; [Unsupported] from a daemon that predates it. */
sealed interface ClaudeAgentTasksResult {
    data class Success(val value: MacSessionTasks) : ClaudeAgentTasksResult

    data object Unsupported : ClaudeAgentTasksResult

    data class Error(val message: String) : ClaudeAgentTasksResult
}

/**
 * The daemon's task list as the app's [RemoteTask]s; entries it cannot read are
 * skipped. A running workflow's phase and agent count, and a sub-agent's model,
 * stand where a Happy task shows its last tool.
 */
internal fun parseClaudeAgentTasks(answer: JsonObject): MacSessionTasks {
    val tasks = (answer["tasks"] as? JsonArray).orEmpty().mapNotNull { element ->
        val o = element as? JsonObject ?: return@mapNotNull null
        val id = o.string("id") ?: return@mapNotNull null
        val label = o.string("label") ?: return@mapNotNull null
        val startedAt = (o["startedAt"] as? JsonPrimitive)?.longOrNull ?: return@mapNotNull null
        val workflow = o.string("kind") == "workflow"
        val agentCount = (o["agentCount"] as? JsonPrimitive)?.longOrNull
        RemoteTask(
            id = id,
            kind = if (workflow) RemoteTaskKind.Workflow else RemoteTaskKind.Agent,
            title = label,
            status = when (o.string("status")) {
                "running" -> RemoteTaskStatus.Running
                "done" -> RemoteTaskStatus.Completed
                "failed" -> RemoteTaskStatus.Failed
                else -> RemoteTaskStatus.Stopped
            },
            startedAt = startedAt,
            endedAt = (o["endedAt"] as? JsonPrimitive)?.longOrNull,
            agentType = if (workflow) null else o.string("detail"),
            summary = if (workflow) o.string("detail")?.takeIf { it.isNotBlank() } else null,
            lastTool = listOfNotNull(
                o.string("phase"),
                agentCount?.takeIf { workflow }?.let { "$it agents" },
                o.string("model"),
            ).joinToString(" · ").takeIf { it.isNotEmpty() },
        )
    }
    val queued = (answer["queuedInputs"] as? JsonPrimitive)?.longOrNull ?: 0
    return MacSessionTasks(tasks, queued.toInt().coerceAtLeast(0))
}

/** The `unavailable` reason this app gives a machine whose daemon has no `list-claude-agents`. */
const val CLAUDE_AGENTS_UNSUPPORTED = "unsupported"

/** The `unavailable` reason for an answer that could not be read. */
const val CLAUDE_AGENTS_FAILED = "agents-command-failed"

/**
 * The longest the home waits on a session sync, after opening a background
 * session and on pull to refresh. The sync itself retries on its own and goes
 * on after the wait; offline it never ends, and no spinner or tap should hang on it.
 */
const val CLAUDE_AGENTS_SYNC_WAIT_MS = 5_000L

/** Runs [sync] for at most [timeoutMs]; the sync is only waited on, so it carries on past the end of the wait. */
suspend fun awaitSyncBriefly(timeoutMs: Long = CLAUDE_AGENTS_SYNC_WAIT_MS, sync: suspend () -> Unit) {
    withTimeoutOrNull(timeoutMs) { sync() }
}

/**
 * The daemon's `{ agents, unavailable? }`. A row without an id cannot be
 * opened and is left out; an answer that is not an object is a failed listing.
 */
fun parseClaudeAgentsListing(json: JsonElement?): ClaudeAgentsListing {
    val answer = json as? JsonObject ?: return ClaudeAgentsListing(emptyList(), CLAUDE_AGENTS_FAILED)
    val agents = (answer["agents"] as? JsonArray).orEmpty().mapNotNull { element ->
        val row = element as? JsonObject ?: return@mapNotNull null
        ClaudeAgentEntry(
            id = row.string("id")?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null,
            sessionId = row.string("sessionId").orEmpty(),
            name = row.string("name")?.takeIf { it.isNotBlank() },
            cwd = row.string("cwd").orEmpty(),
            status = row.string("status").orEmpty(),
            startedAt = (row["startedAt"] as? JsonPrimitive)?.doubleOrNull?.toLong() ?: 0L,
            mirrorSessionId = row.string("mirrorSessionId")?.takeIf { it.isNotEmpty() },
            state = row.string("state")?.takeIf { it.isNotEmpty() },
            lastLine = row.string("lastLine")?.takeIf { it.isNotBlank() },
        )
    }
    return ClaudeAgentsListing(
        agents,
        answer.string("unavailable")?.takeIf { it.isNotEmpty() },
        startSupported = (answer["startSupported"] as? JsonPrimitive)?.booleanOrNull == true,
    )
}
