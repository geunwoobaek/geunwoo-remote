package com.slopus.happy.ui.session

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.model.RemoteTask
import com.slopus.happy.model.RemoteTaskKind
import com.slopus.happy.model.RemoteTaskStatus
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The CLI's background tasks over a Happy session's composer, and the sheet a tap on them opens. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class RemoteTaskPanelTest {
    @get:Rule val rule = createComposeRule()
    private val resources get() = ApplicationProvider.getApplicationContext<android.content.Context>().resources

    private val workflow = RemoteTask("w", RemoteTaskKind.Workflow, "review-changes", RemoteTaskStatus.Running, 0)
    private val agent = RemoteTask(
        "a", RemoteTaskKind.Agent, "Explore mapper", RemoteTaskStatus.Running, 0,
        agentType = "Explore", parentId = "w", lastTool = "Grep", tokens = 12_300,
    )
    private val shell = RemoteTask("s", RemoteTaskKind.Shell, "npm test", RemoteTaskStatus.Completed, 0, endedAt = 80_000, summary = "All 412 passed")
    private val housekeeping = RemoteTask("m", RemoteTaskKind.Other, "monitor", RemoteTaskStatus.Running, 0, ambient = true)

    @Test fun barCountsRunningWorkByKindAndIgnoresHousekeeping() {
        assertEquals("2 tasks running · Workflow 1 · Agent 1", remoteTaskBarText(resources, listOf(workflow, agent, shell, housekeeping)))
    }

    @Test fun barSaysRecentOnceNothingRuns() {
        assertEquals("1 recent task", remoteTaskBarText(resources, listOf(shell, housekeeping)))
    }

    @Test fun detailNamesKindStateTimeTokensAndTheToolOnlyWhileRunning() {
        assertEquals("Agent (Explore) · Running · 1:05 · 12.3k tokens · Grep", remoteTaskDetail(resources, agent, 65_000))
        assertEquals("Shell · Done · 1:20", remoteTaskDetail(resources, shell, 999_000))
    }

    @Test fun tappingTheBarOpensTheSheetWithEveryTask() {
        rule.setHappyContent {
            var open by remember { mutableStateOf(false) }
            RemoteTaskBar(listOf(shell, agent, workflow), onOpen = { open = true })
            if (open) RemoteTaskSheet(listOf(shell, agent, workflow)) { open = false }
        }
        rule.onNodeWithTag(RemoteTaskTags.BAR).performClick()
        rule.onNodeWithTag(RemoteTaskTags.SHEET).assertIsDisplayed()
        rule.onNodeWithText("Background tasks").assertIsDisplayed()
        rule.onNodeWithTag(RemoteTaskTags.row("a"), useUnmergedTree = true).assertExists()
        rule.onNodeWithText("All 412 passed").assertIsDisplayed()
        rule.onNodeWithText("Explore mapper").assertTextEquals("Explore mapper")
    }
}
