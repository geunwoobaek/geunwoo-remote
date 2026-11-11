package com.slopus.happy.ui.home

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.model.FlatSessionRowData
import com.slopus.happy.model.SessionRowData
import com.slopus.happy.model.SessionState
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** A sectioned home row: the badge it shows instead of the dot, its last line and how long. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class HomeSectionRowsTest {
    @get:Rule
    val rule = createComposeRule()

    private var showMore = 0
    private val callbacks = HomeListCallbacks(
        onOpen = {}, onMenu = {}, onArchive = {}, onSetArchiveHidden = {}, onToggleProject = {},
        onOpenMachine = {}, onCreateWorkspace = {}, onProjectMenu = { _, _ -> },
        onShowMoreCompleted = { showMore++ },
    )

    private val now = 10_000_000L

    private fun row(state: SessionState, preview: String? = null, since: Long? = null) = FlatSessionRowData(
        session = SessionRowData(id = "s", name = "Fix the build", state = state, preview = preview, stateSince = since, lastActivityAt = now),
        projectName = "happy",
        workspaceName = null,
    )

    private fun show(row: FlatSessionRowData, section: HomeSection) {
        rule.setHappyContent {
            Box(Modifier.height(81.dp)) {
                FlatSessionRow(row, showBorder = false, archived = false, callbacks = callbacks, carded = true, section = section, now = now)
            }
        }
    }

    @Test fun aBlockedRowShowsApproveAndNoDot() {
        show(row(SessionState.PermissionRequired, since = now - 12 * 60_000L), HomeSection.NeedsInput)
        rule.node(FlatRowTags.BADGE).assertTextEquals("Approve")
        rule.onAllNodesWithTag(FlatRowTags.DOT, useUnmergedTree = true).assertCountEquals(0)
        rule.node(FlatRowTags.ELAPSED).assertTextEquals("12m")
    }

    @Test fun aQuestionShowsReply() {
        show(row(SessionState.InputRequired, since = now - 40_000L), HomeSection.NeedsInput)
        rule.node(FlatRowTags.BADGE).assertTextEquals("Reply")
        rule.node(FlatRowTags.ELAPSED).assertTextEquals("40s")
    }

    @Test fun aRowShowsItsLastLineInsteadOfTheFolder() {
        show(row(SessionState.Thinking, preview = "Running the tests", since = now - 2 * 3_600_000L), HomeSection.Working)
        rule.node(FlatRowTags.PROJECT).assertTextEquals("Running the tests")
        rule.onAllNodesWithText("happy", useUnmergedTree = true).assertCountEquals(0)
        rule.onAllNodesWithTag(FlatRowTags.BADGE, useUnmergedTree = true).assertCountEquals(0)
        rule.node(FlatRowTags.ELAPSED).assertTextEquals("2h")
    }

    @Test fun withNoLastLineTheFolderStays() {
        show(row(SessionState.Waiting), HomeSection.Completed)
        rule.node(FlatRowTags.PROJECT).assertTextEquals("happy")
    }

    @Test fun tappingShowMoreAsksForTheRest() {
        rule.setHappyContent { Box(Modifier.height(44.dp)) { ShowMoreRow(5, callbacks) } }
        rule.node(HomeSectionTags.SHOW_MORE).performClick()
        assertEquals(1, showMore)
        rule.onAllNodesWithText("Show 5 more", useUnmergedTree = true).assertCountEquals(1)
    }
}
