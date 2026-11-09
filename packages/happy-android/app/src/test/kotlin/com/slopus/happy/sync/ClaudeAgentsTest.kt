package com.slopus.happy.sync

import com.slopus.happy.ui.home.ClaudeAgentStatusLabel
import com.slopus.happy.ui.home.ClaudeAgentsNotice
import com.slopus.happy.ui.home.claudeAgentBlocks
import com.slopus.happy.ui.home.claudeAgentStatusLabel
import com.slopus.happy.ui.home.claudeAgentsNotice
import com.slopus.happy.ui.home.folderTail
import com.slopus.happy.ui.home.visibleAgents
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The `list-claude-agents` answer as the app reads it, and what the home shows of it. */
class ClaudeAgentsTest {
    private fun agent(id: String, mirror: String? = null, name: String? = null, cwd: String = "/Users/tester/project") =
        ClaudeAgentEntry(id, "session-$id", name, cwd, "busy", 1_700_000_000_000, mirror)

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
    fun sectionHidesAgentsThatAlreadyHaveAMirrorRow() {
        val listing = ClaudeAgentsListing(
            listOf(agent("a", mirror = "happy-a"), agent("b", mirror = "gone"), agent("c", mirror = null)),
            unavailable = null,
        )
        assertEquals(listOf("b", "c"), visibleAgents(listing, setOf("happy-a", "other")).map { it.id })
        assertEquals(listOf("a", "b", "c"), visibleAgents(listing, emptySet()).map { it.id })
    }

    @Test
    fun unavailableMapsToANoticeOrHidesTheSection() {
        assertNull(claudeAgentsNotice(null))
        assertNull(claudeAgentsNotice("unsupported"))
        assertEquals(ClaudeAgentsNotice.TmuxMissing, claudeAgentsNotice("tmux-missing"))
        assertEquals(ClaudeAgentsNotice.ClaudeMissing, claudeAgentsNotice("claude-missing"))
        assertEquals(ClaudeAgentsNotice.CouldNotList, claudeAgentsNotice("agents-command-failed"))
        assertEquals(ClaudeAgentsNotice.CouldNotList, claudeAgentsNotice("something-new"))
    }

    @Test
    fun blocksShowAgentsAndNoticesAndHideEmptyOrUnsupportedMachines() {
        val listings = mapOf(
            "m1" to ClaudeAgentsListing(listOf(agent("a", mirror = "happy-a"), agent("b")), null),
            "m2" to ClaudeAgentsListing(emptyList(), null),
            "m3" to ClaudeAgentsListing(emptyList(), "unsupported"),
            "m4" to ClaudeAgentsListing(emptyList(), "tmux-missing"),
            "m5" to ClaudeAgentsListing(listOf(agent("c", mirror = "happy-a")), null),
        )
        val blocks = claudeAgentBlocks(
            machineIds = listOf("m1", "m2", "m3", "m4", "m5", "m6"),
            names = mapOf("m1" to "Studio", "m4" to "Laptop"),
            listings = listings,
            homeSessionIds = setOf("happy-a"),
        )
        assertEquals(listOf("m1", "m4"), blocks.map { it.machineId })
        assertEquals(listOf("b"), blocks[0].agents.map { it.id })
        assertNull(blocks[0].notice)
        assertEquals("Studio", blocks[0].machineName)
        assertTrue(blocks[1].agents.isEmpty())
        assertEquals(ClaudeAgentsNotice.TmuxMissing, blocks[1].notice)
    }

    @Test
    fun statusLabelsFollowTheDaemonsStatusAndShowAnUnknownOneRaw() {
        assertEquals(ClaudeAgentStatusLabel.Working, claudeAgentStatusLabel("busy"))
        assertEquals(ClaudeAgentStatusLabel.Idle, claudeAgentStatusLabel("idle"))
        assertEquals(ClaudeAgentStatusLabel.Waiting, claudeAgentStatusLabel("waiting"))
        assertEquals(ClaudeAgentStatusLabel.Other("sleeping"), claudeAgentStatusLabel("sleeping"))
    }

    @Test
    fun folderTailIsTheLastPathComponent() {
        assertEquals("project", folderTail("/Users/tester/project"))
        assertEquals("project", folderTail("/Users/tester/project/"))
        assertEquals("project", folderTail("C:\\Users\\tester\\project"))
        assertEquals("/", folderTail("/"))
        assertEquals("project", folderTail("project"))
    }
}
