package com.slopus.happy.ui.home

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.model.HomeEmptyState
import com.slopus.happy.model.HomeModelFixtures.claudeAgent
import com.slopus.happy.model.HomeModelFixtures.listing
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.metadata
import com.slopus.happy.model.HomeModelFixtures.session
import com.slopus.happy.model.Session
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.net.ConnectionStatus
import com.slopus.happy.sync.ClaudeAgentsListing
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.setHappyContent
import java.time.LocalDate
import java.time.ZoneOffset
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** The home with the Mac's background sessions as rows: the one notice line over the list, a row's open and its tap. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class HomeAgentsNoticeTest {
    @get:Rule
    val rule = createComposeRule()

    private val today = LocalDate.of(2026, 11, 10)
    private val noon = today.atTime(12, 0).toInstant(ZoneOffset.UTC).toEpochMilli()
    private val opened = mutableListOf<String>()

    private val callbacks = HomeListCallbacks(
        onOpen = { opened += it }, onMenu = {}, onArchive = {}, onSetArchiveHidden = {}, onToggleProject = {},
        onOpenMachine = {}, onCreateWorkspace = {}, onProjectMenu = { _, _ -> },
    )

    private fun home(
        sessions: List<Session>,
        listings: Map<String, ClaudeAgentsListing> = emptyMap(),
        opening: Set<String> = emptySet(),
    ) = deriveHomeList(
        HomeListInputs(HomeSnapshot(sessions, listOf(machine("m1"))), SessionListGrouping.Flat, true, emptySet(), emptySet(), emptySet(), listings, opening),
        ZoneOffset.UTC,
        today,
    )

    private fun show(state: HomeListState, notice: ClaudeAgentsNoticeLine?, onRefresh: (suspend () -> Unit)? = null) {
        rule.setHappyContent {
            HomeScreen(
                state, ConnectionStatus.CONNECTED, SessionListGrouping.Flat, callbacks, HomeScreenActions({}, {}, {}, {}, {}, {}),
                agentsNotice = notice, onRefresh = onRefresh,
            )
        }
    }

    private val tmuxMissing = ClaudeAgentsNoticeLine(ClaudeAgentsNotice.TmuxMissing, null)

    @Test
    fun theUnavailableNoticeRendersOnceAboveTheList() {
        val sessions = listOf("a", "b").map {
            session(it, metadata = metadata(path = "/Users/tester/$it") { put("machineId", "m1") }, lastMessageSentAt = noon)
        }
        show(home(sessions), tmuxMissing)
        rule.onAllNodesWithTag(ClaudeAgentsTags.NOTICE).assertCountEquals(1)
        val notice = rule.onNodeWithTag(ClaudeAgentsTags.NOTICE).fetchSemanticsNode().boundsInRoot
        val firstRow = rule.onAllNodesWithTag(FlatRowTags.ROW).fetchSemanticsNodes().minOf { it.boundsInRoot.top }
        assertTrue(notice.bottom <= firstRow + 1f)
    }

    @Test
    fun anEmptyHomeShowsTheNoticeOverTheEmptyStateAndStillPulls() {
        var refreshed = 0
        val state = home(emptyList())
        assertEquals(HomeEmptyState.NoSessions, state.emptyState)
        show(state, tmuxMissing, onRefresh = { refreshed++ })
        rule.onAllNodesWithTag(HomeStateTags.NO_SESSIONS).assertCountEquals(1)
        rule.onAllNodesWithTag(ClaudeAgentsTags.NOTICE).assertCountEquals(1)
        rule.onNodeWithTag(HomeTags.LIST).performTouchInput { swipeDown(startY = top + 100f, endY = bottom - 100f) }
        rule.waitForIdle()
        assertEquals(1, refreshed)
    }

    @Test
    fun noNoticeDrawsNothingOverTheList() {
        show(home(listOf(session("a", metadata = metadata(path = "/Users/tester/a") { put("machineId", "m1") }, lastMessageSentAt = noon))), null)
        rule.onAllNodesWithTag(ClaudeAgentsTags.NOTICE).assertCountEquals(0)
    }

    @Test
    fun anUnopenedAgentIsAChatRowThatShowsItsOpenAndOpensOnATap() {
        val listings = mapOf("m1" to listing(claudeAgent("a1", name = "Demo", status = "busy", startedAt = noon)))
        show(home(emptyList(), listings, opening = setOf("a1")), null)
        rule.onAllNodesWithTag(FlatRowTags.ROW).assertCountEquals(1)
        rule.onAllNodesWithTag(FlatRowTags.OPENING, useUnmergedTree = true).assertCountEquals(1)
        rule.onNodeWithText("Demo").performClick()
        assertEquals(listOf("agent:m1:a1"), opened)
    }
}
