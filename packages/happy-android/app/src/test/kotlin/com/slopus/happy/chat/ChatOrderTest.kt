package com.slopus.happy.chat

import com.slopus.happy.data.MessageRecord
import com.slopus.happy.data.SessionRecord
import org.junit.Assert.assertEquals
import org.junit.Test

/** Records the server stored in one batch share a timestamp; the chat still shows them in session order. */
class ChatOrderTest {
    private val at = 1_794_356_066_226L

    private fun turn(n: Int, seq: Long): List<MessageRecord> = listOf(
        MessageRecord("s", seq, "u$seq", null, """{"role":"user","content":{"type":"text","text":"Turn $n"}}""", at, at),
        MessageRecord(
            "s", seq + 1, "a$seq", null,
            """{"role":"session","content":{"id":"e$seq","time":$at,"role":"agent","turn":"t$n","ev":{"t":"text","text":"Answer $n"}}}""",
            at, at,
        ),
    )

    private fun session() = SessionRecord("s", 0, 1, 1, true, 5, """{"path":"/Users/tester/project","host":"box"}""", 1, null, 1, "", null)

    private fun texts(snapshot: ChatSnapshot): List<String> = snapshot.rows.mapNotNull {
        when (val m = it.message) {
            is ChatMessage.UserText -> m.text
            is ChatMessage.AgentText -> m.text
            else -> null
        }
    }

    private val records = turn(1, 1) + turn(2, 3) + turn(3, 5)
    private val newestFirst = listOf("Answer 3", "Turn 3", "Answer 2", "Turn 2", "Answer 1", "Turn 1")

    @Test
    fun sameInstantRowsFollowSessionOrder() {
        val rows = ChatReduction { 0 }.apply(ChatPage(records), ChatSessionInfo.from(session()))
        assertEquals(newestFirst, texts(rows))
    }

    @Test
    fun anOlderBatchLoadedLaterSlotsBelowTheWindow() {
        val chat = ChatReduction { 0 }
        val info = ChatSessionInfo.from(session())
        chat.apply(ChatPage(records.takeLast(4), hasMoreOlder = true), info)
        assertEquals(newestFirst, texts(chat.apply(ChatPage(records), info)))
    }

    @Test
    fun theReducerSnapshotUsesTheSameOrder() {
        val state = ReducerState { 0 }
        state.reduce(records.mapNotNull(ChatNormalizer::normalize))
        val shown = state.snapshot().mapNotNull { (it as? ChatMessage.UserText)?.text ?: (it as? ChatMessage.AgentText)?.text }
        assertEquals(newestFirst, shown)
    }
}
