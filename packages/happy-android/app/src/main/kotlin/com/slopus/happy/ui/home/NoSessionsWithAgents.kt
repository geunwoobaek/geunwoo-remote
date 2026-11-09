package com.slopus.happy.ui.home

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Box
import com.slopus.happy.ui.components.HomeCardSpec

/**
 * The home with no chats yet but background Claude sessions on a Mac to open:
 * the section first, the "No sessions yet" state under it, and pull to
 * refresh over both. This is the first use of the feature, so it must show here.
 */
@Composable
fun NoSessionsWithAgents(
    claudeAgents: ClaudeAgentsUi,
    onRefresh: (suspend () -> Unit)?,
    onNewSession: () -> Unit,
    onShowArchived: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    HomeRefreshBox(onRefresh, indicatorTop = 0.dp, modifier = modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize().testTag(HomeTags.LIST), contentPadding = PaddingValues(top = HomeCardSpec.contentTop)) {
            item(key = "claude-agents", contentType = "claude-agents") { ClaudeAgentsSection(claudeAgents) }
            item(key = "no-sessions", contentType = "no-sessions") {
                Box(Modifier.fillParentMaxHeight()) { NoSessionsState(onNewSession = onNewSession, onShowArchived = onShowArchived) }
            }
        }
    }
}
