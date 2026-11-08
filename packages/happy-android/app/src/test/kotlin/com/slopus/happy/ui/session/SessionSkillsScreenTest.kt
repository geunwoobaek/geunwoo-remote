package com.slopus.happy.ui.session

import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.model.HomeModelFixtures.metadata
import com.slopus.happy.sync.SavedWorkflow
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The skills screen: before Claude reports anything it says so; a skill or
 * command tapped goes to the composer; MCP servers show their state; a
 * workflow in the session's folder opens and one outside doesn't; an old CLI
 * gets "start a new session"; a long list can be searched.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SessionSkillsScreenTest {
    @get:Rule val rule = createComposeRule()

    private val inserted = mutableListOf<String>()
    private val opened = mutableListOf<String>()
    private var retries = 0
    private val actions = SessionSkillsActions(
        onBack = {},
        onInsert = { inserted += it },
        onOpenWorkflow = { opened += it.path },
        onRetryWorkflows = { retries++ },
    )

    private fun strings(values: List<String>) = JsonArray(values.map(::JsonPrimitive))

    private fun catalog(skills: List<String> = listOf("review-pr"), commands: List<String> = listOf("compact")) = SkillsCatalog.of(
        metadata {
            put("skills", strings(skills))
            put("slashCommands", strings(commands + skills))
            putJsonArray("mcpServers") { addJsonObject { put("name", "playwright"); put("status", "failed") } }
            put("tools", strings(listOf("Read")))
        },
    )

    private fun show(catalog: SkillsCatalog, workflows: WorkflowsState = WorkflowsState.Loaded(emptyList())) =
        rule.setHappyContent { SessionSkillsScreen(catalog, workflows, actions) }

    @Test fun beforeClaudeReportsAnythingTheScreenSaysSoInsteadOfShowingEmptyGroups() {
        show(SkillsCatalog.of(metadata()))
        rule.node(SessionSkillsTags.NOT_REPORTED).assertExists()
        rule.onNodeWithText("SKILLS").assertDoesNotExist()
        rule.onNodeWithText("Claude reported no skills, commands or tools.").assertDoesNotExist()
    }

    @Test fun tappingASkillOrCommandHandsItsNameToTheComposer() {
        show(catalog())
        rule.node(SessionSkillsTags.NOT_REPORTED).assertDoesNotExist()
        rule.node(SessionSkillsTags.skill("review-pr")).performClick()
        rule.node(SessionSkillsTags.command("compact")).performScrollTo().performClick()
        assertEquals(listOf("review-pr", "compact"), inserted)
    }

    @Test fun anMcpServerShowsItsStatusAndToolsAreListed() {
        show(catalog())
        rule.node(SessionSkillsTags.server("playwright")).performScrollTo()
        rule.onNodeWithText("failed").assertExists()
        rule.node(SessionSkillsTags.tool("Read")).performScrollTo().assertHasNoClickAction()
    }

    @Test fun aWorkflowInTheSessionsFolderOpensAndOneOutsideShowsItsDescriptionOnly() {
        val inside = SavedWorkflow("fun-harness", "Make it fun", scope = "project", path = "/repo/.claude/workflows/fun.js", inWorkingDirectory = true)
        val outside = SavedWorkflow("review", "Review a branch", scope = "user", path = "/Users/me/.claude/workflows/review.js")
        show(catalog(), WorkflowsState.Loaded(listOf(inside, outside)))
        rule.node(SessionSkillsTags.workflow(outside.path)).performScrollTo().assertHasNoClickAction()
        rule.onNodeWithText("Review a branch").assertExists()
        rule.node(SessionSkillsTags.workflow(inside.path)).performScrollTo().assertHasClickAction().performClick()
        assertEquals(listOf(inside.path), opened)
    }

    @Test fun anOldCliGetsANoteToStartANewSessionAndAFailureCanBeRetried() {
        show(catalog(), WorkflowsState.NeedsNewSession)
        rule.onNodeWithText("Start a new session to see workflows").assertExists()
        rule.node(SessionSkillsTags.WORKFLOWS_STATUS).assertHasNoClickAction()
    }

    @Test fun aFailedWorkflowListCanBeAskedAgain() {
        show(catalog(), WorkflowsState.Failed("RPC timeout"))
        rule.node(SessionSkillsTags.WORKFLOWS_STATUS).performClick()
        assertEquals(1, retries)
    }

    @Test fun aLongListCanBeSearchedAndSaysWhenNothingMatches() {
        val many = (1..20).map { "skill-$it" }
        show(catalog(skills = many))
        rule.node(SessionSkillsTags.SEARCH).performTextInput("skill-17")
        rule.node(SessionSkillsTags.skill("skill-17")).assertExists()
        rule.node(SessionSkillsTags.skill("skill-1")).assertDoesNotExist()
        rule.node(SessionSkillsTags.command("compact")).assertDoesNotExist()
        rule.node(SessionSkillsTags.SEARCH).performTextInput("zzz")
        rule.node(SessionSkillsTags.NO_MATCH).assertExists()
    }

    @Test fun aShortListHasNoSearchField() {
        show(catalog())
        rule.node(SessionSkillsTags.SEARCH).assertDoesNotExist()
    }
}
