package com.slopus.happy.model

import com.slopus.happy.chat.AgentEvent
import com.slopus.happy.chat.NormalizedMessage
import com.slopus.happy.chat.NormalizedMessage.AgentContent
import com.slopus.happy.chat.NormalizedMessage.Body
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The home row's last line and the start of the turn under way, from a session's newest messages. */
class SessionPreviewTest {
    private var next = 0

    private fun message(at: Long, body: Body, sidechain: Boolean = false) =
        NormalizedMessage("m${next++}", null, at, body, isSidechain = sidechain)

    private fun user(at: Long, text: String = "go") = message(at, Body.User(text))
    private fun text(at: Long, text: String, sidechain: Boolean = false) =
        message(at, Body.Agent(listOf(AgentContent.Text(text, "u$at", null))), sidechain)
    private fun tool(at: Long, name: String, title: String?) =
        message(at, Body.Agent(listOf(AgentContent.ToolUse("t$at", name, title, null, null, "u$at", null))))

    @Test fun newestAgentTextWinsAndKeepsItsFirstLine() {
        val preview = previewOf(listOf(text(3, "## Done\n\nmore below"), text(2, "older"), user(1)))
        assertEquals("Done", preview.line)
        assertEquals(1L, preview.turnStartedAt)
    }

    @Test fun aToolCallIsALine() {
        assertEquals("Run tests", previewOf(listOf(tool(2, "Bash", "Run tests"))).line)
        assertEquals("Bash", previewOf(listOf(tool(2, "Bash", null))).line)
    }

    @Test fun thinkingSidechainAndEventsAreSkipped() {
        val preview = previewOf(
            listOf(
                message(5, Body.Agent(listOf(AgentContent.Thinking("hmm", "u5", null)))),
                text(4, "inside a sub-agent", sidechain = true),
                message(3, Body.Event(AgentEvent.Ready)),
                text(2, "- **Checked** the build"),
            ),
        )
        assertEquals("Checked the build", preview.line)
        assertNull(preview.turnStartedAt)
    }

    @Test fun aSessionWithOnlyUserMessagesHasNoLine() {
        val preview = previewOf(listOf(user(7)))
        assertNull(preview.line)
        assertEquals(7L, preview.turnStartedAt)
    }

    @Test fun longLinesAreCutAt120() {
        val line = previewOf(listOf(text(1, "word   ".repeat(60) + "\nsecond line"))).line!!
        assertTrue(line.length <= 120)
        assertFalse(line.contains("\n"))
        assertFalse(line.contains("  "))
    }
}
