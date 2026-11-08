package com.slopus.happy.ui.session

import androidx.compose.runtime.Immutable
import com.slopus.happy.autocomplete.IGNORED_COMMANDS
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.sync.ListWorkflowsResult
import com.slopus.happy.sync.SavedWorkflow

/** One MCP server as Claude reported it at start, and how many of the session's tools are its. */
@Immutable
data class McpServerEntry(val name: String, val status: String, val toolCount: Int)

/**
 * What a session's Claude said it can use when it started (the SDK's init
 * message, which the CLI copies into session metadata): its skills, its
 * other slash commands, its MCP servers and their state, and its built-in
 * tools. Commands the phone can't use (the autocomplete's
 * [IGNORED_COMMANDS], such as /login) are left out, as the `/` list leaves
 * them out; a skill is listed once, under skills, though Claude also
 * reports it as a slash command.
 *
 * [reported] is false until Claude has said anything: a session still
 * starting, or one in local mode, whose terminal Claude reports nothing.
 */
@Immutable
data class SkillsCatalog(
    val reported: Boolean,
    val skills: List<String>,
    val commands: List<String>,
    val servers: List<McpServerEntry>,
    val tools: List<String>,
) {
    val isEmpty: Boolean get() = skills.isEmpty() && commands.isEmpty() && servers.isEmpty() && tools.isEmpty()

    /** Only the names that contain [query] (any case); everything for a blank one. */
    fun filter(query: String): SkillsCatalog {
        val q = query.trim()
        if (q.isEmpty()) return this
        fun List<String>.matching() = filter { it.contains(q, ignoreCase = true) }
        return copy(
            skills = skills.matching(),
            commands = commands.matching(),
            servers = servers.filter { it.name.contains(q, ignoreCase = true) },
            tools = tools.matching(),
        )
    }

    companion object {
        private const val MCP_TOOL_PREFIX = "mcp__"

        fun of(metadata: SessionMetadata?): SkillsCatalog {
            val skills = metadata?.skills.orEmpty().filter { it.isNotBlank() }.distinct().sortedWith(String.CASE_INSENSITIVE_ORDER)
            val skillSet = skills.toSet()
            val commands = metadata?.slashCommands.orEmpty()
                .filter { it.isNotBlank() && it !in skillSet && it !in IGNORED_COMMANDS }
                .distinct()
                .sortedWith(String.CASE_INSENSITIVE_ORDER)
            val allTools = metadata?.tools.orEmpty()
            val servers = metadata?.mcpServers.orEmpty().distinctBy { it.name }.map { server ->
                McpServerEntry(server.name, server.status, allTools.count { it.startsWith("$MCP_TOOL_PREFIX${server.name}__") })
            }.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.name })
            val tools = allTools.filter { !it.startsWith(MCP_TOOL_PREFIX) }.distinct().sortedWith(String.CASE_INSENSITIVE_ORDER)
            val reported = metadata != null &&
                (metadata.skills != null || metadata.slashCommands != null || metadata.mcpServers != null || metadata.tools != null)
            return SkillsCatalog(reported, skills, commands, servers, tools)
        }

        /**
         * The composer's [draft] with `/name ` in front, ready for the
         * command's arguments: a blank draft becomes just the command, a
         * draft that already starts with a command has it swapped, and any
         * other words stay after it.
         */
        fun withCommand(draft: String, name: String): String {
            val command = "/${name.removePrefix("/")} "
            val text = draft.trimStart()
            if (text.isEmpty()) return command
            val leading = Regex("^/\\S+(\\s+|$)").find(text)
            val rest = if (leading != null) text.substring(leading.range.last + 1) else text
            return command + rest
        }
    }
}

/** How a session MCP server's state reads at a glance. */
enum class McpServerHealth { Connected, Waiting, Failed, Other }

fun mcpServerHealth(status: String): McpServerHealth = when (status.lowercase()) {
    "connected" -> McpServerHealth.Connected
    "pending", "connecting", "needs-auth" -> McpServerHealth.Waiting
    "failed", "error" -> McpServerHealth.Failed
    else -> McpServerHealth.Other
}

/** The saved workflows a session can run, as the screen shows them while they're asked for. */
sealed interface WorkflowsState {
    data object Loading : WorkflowsState

    /** The session's CLI is from before `listWorkflows`: a new session will have it. */
    data object NeedsNewSession : WorkflowsState

    /** The computer couldn't be asked, or said why not ([message], as it said it). */
    data class Failed(val message: String?) : WorkflowsState

    data class Loaded(val workflows: List<SavedWorkflow>) : WorkflowsState {
        /** Only the workflows whose name or description contains [query]; all for a blank one. */
        fun filter(query: String): List<SavedWorkflow> {
            val q = query.trim()
            if (q.isEmpty()) return workflows
            return workflows.filter { it.name.contains(q, ignoreCase = true) || it.description?.contains(q, ignoreCase = true) == true }
        }
    }

    companion object {
        /** What happy-cli's RPC layer answers for a method it doesn't have. */
        private const val METHOD_NOT_FOUND = "Method not found"

        fun of(result: ListWorkflowsResult): WorkflowsState = when {
            result.success -> Loaded(result.workflows.orEmpty())
            result.error == METHOD_NOT_FOUND -> NeedsNewSession
            else -> Failed(result.error)
        }
    }
}

/**
 * Whether tapping the workflow can open its script. The session's file reads
 * refuse paths outside its folder, so a user workflow (and a project one at a
 * git root above the folder) shows its description only.
 */
val SavedWorkflow.opensInViewer: Boolean get() = inWorkingDirectory
