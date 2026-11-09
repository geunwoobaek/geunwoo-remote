package com.slopus.happy.ui.home

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import kotlinx.coroutines.launch

/**
 * Pull to refresh over the home list: [onRefresh] runs while the indicator
 * shows, [indicatorTop] below the top so the glass bar does not cover it.
 * With no [onRefresh] the list is drawn as it is.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeRefreshBox(onRefresh: (suspend () -> Unit)?, indicatorTop: Dp, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    if (onRefresh == null) {
        content()
        return
    }
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val state = rememberPullToRefreshState()
    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = {
            refreshing = true
            scope.launch {
                try {
                    onRefresh()
                } finally {
                    refreshing = false
                }
            }
        },
        modifier = modifier,
        state = state,
        indicator = {
            PullToRefreshDefaults.Indicator(
                state = state,
                isRefreshing = refreshing,
                modifier = Modifier.align(Alignment.TopCenter).padding(top = indicatorTop),
            )
        },
    ) { content() }
}
