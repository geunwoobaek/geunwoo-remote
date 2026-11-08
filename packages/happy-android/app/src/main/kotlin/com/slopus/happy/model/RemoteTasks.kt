package com.slopus.happy.model

import androidx.compose.runtime.Immutable
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.bool
import com.slopus.happy.chat.long
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str

/**
 * A Happy CLI session's background tasks: workflows, subagents and shell jobs
 * the CLI publishes as `metadata.remoteTasks` (happy-cli taskTracker.ts, this
 * fork only). Read through passthrough, outside MetadataSchema, so a bad
 * entry is skipped and never costs the session its metadata.
 */
enum class RemoteTaskKind { Workflow, Agent, Shell, Other }

enum class RemoteTaskStatus(val finished: Boolean) {
    Pending(false), Running(false), Paused(false), Completed(true), Failed(true), Stopped(true),
}

@Immutable
data class RemoteTask(
    val id: String,
    val kind: RemoteTaskKind,
    val title: String,
    val status: RemoteTaskStatus,
    val startedAt: Long,
    val endedAt: Long? = null,
    val agentType: String? = null,
    val parentId: String? = null,
    val background: Boolean = false,
    val ambient: Boolean = false,
    val summary: String? = null,
    val lastTool: String? = null,
    val tokens: Long? = null,
    val toolUses: Long? = null,
)

fun SessionMetadata?.remoteTasks(): List<RemoteTask> =
    this?.raw?.get("remoteTasks").arr?.mapNotNull { element ->
        val o = element.obj ?: return@mapNotNull null
        RemoteTask(
            id = o["id"].str ?: return@mapNotNull null,
            kind = when (o["kind"].str) {
                "workflow" -> RemoteTaskKind.Workflow
                "agent" -> RemoteTaskKind.Agent
                "shell" -> RemoteTaskKind.Shell
                else -> RemoteTaskKind.Other
            },
            title = o["title"].str ?: return@mapNotNull null,
            status = RemoteTaskStatus.entries.firstOrNull { it.name.equals(o["status"].str, ignoreCase = true) } ?: RemoteTaskStatus.Running,
            startedAt = o["startedAt"].long ?: return@mapNotNull null,
            endedAt = o["endedAt"].long,
            agentType = o["agentType"].str,
            parentId = o["parentId"].str,
            background = o["background"].bool == true,
            ambient = o["ambient"].bool == true,
            summary = o["summary"].str?.takeIf { it.isNotBlank() },
            lastTool = o["lastTool"].str,
            tokens = o["tokens"].long,
            toolUses = o["toolUses"].long,
        )
    }.orEmpty()

/** What counts as running work: not finished, not ambient housekeeping. */
fun List<RemoteTask>.activeRemoteTasks(): List<RemoteTask> = filter { !it.status.finished && !it.ambient }

/** Depth-first: each task followed by the tasks it launched; a parent not in the list counts as none. */
fun List<RemoteTask>.inTreeOrder(): List<Pair<RemoteTask, Int>> {
    val ids = mapTo(HashSet()) { it.id }
    val children = groupBy { task -> task.parentId?.takeIf { it in ids } }
    val ordered = ArrayList<Pair<RemoteTask, Int>>(size)
    val seen = HashSet<String>()
    fun visit(parent: String?, depth: Int) {
        children[parent].orEmpty().forEach { task ->
            if (!seen.add(task.id)) return@forEach
            ordered += task to depth
            visit(task.id, depth + 1)
        }
    }
    visit(null, 0)
    return ordered
}
