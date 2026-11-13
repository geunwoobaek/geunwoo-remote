package com.slopus.happy.ui.session

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.model.RemoteTask
import com.slopus.happy.model.RemoteTaskKind
import com.slopus.happy.model.RemoteTaskStatus
import com.slopus.happy.sync.MacSessionTasks
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** A Mac background session's sub-agents, workflows and waiting messages over its composer. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MacSessionTasksTest {
    @get:Rule val rule = createComposeRule()

    private val now = 100 * 60 * 60 * 1000L
    private val running = RemoteTask("agent-r", RemoteTaskKind.Agent, "Polish the card game", RemoteTaskStatus.Running, now - 60_000, lastTool = "fable")
    private val lately = RemoteTask("agent-l", RemoteTaskKind.Agent, "Split memory", RemoteTaskStatus.Completed, now - 120_000, endedAt = now - 60_000)
    private val longAgo = RemoteTask("wf_old", RemoteTaskKind.Workflow, "game-panel", RemoteTaskStatus.Stopped, 0, endedAt = now - MAC_TASKS_RECENT_MS - 1)

    @Test fun recentKeepsRunningAndLatelyEndedWork() {
        assertEquals(listOf(running, lately), recentMacTasks(listOf(running, lately, longAgo), now))
    }

    @Test fun noBarWithoutAnswerOrWithNothingRecent() {
        assertNull(macSessionTasksBar(null, now) {})
        assertNull(macSessionTasksBar(MacSessionTasks(listOf(longAgo), queuedInputs = 0), now) {})
    }

    @Test fun showsWaitingMessagesAndRunningWork() {
        var opened = false
        val bar = macSessionTasksBar(MacSessionTasks(listOf(running, lately, longAgo), queuedInputs = 2), now) { opened = true }!!
        rule.setHappyContent { bar() }
        rule.onNodeWithTag(MacSessionTaskTags.QUEUED).assertIsDisplayed()
        rule.onNodeWithText("2 messages waiting · Claude reads them when the current step ends").assertIsDisplayed()
        rule.onNodeWithText("1 task running · Agent 1").assertIsDisplayed()
        rule.onNodeWithTag(RemoteTaskTags.BAR).performClick()
        assertEquals(true, opened)
    }

    @Test fun showsWaitingMessagesAlone() {
        val bar = macSessionTasksBar(MacSessionTasks(emptyList(), queuedInputs = 1), now) {}!!
        rule.setHappyContent { bar() }
        rule.onNodeWithText("1 message waiting · Claude reads it when the current step ends").assertIsDisplayed()
        rule.onNodeWithTag(RemoteTaskTags.BAR).assertDoesNotExist()
    }
}
