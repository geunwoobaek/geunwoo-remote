package com.slopus.happy.model

import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ComposerModeResolver
import com.slopus.happy.chat.PermissionStatus
import com.slopus.happy.chat.ReducerOptions
import com.slopus.happy.chat.ReducerState
import com.slopus.happy.chat.ToolPermission
import com.slopus.happy.chat.agentMsg
import com.slopus.happy.chat.agentState
import com.slopus.happy.chat.tools.PermissionCardBody
import com.slopus.happy.chat.tools.PermissionChoice
import com.slopus.happy.chat.tools.permissionCardBody
import com.slopus.happy.chat.tool
import com.slopus.happy.chat.toolUse
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import com.slopus.happy.model.HomeModelFixtures.metadata
import com.slopus.happy.model.HomeModelFixtures.session
import com.slopus.happy.sync.ComposerMirror
import com.slopus.happy.attachments.imageAttachmentSendPlan
import com.slopus.happy.ui.attachments.canUseAttachments
import com.slopus.happy.ui.home.ResumeAvailability
import com.slopus.happy.ui.home.SessionActionId
import com.slopus.happy.ui.home.canForkSession
import com.slopus.happy.ui.home.resumeAvailability
import com.slopus.happy.ui.home.sessionActionIds
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A Happy session that mirrors a Mac `claude agents` background session
 * carries `claudeAgentId` in its metadata. The app recognises it and turns
 * off what cannot work for it: fork, resume, model and mode choice,
 * attachments, "allow always" answers. Its dialog cards read correctly.
 */
class ClaudeAgentMirrorTest {
    private fun mirrorMetadata() = metadata(path = "/Users/tester/project") {
        put("machineId", "m1")
        put("flavor", "claude")
        put("claudeSessionId", "claude-1")
        put("claudeAgentId", "demo-agent")
    }

    private fun normalMetadata() = metadata(path = "/Users/tester/project") {
        put("machineId", "m1")
        put("flavor", "claude")
        put("claudeSessionId", "claude-1")
    }

    private val resumeMachine = machine("m1", machineMetadata { putJsonObject("resumeSupport") { put("rpcAvailable", true) } })

    // recognising a mirror

    @Test fun `parses claudeAgentId from metadata JSON`() {
        val parsed = SessionMetadata.parse("""{"path":"/Users/tester/project","host":"h","flavor":"claude","claudeAgentId":"demo-agent"}""")!!
        assertEquals("demo-agent", parsed.claudeAgentId)
        assertTrue(parsed.isClaudeAgentMirror())
        assertNull(SessionMetadata.parse("""{"path":"/p","host":"h"}""")!!.claudeAgentId)
    }

    @Test fun `a missing or blank agent id is not a mirror`() {
        assertFalse(null.isClaudeAgentMirror())
        assertFalse(normalMetadata().isClaudeAgentMirror())
        assertFalse(metadata { put("claudeAgentId", "  ") }.isClaudeAgentMirror())
        assertTrue(mirrorMetadata().isClaudeAgentMirror())
    }

    // what is turned off

    @Test fun `forkSource is null for a mirror`() {
        val mirror = session("s", metadata = mirrorMetadata())
        assertNull(mirror.forkSource())
        assertFalse(canForkSession(mirror, resumeMachine, continuationExperiments = true))
    }

    @Test fun `resumeAvailability hides resume for a mirror`() {
        val mirror = session("s", metadata = mirrorMetadata(), active = false)
        assertEquals(ResumeAvailability.Hidden, resumeAvailability(mirror, resumeMachine))
        // Even with nothing else wrong: the actions menu has no Resume, Fork or Duplicate.
        assertEquals(
            listOf(SessionActionId.Details, SessionActionId.Archive),
            sessionActionIds(mirror, resumeMachine, continuationExperiments = true, devMode = false),
        )
    }

    @Test fun `model and permission selection are off for a mirror`() {
        val modes = ComposerModeResolver.resolve(mirrorMetadata(), ComposerMirror(), null) { "tr:$it" }
        assertFalse(modes.canChangeModel)
        assertFalse(modes.canChangeEffort)
        assertFalse(modes.canChangePermission)
    }

    @Test fun `attachments are off for a mirror`() {
        assertFalse(canUseAttachments(mirrorMetadata()))
        val plan = imageAttachmentSendPlan(mirrorMetadata(), "look", attachmentCount = 1)
        assertFalse(plan.supportsAttachments)
        assertFalse(plan.shouldUseAttachments)
    }

    @Test fun `a normal Claude session keeps fork and resume`() {
        val normal = session("s", metadata = normalMetadata(), active = false)
        assertNotNull(normal.forkSource())
        assertEquals(ResumeAvailability(true, true, null), resumeAvailability(normal, resumeMachine))
        assertTrue(canForkSession(normal, resumeMachine, continuationExperiments = true))
        assertEquals(
            listOf(SessionActionId.Details, SessionActionId.Resume, SessionActionId.Fork, SessionActionId.Duplicate, SessionActionId.Archive),
            sessionActionIds(normal, resumeMachine, continuationExperiments = true, devMode = false),
        )
        val modes = ComposerModeResolver.resolve(normalMetadata(), ComposerMirror(), null) { "tr:$it" }
        assertTrue(modes.canChangeModel)
        assertTrue(modes.canChangeEffort)
        assertTrue(modes.canChangePermission)
        assertTrue(canUseAttachments(normalMetadata()))
        assertTrue(imageAttachmentSendPlan(normalMetadata(), "look", attachmentCount = 1).shouldUseAttachments)
    }

    // permission cards

    private fun pending(id: String = "toolu_1") = ToolPermission(id, PermissionStatus.Pending)

    private fun choices(body: PermissionCardBody): List<PermissionChoice> =
        (body as PermissionCardBody.Buttons).options.map { it.choice }

    @Test fun `a mirror permission card offers only allow and deny`() {
        val bash = permissionCardBody(pending(), "Bash", null, "claude", mirror = true)
        assertEquals(listOf(PermissionChoice.Allow, PermissionChoice.Deny), choices(bash))
        val edit = permissionCardBody(pending(), "Edit", null, "claude", mirror = true)
        assertEquals(listOf(PermissionChoice.Allow, PermissionChoice.Deny), choices(edit))
        val plan = permissionCardBody(pending(), "ExitPlanMode", null, "claude", mirror = true)
        assertEquals(listOf(PermissionChoice.Allow, PermissionChoice.Deny), choices(plan))
    }

    @Test fun `a mirror plain allow does not switch the composer mode`() {
        val plan = permissionCardBody(pending(), "ExitPlanMode", null, "claude", mirror = true) as PermissionCardBody.Buttons
        assertNull(plan.options.first { it.choice == PermissionChoice.Allow }.mode)
    }

    @Test fun `a normal Claude permission card is unchanged`() {
        assertEquals(
            listOf(PermissionChoice.Allow, PermissionChoice.AllowForTool, PermissionChoice.Deny),
            choices(permissionCardBody(pending(), "Bash", null, "claude", mirror = false)),
        )
        assertEquals(
            listOf(PermissionChoice.Allow, PermissionChoice.AllowAllEdits, PermissionChoice.Deny),
            choices(permissionCardBody(pending(), "Edit", null, "claude", mirror = false)),
        )
        val plan = permissionCardBody(pending(), "ExitPlanMode", null, "claude", mirror = false) as PermissionCardBody.Buttons
        assertEquals(
            listOf(PermissionChoice.Allow, PermissionChoice.AllowAllEdits, PermissionChoice.AllowEverything, PermissionChoice.Deny),
            plan.options.map { it.choice },
        )
        assertEquals("default", plan.options.first { it.choice == PermissionChoice.Allow }.mode)
    }

    // "answer on your Mac"

    private fun canceled(reason: String?) = ToolPermission("screen:abc", PermissionStatus.Canceled, reason = reason)

    @Test fun `a refused request tells the user to answer on the Mac`() {
        for (reason in listOf("answer-on-mac", "typing-failed")) {
            assertEquals(
                PermissionCardBody.AnswerOnMac,
                permissionCardBody(canceled(reason), "Bash", null, "claude", mirror = true),
            )
        }
    }

    @Test fun `other canceled cards and non-mirror sessions are not changed`() {
        assertTrue(permissionCardBody(canceled("answer-on-mac"), "Bash", null, "claude", mirror = false) is PermissionCardBody.Buttons)
        assertTrue(permissionCardBody(canceled("User canceled"), "Bash", null, "claude", mirror = true) is PermissionCardBody.Buttons)
        assertTrue(permissionCardBody(canceled(null), "Bash", null, "claude", mirror = true) is PermissionCardBody.Buttons)
        // A completed answer stays as it was, whatever reason text it carries.
        val approved = ToolPermission("toolu_1", PermissionStatus.Approved, reason = "answer-on-mac")
        assertTrue(permissionCardBody(approved, "Bash", null, "claude", mirror = true) is PermissionCardBody.Buttons)
    }

    @Test fun `an unreadable pending dialog shows no answer buttons only the Mac line`() {
        assertEquals(
            PermissionCardBody.AnswerOnMac,
            permissionCardBody(pending("screen:abc"), "Unknown", null, "claude", mirror = true),
        )
        // In a normal session a tool called Unknown keeps its buttons.
        assertTrue(permissionCardBody(pending("screen:abc"), "Unknown", null, "claude", mirror = false) is PermissionCardBody.Buttons)
    }

    @Test fun `the reducer carries a refusal reason and an unreadable request to the card`() {
        val state = ReducerState(now = { 999_999 })
        val result = state.reduce(
            emptyList(),
            agentState(
                """{"requests":{"screen:u1":{"tool":"Unknown","arguments":{},"createdAt":1000}},""" +
                    """"completedRequests":{"screen:c1":{"tool":"Bash","arguments":{"command":"ls"},"createdAt":500,"completedAt":900,""" +
                    """"status":"canceled","reason":"answer-on-mac"}}}""",
            ),
            ReducerOptions(mirror = true),
        )
        val tools = result.messages.map { it.tool }
        val unknown = tools.single { it.name == "Unknown" }
        val refused = tools.single { it.name == "Bash" }
        assertEquals(PermissionCardBody.AnswerOnMac, permissionCardBody(unknown.permission!!, unknown.name, unknown.input, "claude", mirror = true))
        assertEquals(PermissionCardBody.AnswerOnMac, permissionCardBody(refused.permission!!, refused.name, refused.input, "claude", mirror = true))
    }

    // the screen: card

    private val screenCompleted =
        """{"completedRequests":{"screen:abc":{"tool":"Bash","arguments":{"command":"ls"},"createdAt":1000,"completedAt":1500,"status":"approved"}}}"""
    private val screenPending =
        """{"requests":{"screen:abc":{"tool":"Bash","arguments":{"command":"ls"},"createdAt":1000}}}"""
    private val mirrorOptions = ReducerOptions(mirror = true)

    private fun ReducerState.rows() = snapshot().filterIsInstance<ChatMessage.ToolCallMessage>()

    @Test fun `a completed screen card is hidden once the real tool message arrives`() {
        val state = ReducerState(now = { 999_999 })
        val first = state.reduce(emptyList(), agentState(screenCompleted), mirrorOptions)
        val card = first.messages.single()
        assertEquals("screen:abc", card.tool.callId)
        assertTrue(first.hiddenMessageIds.isEmpty())

        val second = state.reduce(
            listOf(agentMsg("a1", 2000, toolUse("toolu_1", "Bash", """{"command":"ls"}"""))),
            agentState(screenCompleted),
            mirrorOptions,
        )
        assertEquals(setOf(card.id), second.hiddenMessageIds)
        assertEquals(listOf("toolu_1"), second.messages.map { it.tool.callId })
        assertEquals(listOf("toolu_1"), state.rows().map { it.tool.callId })

        // It stays hidden when the agent state is applied again.
        val third = state.reduce(emptyList(), agentState(screenCompleted), mirrorOptions)
        assertTrue(third.messages.none { it.id == card.id })
        assertEquals(listOf("toolu_1"), state.rows().map { it.tool.callId })
    }

    @Test fun `a pending screen card stays while its row arrives and hides once it is approved`() {
        // The card is raised when the dialog is read; the tool row reaches the transcript after it
        // (while the card is still pending, or after it is answered). Only the approved card hides.
        // (A tool_use already in the transcript when the dialog appears gets a toolu_ key, not screen:.)
        val state = ReducerState(now = { 999_999 })
        val first = state.reduce(
            listOf(agentMsg("a1", 2000, toolUse("toolu_1", "Bash", """{"command":"ls"}"""))),
            agentState(screenPending),
            mirrorOptions,
        )
        assertTrue(first.hiddenMessageIds.isEmpty())
        assertEquals(setOf("screen:abc", "toolu_1"), state.rows().map { it.tool.callId }.toSet())

        val second = state.reduce(emptyList(), agentState(screenCompleted), mirrorOptions)
        assertEquals(1, second.hiddenMessageIds.size)
        assertTrue(second.messages.none { it.tool.callId == "screen:abc" })
        assertEquals(listOf("toolu_1"), state.rows().map { it.tool.callId })
    }

    @Test fun `a completed screen card is hidden when both arrive in one batch`() {
        val state = ReducerState(now = { 999_999 })
        val result = state.reduce(
            listOf(agentMsg("a1", 2000, toolUse("toolu_1", "Bash", """{"command":"ls"}"""))),
            agentState(screenCompleted),
            mirrorOptions,
        )
        assertEquals(listOf("toolu_1"), result.messages.map { it.tool.callId })
        assertEquals(1, result.hiddenMessageIds.size)
    }

    @Test fun `a pending screen card is never hidden`() {
        val state = ReducerState(now = { 999_999 })
        val result = state.reduce(
            listOf(agentMsg("a1", 2000, toolUse("toolu_1", "Bash"))),
            agentState(screenPending),
            mirrorOptions,
        )
        assertTrue(result.hiddenMessageIds.isEmpty())
        assertEquals(setOf("screen:abc", "toolu_1"), state.rows().map { it.tool.callId }.toSet())
    }

    @Test fun `a screen card in a normal session is never hidden`() {
        val state = ReducerState(now = { 999_999 })
        val result = state.reduce(
            listOf(agentMsg("a1", 2000, toolUse("toolu_1", "Bash"))),
            agentState(screenCompleted),
            ReducerOptions(),
        )
        assertTrue(result.hiddenMessageIds.isEmpty())
        assertEquals(setOf("screen:abc", "toolu_1"), state.rows().map { it.tool.callId }.toSet())
    }

    @Test fun `a screen card stays when the later tool message is another tool`() {
        val state = ReducerState(now = { 999_999 })
        val result = state.reduce(
            listOf(agentMsg("a1", 2000, toolUse("toolu_1", "Read", """{"file_path":"/Users/tester/project/a.txt"}"""))),
            agentState(screenCompleted),
            mirrorOptions,
        )
        assertTrue(result.hiddenMessageIds.isEmpty())
        assertEquals(setOf("screen:abc", "toolu_1"), state.rows().map { it.tool.callId }.toSet())
    }

    private fun screenCard(key: String, createdAt: Long, status: String, tool: String = "Bash") =
        """"$key":{"tool":"$tool","arguments":{"command":"ls"},"createdAt":$createdAt,"completedAt":${createdAt + 500},"status":"$status"}"""

    private fun completedCards(vararg cards: String) = agentState("""{"completedRequests":{${cards.joinToString(",")}}}""")

    private fun bashRow(id: String, toolId: String, createdAt: Long) =
        agentMsg(id, createdAt, toolUse(toolId, "Bash", """{"command":"ls"}"""))

    @Test fun `a screen card stays when the same tool came well before it`() {
        val state = ReducerState(now = { 999_999 })
        val result = state.reduce(
            listOf(bashRow("a1", "toolu_old", 5_000)),
            completedCards(screenCard("screen:abc", 20_000, "approved")),
            mirrorOptions,
        )
        assertTrue(result.hiddenMessageIds.isEmpty())
        assertEquals(setOf("screen:abc", "toolu_old"), state.rows().map { it.tool.callId }.toSet())
    }

    @Test fun `a row stamped a few seconds before its card still hides it`() {
        // The card's time is the Mac CLI's clock, the row's is the server's.
        val state = ReducerState(now = { 999_999 })
        val result = state.reduce(
            listOf(bashRow("a1", "toolu_1", 7_000)),
            completedCards(screenCard("screen:abc", 10_000, "approved")),
            mirrorOptions,
        )
        assertEquals(1, result.hiddenMessageIds.size)
        assertEquals(listOf("toolu_1"), state.rows().map { it.tool.callId })
    }

    @Test fun `a denied or canceled screen card stays whatever row follows`() {
        for (status in listOf("denied", "canceled")) {
            val state = ReducerState(now = { 999_999 })
            val result = state.reduce(
                listOf(bashRow("a1", "toolu_1", 2_000)),
                completedCards(screenCard("screen:abc", 1_000, status)),
                mirrorOptions,
            )
            assertTrue(status, result.hiddenMessageIds.isEmpty())
            assertEquals(status, setOf("screen:abc", "toolu_1"), state.rows().map { it.tool.callId }.toSet())
        }
    }

    @Test fun `an approved card stays when the only same-tool row is minutes later`() {
        val state = ReducerState(now = { 999_999 })
        val result = state.reduce(
            listOf(bashRow("a1", "toolu_1", 1_000 + 600_000)),
            completedCards(screenCard("screen:abc", 1_000, "approved")),
            mirrorOptions,
        )
        assertTrue(result.hiddenMessageIds.isEmpty())
        assertEquals(setOf("screen:abc", "toolu_1"), state.rows().map { it.tool.callId }.toSet())
    }

    @Test fun `two dialogs in a row hide only the card that has its row`() {
        val state = ReducerState(now = { 999_999 })
        val cards = completedCards(screenCard("screen:one", 1_000, "approved"), screenCard("screen:two", 3_000, "approved"))
        // Both cards are answered, but only the first call has reached the transcript.
        val result = state.reduce(listOf(bashRow("a1", "toolu_1", 2_000)), cards, mirrorOptions)
        assertEquals(1, result.hiddenMessageIds.size)
        assertEquals(setOf("screen:two", "toolu_1"), state.rows().map { it.tool.callId }.toSet())

        // The second call's row arrives later and hides the second card.
        val later = state.reduce(listOf(bashRow("a2", "toolu_2", 4_000)), cards, mirrorOptions)
        assertEquals(1, later.hiddenMessageIds.size)
        assertEquals(setOf("toolu_1", "toolu_2"), state.rows().map { it.tool.callId }.toSet())
    }

    @Test fun `one row hides only the earlier of two approved cards`() {
        val state = ReducerState(now = { 999_999 })
        val result = state.reduce(
            listOf(bashRow("a1", "toolu_1", 3_000)),
            completedCards(screenCard("screen:one", 1_000, "approved"), screenCard("screen:two", 2_000, "approved")),
            mirrorOptions,
        )
        assertEquals(1, result.hiddenMessageIds.size)
        assertEquals(setOf("screen:two", "toolu_1"), state.rows().map { it.tool.callId }.toSet())
    }

    @Test fun `a placeholder row from a pending tool use request does not hide a screen card`() {
        val state = ReducerState(now = { 999_999 })
        val placeholder = agentState(
            """{"requests":{"toolu_p":{"tool":"Bash","arguments":{"command":"ls"},"createdAt":2000}},""" +
                """"completedRequests":{${screenCard("screen:abc", 1_000, "approved")}}}""",
        )
        val result = state.reduce(emptyList(), placeholder, mirrorOptions)
        assertTrue(result.hiddenMessageIds.isEmpty())
        assertEquals(setOf("screen:abc", "toolu_p"), state.rows().map { it.tool.callId }.toSet())
    }

    @Test fun `a completed card keyed by a tool use id is never hidden`() {
        val state = ReducerState(now = { 999_999 })
        val completed =
            """{"completedRequests":{"toolu_9":{"tool":"Bash","arguments":{"command":"ls"},"createdAt":1000,"completedAt":1500,"status":"approved"}}}"""
        val result = state.reduce(
            listOf(agentMsg("a1", 2000, toolUse("toolu_1", "Bash"))),
            agentState(completed),
            mirrorOptions,
        )
        assertTrue(result.hiddenMessageIds.isEmpty())
        assertEquals(setOf("toolu_9", "toolu_1"), state.rows().map { it.tool.callId }.toSet())
    }
}
