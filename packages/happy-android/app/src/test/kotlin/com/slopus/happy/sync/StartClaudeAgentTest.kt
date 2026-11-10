package com.slopus.happy.sync

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** `start-claude-agent` and `discard-claude-agent` as the app asks and reads them, and the listing's `startSupported`. */
class StartClaudeAgentTest {
    @Test
    fun readsEachStartAnswer() {
        assertEquals(
            StartClaudeAgentResult.Success("mirror-1", "35d81094"),
            StartClaudeAgentResult.parse(buildJsonObject { put("type", "success"); put("sessionId", "mirror-1"); put("agentId", "35d81094") }),
        )
        assertEquals(
            StartClaudeAgentResult.NeedsDirectoryApproval("/Users/tester/project/new"),
            StartClaudeAgentResult.parse(buildJsonObject { put("type", "requestToApproveDirectoryCreation"); put("directory", "/Users/tester/project/new") }),
        )
        val untrusted = "Workspace not trusted. Run `claude` in /Users/tester/project once and accept the trust prompt, then retry."
        assertEquals(
            StartClaudeAgentResult.Untrusted("/Users/tester/project", untrusted),
            StartClaudeAgentResult.parse(buildJsonObject {
                put("type", "error"); put("code", "untrusted-folder"); put("errorMessage", untrusted); put("directory", "/Users/tester/project")
            }),
        )
        for (code in listOf("claude-missing", "tmux-missing", "start-failed")) {
            assertEquals(
                StartClaudeAgentResult.Failed(code, "It went wrong"),
                StartClaudeAgentResult.parse(buildJsonObject { put("type", "error"); put("code", code); put("errorMessage", "It went wrong") }),
            )
        }
    }

    @Test
    fun anUntrustedAnswerWithoutItsDirectoryNamesTheOneAskedFor() {
        assertEquals(
            StartClaudeAgentResult.Untrusted("/Users/tester/project", "Workspace not trusted."),
            StartClaudeAgentResult.parse(
                buildJsonObject { put("type", "error"); put("code", "untrusted-folder"); put("errorMessage", "Workspace not trusted.") },
                requestedDirectory = "/Users/tester/project",
            ),
        )
    }

    @Test
    fun anErrorWithoutCodeOrWordsIsAFailedStart() {
        assertEquals(
            StartClaudeAgentResult.Failed("start-failed", "Failed to start session"),
            StartClaudeAgentResult.parse(buildJsonObject { put("type", "error") }),
        )
    }

    @Test
    fun garbageIsUnreadable() {
        val unreadable = StartClaudeAgentResult.Failed("unreadable", SpawnSessionResult.UNREADABLE)
        assertEquals(unreadable, StartClaudeAgentResult.parse(null))
        assertEquals(unreadable, StartClaudeAgentResult.parse(JsonPrimitive("garbage")))
        assertEquals(unreadable, StartClaudeAgentResult.parse(buildJsonObject { put("type", "pending") }))
        // A success that names no Mac session cannot be discarded later, so it is not one.
        assertEquals(unreadable, StartClaudeAgentResult.parse(buildJsonObject { put("type", "success"); put("sessionId", "mirror-1") }))
        assertEquals(unreadable, StartClaudeAgentResult.parse(buildJsonObject { put("type", "requestToApproveDirectoryCreation") }))
    }

    @Test
    fun theRequestCarriesThePlaceTheNameAndTheRequestIdAndLeavesOutNullModes() {
        val bare = StartClaudeAgentRequest(directory = "/Users/tester/project", name = "fix the login bug", clientRequestId = "r1").toJson()
        assertEquals(
            buildJsonObject {
                put("directory", "/Users/tester/project")
                put("name", "fix the login bug")
                put("approvedNewDirectoryCreation", false)
                put("clientRequestId", "r1")
            },
            bare,
        )
        val full = StartClaudeAgentRequest(
            directory = "/Users/tester/project",
            name = "project",
            model = "opus",
            permissionMode = "acceptEdits",
            effort = "high",
            approvedNewDirectoryCreation = true,
        ).toJson()
        assertEquals("opus", full.string("model"))
        assertEquals("acceptEdits", full.string("permissionMode"))
        assertEquals("high", full.string("effort"))
        assertEquals(JsonPrimitive(true), full["approvedNewDirectoryCreation"])
        assertFalse("clientRequestId" in full)
    }

    @Test
    fun theNameIsTheFirstLineCutOrElseTheFolder() {
        assertEquals("fix the login bug", claudeAgentName("  fix the login bug\nmore", "/Users/tester/project"))
        assertEquals("a".repeat(40), claudeAgentName("a".repeat(60), "/Users/tester/project"))
        assertEquals("project", claudeAgentName("   ", "/Users/tester/project"))
        assertEquals("project", claudeAgentName("", "/Users/tester/project/"))
    }

    @Test
    fun readsEachDiscardAnswer() {
        assertEquals(DiscardClaudeAgentResult.Success, DiscardClaudeAgentResult.parse(buildJsonObject { put("type", "success") }))
        assertEquals(
            DiscardClaudeAgentResult.Failed("not-started-here", "Not started here"),
            DiscardClaudeAgentResult.parse(buildJsonObject { put("type", "error"); put("code", "not-started-here"); put("errorMessage", "Not started here") }),
        )
        assertEquals(
            DiscardClaudeAgentResult.Failed("unreadable", SpawnSessionResult.UNREADABLE),
            DiscardClaudeAgentResult.parse(JsonPrimitive("garbage")),
        )
    }

    @Test
    fun theListingSaysWhetherTheDaemonCanStartBackgroundSessions() {
        assertTrue(parseClaudeAgentsListing(buildJsonObject { putJsonArray("agents") { }; put("startSupported", true) }).startSupported)
        assertFalse(parseClaudeAgentsListing(buildJsonObject { putJsonArray("agents") { } }).startSupported)
        assertFalse(parseClaudeAgentsListing(buildJsonObject { putJsonArray("agents") { }; put("startSupported", false) }).startSupported)
        assertFalse(parseClaudeAgentsListing(JsonPrimitive("garbage")).startSupported)
    }
}
