package com.slopus.happy.ui.session

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.model.RemoteTask
import com.slopus.happy.sync.ClaudeAgentTasksResult
import com.slopus.happy.sync.MacSessionTasks
import com.slopus.happy.ui.chat.SessionStatusColors
import com.slopus.happy.ui.components.StatusDot
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

object MacSessionTaskTags {
    const val QUEUED = "macTasks.queued"
}

/** How often an open chat asks the Mac what its session runs under itself. */
internal const val MAC_TASKS_POLL_MS = 5_000L

/** Ended work older than this stays off the bar and its sheet. */
internal const val MAC_TASKS_RECENT_MS = 6 * 60 * 60 * 1000L

/**
 * What a Mac background session runs under itself, asked of its Mac every
 * [MAC_TASKS_POLL_MS] while the chat is open and the app in front. Null for a
 * chat that mirrors no Mac session, until the first answer, and for good once
 * the Mac's daemon turns out to predate the call. A failed ask keeps the last
 * answer.
 */
@Composable
fun rememberMacSessionTasks(graph: AppGraph, machineId: String?, agentId: String?): MacSessionTasks? {
    val foreground by graph.isForeground.collectAsStateWithLifecycle()
    val account by graph.account.collectAsStateWithLifecycle()
    val tasks by produceState<MacSessionTasks?>(null, account, machineId, agentId, foreground) {
        val ops = account?.machineOps
        if (ops == null || machineId.isNullOrBlank() || agentId.isNullOrBlank() || !foreground) return@produceState
        while (true) {
            when (val result = try { ops.claudeAgentTasks(machineId, agentId) } catch (e: CancellationException) { throw e } catch (_: Exception) { null }) {
                is ClaudeAgentTasksResult.Success -> value = result.value
                ClaudeAgentTasksResult.Unsupported -> {
                    value = null
                    return@produceState
                }
                is ClaudeAgentTasksResult.Error, null -> Unit
            }
            delay(MAC_TASKS_POLL_MS)
        }
    }
    return tasks
}

/** Running work and work that ended within [MAC_TASKS_RECENT_MS] of [now]. */
internal fun recentMacTasks(tasks: List<RemoteTask>, now: Long): List<RemoteTask> =
    tasks.filter { !it.status.finished || (it.endedAt ?: it.startedAt) >= now - MAC_TASKS_RECENT_MS }

/**
 * The Mac session's bar over the composer: messages still waiting for its
 * current step to end, then its sub-agents and workflows ([RemoteTaskBar],
 * whose tap opens their sheet). Null when there is nothing to show.
 */
internal fun macSessionTasksBar(tasks: MacSessionTasks?, now: Long, onOpen: () -> Unit): (@Composable () -> Unit)? {
    if (tasks == null) return null
    val recent = recentMacTasks(tasks.tasks, now)
    if (recent.isEmpty() && tasks.queuedInputs == 0) return null
    return {
        Column(Modifier.fillMaxWidth()) {
            if (tasks.queuedInputs > 0) MacQueuedLine(tasks.queuedInputs)
            if (recent.isNotEmpty()) RemoteTaskBar(recent, onOpen = onOpen)
        }
    }
}

@Composable
private fun MacQueuedLine(count: Int) {
    val colors = HappyTheme.colors
    Row(
        modifier = Modifier
            .testTag(MacSessionTaskTags.QUEUED)
            .fillMaxWidth()
            .padding(horizontal = SessionBarSpec.activityPaddingHorizontal, vertical = SessionBarSpec.activityPaddingVertical),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(SessionBarSpec.activityIconGap),
    ) {
        StatusDot(SessionStatusColors.attention, pulsing = true)
        Text(
            pluralStringResource(R.plurals.mac_session_queued_inputs, count, count),
            style = SessionBarSpec.activityText,
            color = colors.textSecondary,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
