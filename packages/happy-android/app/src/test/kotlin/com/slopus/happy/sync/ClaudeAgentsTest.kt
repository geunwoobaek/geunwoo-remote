package com.slopus.happy.sync

import com.slopus.happy.model.folderTail
import com.slopus.happy.ui.home.ClaudeAgentsNotice
import com.slopus.happy.ui.home.claudeAgentsNotice
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The `list-claude-agents` answer as the app reads it, and what the home shows of it. */
class ClaudeAgentsTest {
    @Test
    fun parseClaudeAgentsListingReadsAgentsAndUnavailable() {
        val listing = parseClaudeAgentsListing(buildJsonObject {
            put("agents", buildJsonArray {
                add(buildJsonObject {
                    put("id", "demo-agent")
                    put("sessionId", "claude-session-1")
                    put("name", "Demo")
                    put("cwd", "/Users/tester/project")
                    put("pid", 4242)
                    put("status", "waiting")
                    put("state", "working")
                    put("startedAt", 1_700_000_000_000)
                    put("mirrorSessionId", "happy-1")
                })
                add(buildJsonObject {
                    put("id", "other-agent")
                    put("sessionId", "claude-session-2")
                    put("name", JsonNull)
                    put("cwd", "/Users/tester/other")
                    put("pid", 4243)
                    put("status", "idle")
                    put("state", JsonNull)
                    put("startedAt", 1_700_000_100_000)
                })
            })
            put("unavailable", "tmux-missing")
        })
        assertEquals(
            listOf(
                ClaudeAgentEntry("demo-agent", "claude-session-1", "Demo", "/Users/tester/project", "waiting", 1_700_000_000_000, "happy-1"),
                ClaudeAgentEntry("other-agent", "claude-session-2", null, "/Users/tester/other", "idle", 1_700_000_100_000, null),
            ),
            listing.agents,
        )
        assertEquals("tmux-missing", listing.unavailable)
    }

    @Test
    fun parseClaudeAgentsListingSkipsRowsWithoutAnIdAndKeepsAnAnswerWithNoUnavailable() {
        val listing = parseClaudeAgentsListing(buildJsonObject {
            put("agents", buildJsonArray {
                add(buildJsonObject { put("sessionId", "no-id"); put("cwd", "/Users/tester/x") })
                add(JsonPrimitive("junk"))
                add(buildJsonObject { put("id", "demo-agent"); put("cwd", "/Users/tester/project"); put("status", "idle") })
            })
        })
        assertEquals(listOf("demo-agent"), listing.agents.map { it.id })
        assertNull(listing.unavailable)
    }

    @Test
    fun anUnreadableAnswerIsAFailedListing() {
        for (answer in listOf(null, JsonNull, JsonPrimitive("garbage"), JsonArray(emptyList()))) {
            assertEquals(ClaudeAgentsListing(emptyList(), "agents-command-failed"), parseClaudeAgentsListing(answer))
        }
    }

    @Test
    fun unavailableMapsToANoticeOrSaysNothing() {
        assertNull(claudeAgentsNotice(null))
        assertNull(claudeAgentsNotice("unsupported"))
        assertEquals(ClaudeAgentsNotice.TmuxMissing, claudeAgentsNotice("tmux-missing"))
        assertEquals(ClaudeAgentsNotice.ClaudeMissing, claudeAgentsNotice("claude-missing"))
        assertEquals(ClaudeAgentsNotice.CouldNotList, claudeAgentsNotice("agents-command-failed"))
        assertEquals(ClaudeAgentsNotice.CouldNotList, claudeAgentsNotice("something-new"))
    }

    @Test
    fun folderTailIsTheLastPathComponent() {
        assertEquals("project", folderTail("/Users/tester/project"))
        assertEquals("project", folderTail("/Users/tester/project/"))
        assertEquals("project", folderTail("C:\\Users\\tester\\project"))
        assertEquals("/", folderTail("/"))
        assertEquals("project", folderTail("project"))
    }

    @Test
    fun aSyncWaitEndsAtItsBoundAndAFastOneIsNotCutShort() = runTest {
        awaitSyncBriefly { delay(100) }
        assertEquals(100L, currentTime)
        // A sync that never ends (offline, retrying) is let go of at the bound, in virtual time.
        awaitSyncBriefly { awaitCancellation() }
        assertEquals(100L + CLAUDE_AGENTS_SYNC_WAIT_MS, currentTime)
        assertEquals(5_000L, CLAUDE_AGENTS_SYNC_WAIT_MS)
    }
}
