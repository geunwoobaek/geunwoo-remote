package com.slopus.happy.ui.session

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import android.content.res.Resources
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import com.slopus.happy.R
import com.slopus.happy.artifacts.formatDuration
import com.slopus.happy.text.plural
import java.util.Locale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.model.RemoteTask
import com.slopus.happy.model.RemoteTaskKind
import com.slopus.happy.model.RemoteTaskStatus
import com.slopus.happy.model.activeRemoteTasks
import com.slopus.happy.model.inTreeOrder
import com.slopus.happy.ui.call.SheetStatusIcons
import com.slopus.happy.ui.chat.SessionStatusColors
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.StatusDot
import com.slopus.happy.ui.components.TrackOverlay
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.delay

object RemoteTaskTags {
    const val BAR = "remoteTasks.bar"
    const val SHEET = "remoteTasks.sheet"
    fun row(id: String) = "remoteTasks.row.$id"
}

/**
 * A Happy CLI session's background work over the composer, in RigActivityBar's
 * place and size: how many tasks run and of what kind, or that some finished
 * lately. A tap opens [RemoteTaskSheet]. Nothing when the CLI reports none.
 */
@Composable
fun RemoteTaskBar(tasks: List<RemoteTask>, onOpen: () -> Unit, modifier: Modifier = Modifier) {
    if (tasks.isEmpty()) return
    val colors = HappyTheme.colors
    val active = tasks.activeRemoteTasks()
    Row(
        modifier = modifier
            .testTag(RemoteTaskTags.BAR)
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onOpen)
            .padding(horizontal = SessionBarSpec.activityPaddingHorizontal, vertical = SessionBarSpec.activityPaddingVertical),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(SessionBarSpec.activityIconGap),
    ) {
        if (active.isNotEmpty()) StatusDot(SessionStatusColors.thinking, pulsing = true)
        else Icon(Ionicon.ListOutline, SessionBarSpec.activityIcon, colors.textSecondary)
        Text(remoteTaskBarText(LocalResources.current, tasks), style = SessionBarSpec.activityText, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Spacer(Modifier.weight(1f))
        Icon(Ionicon.ChevronUp, SessionBarSpec.activityIcon, colors.textSecondary)
    }
}

/** "3 tasks running · Agent 2 · Shell 1", or "4 recent tasks" once nothing runs. */
internal fun remoteTaskBarText(resources: Resources, tasks: List<RemoteTask>): String {
    val active = tasks.activeRemoteTasks()
    if (active.isEmpty()) {
        val recent = tasks.count { !it.ambient }.coerceAtLeast(1)
        return resources.plural(R.plurals.remote_tasks_recent, recent, recent)
    }
    val kinds = RemoteTaskKind.entries.mapNotNull { kind ->
        active.count { it.kind == kind }.takeIf { it > 0 }?.let { "${resources.getString(kindLabel(kind))} $it" }
    }
    return (listOf(resources.plural(R.plurals.remote_tasks_running, active.size, active.size)) + kinds).joinToString(" · ")
}

/**
 * Every task the CLI reports, as a tree (a workflow's agents and shells under
 * it), each with its state, kind, running time, tokens, last tool and the
 * one-line summary the agent gives. Running times tick each second.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RemoteTaskSheet(tasks: List<RemoteTask>, onDismiss: () -> Unit) {
    val colors = HappyTheme.colors
    val sheet = rememberModalBottomSheetState()
    val now by produceState(System.currentTimeMillis()) {
        while (true) {
            delay(1000)
            value = System.currentTimeMillis()
        }
    }
    TrackOverlay(true, onDismiss)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet, containerColor = colors.surface, modifier = Modifier.testTag(RemoteTaskTags.SHEET)) {
        SheetStatusIcons()
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 8.dp)) {
            Text(
                stringResource(R.string.remote_tasks_title),
                style = happyTextStyle(fontSize = 17, lineHeight = 22, weight = FontWeight.SemiBold),
                color = colors.text,
                modifier = Modifier.padding(horizontal = 24.dp).padding(bottom = 8.dp),
            )
            if (tasks.isEmpty()) {
                Text(stringResource(R.string.remote_tasks_empty), style = happyTextStyle(fontSize = 14), color = colors.textSecondary, modifier = Modifier.padding(24.dp))
            }
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
                tasks.inTreeOrder().forEach { (task, depth) ->
                    key(task.id) { RemoteTaskRow(task, depth, now) }
                }
            }
        }
    }
}

@Composable
private fun RemoteTaskRow(task: RemoteTask, depth: Int, now: Long) {
    val colors = HappyTheme.colors
    Row(
        modifier = Modifier
            .testTag(RemoteTaskTags.row(task.id))
            .fillMaxWidth()
            .padding(start = 24.dp + 16.dp * depth, end = 24.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.Top,
    ) {
        StatusDot(statusColor(task.status, colors.status.error, colors.textSecondary), Modifier.padding(top = 7.dp), pulsing = task.status == RemoteTaskStatus.Running, size = 8.dp)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(task.title, style = happyTextStyle(fontSize = 15, lineHeight = 20, weight = FontWeight.Medium), color = colors.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(remoteTaskDetail(LocalResources.current, task, now), style = happyTextStyle(fontSize = 12, lineHeight = 16), color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            task.summary?.let {
                Text(it, style = happyTextStyle(fontSize = 13, lineHeight = 18), color = colors.textSecondary, maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** "Agent (Explore) · Running · 1:20 · 12.3k tokens · Grep". */
internal fun remoteTaskDetail(resources: Resources, task: RemoteTask, now: Long): String {
    val kind = resources.getString(kindLabel(task.kind)) + (task.agentType?.let { " ($it)" } ?: "")
    val elapsed = formatDuration(((task.endedAt ?: now) - task.startedAt) / 1000.0)
    val tokens = task.tokens?.let { resources.getString(R.string.remote_tasks_tokens, String.format(Locale.ROOT, "%.1fk", it / 1000.0)) }
    val tool = task.lastTool?.takeIf { !task.status.finished }
    return listOfNotNull(kind, resources.getString(statusLabel(task.status)), elapsed, tokens, tool).joinToString(" · ")
}

private fun kindLabel(kind: RemoteTaskKind) = when (kind) {
    RemoteTaskKind.Workflow -> R.string.remote_tasks_kind_workflow
    RemoteTaskKind.Agent -> R.string.remote_tasks_kind_agent
    RemoteTaskKind.Shell -> R.string.remote_tasks_kind_shell
    RemoteTaskKind.Other -> R.string.remote_tasks_kind_other
}

private fun statusLabel(status: RemoteTaskStatus) = when (status) {
    RemoteTaskStatus.Pending -> R.string.remote_tasks_status_pending
    RemoteTaskStatus.Running -> R.string.remote_tasks_status_running
    RemoteTaskStatus.Paused -> R.string.remote_tasks_status_paused
    RemoteTaskStatus.Completed -> R.string.remote_tasks_status_completed
    RemoteTaskStatus.Failed -> R.string.remote_tasks_status_failed
    RemoteTaskStatus.Stopped -> R.string.remote_tasks_status_stopped
}

private fun statusColor(status: RemoteTaskStatus, error: Color, muted: Color) = when (status) {
    RemoteTaskStatus.Running -> SessionStatusColors.thinking
    RemoteTaskStatus.Completed -> SessionStatusColors.online
    RemoteTaskStatus.Failed -> error
    RemoteTaskStatus.Pending, RemoteTaskStatus.Paused -> SessionStatusColors.attention
    RemoteTaskStatus.Stopped -> muted
}
