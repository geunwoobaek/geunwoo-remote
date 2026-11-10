package com.slopus.happy.ui.files

import com.slopus.happy.chat.ChatFeed
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatMessagesSource
import com.slopus.happy.chat.ChatPage
import com.slopus.happy.chat.ChatPresenceSource
import com.slopus.happy.chat.ChatReduction
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.chat.ChatSessionSource
import com.slopus.happy.chat.SessionPresenceState
import com.slopus.happy.chat.ToolCall
import com.slopus.happy.chat.ToolState
import com.slopus.happy.data.MessageRecord
import com.slopus.happy.data.SessionRecord
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The detail screen finds a tool by its call id, lowering the chat's window when it is not in view. */
class MessageDetailLookupTest {
    private fun userRecord(seq: Long, text: String) = MessageRecord(
        "s", seq, "u$seq", null, """{"role":"user","content":{"type":"text","text":"$text"}}""", seq, seq,
    )

    /** A tool call and its result, as the agent's session protocol writes them. */
    private fun toolRecords(seq: Long, call: String): List<MessageRecord> {
        fun envelope(id: String, ev: String) = """{"role":"agent","content":{"type":"session","data":{"id":"$id","time":$seq,"role":"agent","turn":"t$seq","ev":$ev}}}"""
        return listOf(
            MessageRecord("s", seq, "a$seq", null, envelope("e$seq", """{"t":"tool-call-start","call":"$call","name":"Bash","title":"Bash","description":"","args":{"command":"ls /Users/tester/project"}}"""), seq, seq),
            MessageRecord("s", seq + 1, "b$seq", null, envelope("f$seq", """{"t":"tool-call-end","call":"$call"}"""), seq + 1, seq + 1),
        )
    }

    private fun session() = SessionRecord("s", 0, 1, 1, true, 5, """{"path":"/Users/tester/project","host":"box"}""", 1, null, 1, "", null)

    private fun tool(id: String, call: String?, children: List<ChatMessage> = emptyList()) =
        ChatMessage.ToolCallMessage(id, 1, ToolCall(callId = call, name = "Bash", state = ToolState.Completed, input = null, createdAt = 1), children = children)

    private fun tools(rows: List<ChatMessage>) = rows.filterIsInstance<ChatMessage.ToolCallMessage>()

    @Test
    fun findsByCallIdAcrossReductions() {
        val all = listOf(userRecord(1, "go")) + toolRecords(2, "call-a") + toolRecords(4, "call-b")
        val info = ChatSessionInfo.from(session())
        // The chat saw the newest records first and the older ones later; the detail screen reduces everything at once.
        val chat = ChatReduction { 0 }
        chat.apply(ChatPage(all.takeLast(2)), info)
        val incremental = chat.apply(ChatPage(all), info).rows.map { it.message }
        val fresh = ChatReduction { 0 }.apply(ChatPage(all), info).rows.map { it.message }
        val a1 = tools(incremental).single { it.tool.callId == "call-a" }
        val a2 = tools(fresh).single { it.tool.callId == "call-a" }
        assertNotEquals("row ids depend on reduction order", a1.id, a2.id)
        assertEquals(detailKey(a1), detailKey(a2))
        assertEquals(a2, findMessage(fresh, detailKey(a1)))
        assertEquals(a1, findMessage(incremental, detailKey(a2)))
    }

    @Test
    fun findsNestedSubagentTool() {
        val inner = tool("m9", "inner")
        val outer = tool("m1", "outer", children = listOf(inner))
        assertEquals(inner, findMessage(listOf(outer), "inner"))
        assertEquals(outer, findMessage(listOf(outer), "outer"))
        assertNull(findMessage(listOf(outer), "missing"))
    }

    @Test
    fun oldIdStillResolves() {
        val rows = ChatReduction { 0 }.apply(ChatPage(listOf(userRecord(1, "go")) + toolRecords(2, "call-a")), ChatSessionInfo.from(session())).rows.map { it.message }
        val found = tools(rows).single()
        assertEquals(found, findMessage(rows, found.id))
        assertNotNull(findMessage(rows, "call-a"))
        assertEquals(tool("m3", "x"), findMessage(listOf(tool("m3", "x")), "m3"))
    }

    @Test
    fun aToolWithoutACallIdKeysByRowId() {
        assertEquals("m4", detailKey(tool("m4", null)))
    }

    /** A chat whose page list grows one step per [loadOlder]: step [n] is what the chat shows after n lowerings. */
    private class Source(private val pages: List<List<MessageRecord>>, private val hasMore: (Int) -> Boolean) : ChatMessagesSource {
        var lowered = 0
        val page = MutableStateFlow(ChatPage(pages[0], hasMoreOlder = hasMore(0)))
        override fun messages(sessionId: String, windowToken: String?): Flow<ChatPage> = page
        override suspend fun loadOlder(sessionId: String): Boolean {
            lowered++
            page.value = ChatPage(pages[lowered.coerceAtMost(pages.size - 1)], hasMoreOlder = hasMore(lowered))
            return true
        }
    }

    private fun feed(source: ChatMessagesSource) = ChatFeed(
        messages = source,
        sessions = object : ChatSessionSource { override fun session(sessionId: String): Flow<SessionRecord?> = MutableStateFlow(session()) },
        presence = object : ChatPresenceSource { override fun presence(sessionId: String): Flow<SessionPresenceState?> = MutableStateFlow(null) },
    )

    @Test
    fun detailFindsAToolBelowTheWindow() = runBlocking {
        val newest = listOf(userRecord(10, "recent"))
        // The window only grows downward: each page holds the one before it, older records first.
        val one = listOf(userRecord(9, "x")) + newest
        val two = listOf(userRecord(8, "y")) + one
        val withTool = listOf(userRecord(1, "start")) + toolRecords(2, "deep-call") + two
        val source = Source(listOf(newest, one, two, withTool)) { true }
        var backs = 0
        val found = lowerUntilFound(feed(source).state("s"), "deep-call", { source.loadOlder("s") }, { backs++ })
        assertTrue(found)
        assertEquals(0, backs)
        // One batch per try, not the whole history at once.
        assertEquals(3, source.lowered)
    }

    @Test
    fun detailGivesUpAfterTenLowerings() = runBlocking {
        val source = Source(listOf(listOf(userRecord(10, "recent")))) { true }
        var backs = 0
        val found = lowerUntilFound(feed(source).state("s"), "nowhere", { source.loadOlder("s") }, { backs++ }, settleMillis = 50)
        assertFalse(found)
        assertEquals(1, backs)
        assertEquals(10, source.lowered)
    }

    @Test
    fun detailGoesBackWhenNothingOlderIsLeft() = runBlocking {
        val source = Source(listOf(listOf(userRecord(10, "recent")))) { false }
        var backs = 0
        val found = lowerUntilFound(feed(source).state("s"), "nowhere", { source.loadOlder("s") }, { backs++ })
        assertFalse(found)
        assertEquals(1, backs)
        assertEquals(0, source.lowered)
    }

    /** Offline or a server error while lowering: the screen goes back rather than the app falling over. */
    @Test
    fun detailGoesBackWhenAnOlderFetchFails() = runBlocking {
        val source = Source(listOf(listOf(userRecord(10, "recent")))) { true }
        var backs = 0
        var tries = 0
        val found = lowerUntilFound(
            feed(source).state("s"), "deep-call",
            loadOlder = { tries++; throw java.io.IOException("offline") },
            onBack = { backs++ },
        )
        assertFalse(found)
        assertEquals(1, backs)
        assertEquals(1, tries)
    }

    @Test
    fun detailFindsAVisibleToolWithoutLowering() = runBlocking {
        val source = Source(listOf(toolRecords(2, "here") + userRecord(5, "x"))) { true }
        var backs = 0
        assertTrue(lowerUntilFound(feed(source).state("s"), "here", { source.loadOlder("s") }, { backs++ }))
        assertEquals(0, source.lowered)
        assertEquals(0, backs)
    }
}
