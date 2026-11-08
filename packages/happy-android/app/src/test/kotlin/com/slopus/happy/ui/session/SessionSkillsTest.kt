package com.slopus.happy.ui.session

import com.slopus.happy.model.HomeModelFixtures.metadata
import com.slopus.happy.sync.ListWorkflowsResult
import com.slopus.happy.sync.SavedWorkflow
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What a session says it can use, as the skills screen lists it: skills
 * once and apart from commands, no command the phone can't use, MCP servers
 * with their own tools counted, "nothing yet" told apart from "nothing", a
 * picked command at the front of the draft, and an old CLI's missing
 * workflow list told apart from a failure.
 */
class SessionSkillsTest {
    private fun strings(vararg values: String) = JsonArray(values.map(::JsonPrimitive))

    private val reported = metadata {
        put("skills", strings("review-pr", "Brainstorming", "review-pr"))
        put("slashCommands", strings("compact", "review-pr", "login", "Brainstorming", "context", "add-dir"))
        putJsonArray("mcpServers") {
            addJsonObject { put("name", "playwright"); put("status", "connected") }
            addJsonObject { put("name", "atlassian"); put("status", "needs-auth") }
        }
        putJsonArray("tools") {
            add("Read"); add("Bash"); add("mcp__playwright__browser_click"); add("mcp__playwright__browser_type"); add("Edit")
        }
    }

    @Test fun skillsAreListedOnceSortedAndNotAgainAsCommands() {
        val catalog = SkillsCatalog.of(reported)
        assertEquals(listOf("Brainstorming", "review-pr"), catalog.skills)
        assertEquals(listOf("compact", "context"), catalog.commands)
    }

    @Test fun mcpServersKeepTheirStatusAndCountTheirOwnTools() {
        val catalog = SkillsCatalog.of(reported)
        assertEquals(listOf(McpServerEntry("atlassian", "needs-auth", 0), McpServerEntry("playwright", "connected", 2)), catalog.servers)
        assertEquals(listOf("Bash", "Edit", "Read"), catalog.tools)
    }

    @Test fun aSessionThatHasNotReportedIsToldApartFromOneThatReportedNothing() {
        assertFalse(SkillsCatalog.of(null).reported)
        assertFalse(SkillsCatalog.of(metadata()).reported)
        val empty = SkillsCatalog.of(metadata { put("slashCommands", strings()) })
        assertTrue(empty.reported)
        assertTrue(empty.isEmpty)
    }

    @Test fun searchingKeepsTheNamesThatContainTheWordsInAnyCase() {
        val found = SkillsCatalog.of(reported).filter("  REV ")
        assertEquals(listOf("review-pr"), found.skills)
        assertTrue(found.commands.isEmpty() && found.servers.isEmpty() && found.tools.isEmpty())
        assertEquals(SkillsCatalog.of(reported), SkillsCatalog.of(reported).filter(" "))
    }

    @Test fun aPickedCommandStartsTheDraftReadyForItsArguments() {
        assertEquals("/review-pr ", SkillsCatalog.withCommand("", "review-pr"))
        assertEquals("/review-pr ", SkillsCatalog.withCommand("  \n", "/review-pr"))
        assertEquals("/review-pr the login bug", SkillsCatalog.withCommand("the login bug", "review-pr"))
        assertEquals("/review-pr 123", SkillsCatalog.withCommand("/compact 123", "review-pr"))
        assertEquals("/review-pr ", SkillsCatalog.withCommand("/compact", "review-pr"))
    }

    @Test fun mcpStatusesReadAsHealthAtAGlance() {
        assertEquals(McpServerHealth.Connected, mcpServerHealth("connected"))
        assertEquals(McpServerHealth.Waiting, mcpServerHealth("needs-auth"))
        assertEquals(McpServerHealth.Waiting, mcpServerHealth("pending"))
        assertEquals(McpServerHealth.Failed, mcpServerHealth("failed"))
        assertEquals(McpServerHealth.Other, mcpServerHealth("disabled"))
    }

    private val project = SavedWorkflow("fun-harness", "Make it fun", scope = "project", path = "/repo/.claude/workflows/fun.js", inWorkingDirectory = true)
    private val user = SavedWorkflow("review", "Review a branch", scope = "user", path = "/Users/me/.claude/workflows/review.js")

    @Test fun anOldCliWithoutTheWorkflowListAsksForANewSessionInsteadOfFailing() {
        assertEquals(WorkflowsState.NeedsNewSession, WorkflowsState.of(ListWorkflowsResult(false, error = "Method not found")))
        assertEquals(WorkflowsState.Failed("RPC timeout"), WorkflowsState.of(ListWorkflowsResult(false, error = "RPC timeout")))
        assertEquals(WorkflowsState.Loaded(listOf(project, user)), WorkflowsState.of(ListWorkflowsResult(true, listOf(project, user))))
        assertEquals(WorkflowsState.Loaded(emptyList()), WorkflowsState.of(ListWorkflowsResult(true)))
    }

    @Test fun workflowsAreFoundByNameOrDescriptionAndOnlyThoseInTheFolderOpen() {
        val loaded = WorkflowsState.Loaded(listOf(project, user))
        assertEquals(listOf(user), loaded.filter("branch"))
        assertEquals(listOf(project), loaded.filter("FUN"))
        assertEquals(listOf(project, user), loaded.filter(""))
        assertTrue(project.opensInViewer)
        assertFalse(user.opensInViewer)
    }
}
