package com.slopus.happy.ui.home

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.slopus.happy.ui.components.HomeCardSpec

/**
 * The home with no chats yet: the Mac's background Claude sessions (when it
 * has any to open), the "No sessions yet" state under them, and pull to
 * refresh over both. It pulls with no sessions listed too, so one started on
 * the Mac after home opened can be found without leaving. A list, not a bare
 * page, so the pull has something to ride on.
 */
@Composable
fun NoSessionsWithAgents(
    claudeAgents: ClaudeAgentsUi?,
    onRefresh: (suspend () -> Unit)?,
    onNewSession: () -> Unit,
    onShowArchived: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    HomeRefreshBox(onRefresh, indicatorTop = 0.dp, modifier = modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize().testTag(HomeTags.LIST), contentPadding = PaddingValues(top = HomeCardSpec.contentTop)) {
            if (claudeAgents != null) {
                item(key = "claude-agents", contentType = "claude-agents") { ClaudeAgentsSection(claudeAgents) }
            }
            item(key = "no-sessions", contentType = "no-sessions") {
                Box(Modifier.fillParentMaxHeight()) { NoSessionsState(onNewSession = onNewSession, onShowArchived = onShowArchived) }
            }
        }
    }
}
