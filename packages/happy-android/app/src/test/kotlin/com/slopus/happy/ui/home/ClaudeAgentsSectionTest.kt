package com.slopus.happy.ui.home

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.sync.ClaudeAgentEntry
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** The home's "Claude background sessions": its rows, their words, a tap, and the row being opened. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class ClaudeAgentsSectionTest {
    @get:Rule
    val rule = createComposeRule()

    private fun agent(id: String, name: String?, status: String, cwd: String = "/Users/tester/project") =
        ClaudeAgentEntry(id, "session-$id", name, cwd, status, 1_700_000_000_000, null)

    private val taps = mutableListOf<Pair<String, String>>()

    private fun show(blocks: List<ClaudeAgentsBlock>, opening: Set<String> = emptySet()) {
        rule.setHappyContent { ClaudeAgentsSection(ClaudeAgentsUi(blocks, opening) { machine, id -> taps += machine to id }) }
    }

    @Test
    fun rowsShowNameFolderAndStatusAndATapOpensTheAgent() {
        show(
            listOf(
                ClaudeAgentsBlock(
                    "m1", "Studio",
                    listOf(
                        agent("demo-agent", "Demo", "busy"),
                        agent("other-agent", null, "waiting", cwd = "/Users/tester/other/"),
                        agent("third-agent", "Third", "sleeping"),
                    ),
                    notice = null,
                ),
            ),
        )
        rule.onNodeWithText("Claude background sessions").assertIsDisplayed()
        rule.onAllNodesWithTag(ClaudeAgentsTags.ROW).assertCountEquals(3)
        rule.onNodeWithText("Demo").assertIsDisplayed()
        rule.onNodeWithText("Working").assertIsDisplayed()
        // No name: the folder's end is the title, and shows again as the folder line.
        rule.onNodeWithText("Waiting for permission").assertTextEquals("other", "other", "Waiting for permission")
        rule.onNodeWithText("Waiting for permission").assertIsDisplayed()
        rule.onNodeWithText("sleeping").assertIsDisplayed()
        rule.onNodeWithText("Demo").performClick()
        assertEquals(listOf("m1" to "demo-agent"), taps)
    }

    @Test
    fun theRowBeingOpenedShowsProgressAndIgnoresTaps() {
        show(listOf(ClaudeAgentsBlock("m1", "Studio", listOf(agent("demo-agent", "Demo", "idle"), agent("b", "Second", "idle")), null)), opening = setOf("demo-agent"))
        rule.onAllNodesWithTag(ClaudeAgentsTags.PROGRESS, useUnmergedTree = true).assertCountEquals(1)
        rule.onNodeWithText("Demo").performClick()
        assertEquals(emptyList<Pair<String, String>>(), taps)
        rule.onNodeWithText("Second").performClick()
        assertEquals(listOf("m1" to "b"), taps)
    }

    @Test
    fun aMachineThatCannotListSaysWhyInOneLine() {
        show(listOf(ClaudeAgentsBlock("m1", "Studio", emptyList(), ClaudeAgentsNotice.TmuxMissing)))
        rule.onNodeWithText("Install tmux on this Mac to open background sessions").assertIsDisplayed()
        rule.onAllNodesWithTag(ClaudeAgentsTags.ROW).assertCountEquals(0)
    }

    @Test
    fun nothingIsDrawnWithoutABlock() {
        show(emptyList())
        rule.onAllNodesWithTag(ClaudeAgentsTags.SECTION).assertCountEquals(0)
        rule.onAllNodesWithTag(ClaudeAgentsTags.TITLE).assertCountEquals(0)
    }

    @Test
    fun severalMachinesAreToldApartByName() {
        show(
            listOf(
                ClaudeAgentsBlock("m1", "Studio", listOf(agent("a", "A", "idle")), null),
                ClaudeAgentsBlock("m2", "Laptop", emptyList(), ClaudeAgentsNotice.ClaudeMissing),
            ),
        )
        rule.onNodeWithText("Claude background sessions · Studio").assertIsDisplayed()
        rule.onNodeWithText("Claude background sessions · Laptop").assertIsDisplayed()
        rule.onNodeWithText("Claude Code was not found on this Mac").assertIsDisplayed()
    }
}
