package com.slopus.happy.sync

import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

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
)

/**
 * What a machine listed. [unavailable] says why it could not: `tmux-missing`,
 * `claude-missing`, `agents-command-failed`, or `unsupported` (a daemon from
 * before the feature, which this app, not the daemon, puts there).
 */
data class ClaudeAgentsListing(val agents: List<ClaudeAgentEntry>, val unavailable: String?)

/** What `open-claude-agent` came to. */
sealed interface OpenClaudeAgentResult {
    data class Success(val sessionId: String) : OpenClaudeAgentResult

    data class Error(val message: String) : OpenClaudeAgentResult
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
        )
    }
    return ClaudeAgentsListing(agents, answer.string("unavailable")?.takeIf { it.isNotEmpty() })
}
