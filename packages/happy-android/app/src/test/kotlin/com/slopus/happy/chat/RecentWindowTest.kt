package com.slopus.happy.chat

import com.slopus.happy.data.MessageRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Where a chat's window starts: the newest few hundred records, cut at the start of a turn. */
class RecentWindowTest {
    private fun user(seq: Long, text: String = "ask $seq") = MessageRecord(
        "s", seq, "u$seq", null, """{"role":"user","content":{"type":"text","text":${quote(text)}}}""", seq, seq,
    )

    private fun agent(seq: Long, text: String = "answer $seq") = MessageRecord(
        "s", seq, "a$seq", null,
        """{"role":"session","content":{"id":"e-a$seq","time":$seq,"role":"agent","turn":"t","ev":{"t":"text","text":${quote(text)}}}}""",
        seq, seq,
    )

    private fun toolResultRecord(seq: Long, toolUseId: String) = MessageRecord(
        "s", seq, "r$seq", null,
        """{"role":"session","content":{"id":"e-r$seq","time":$seq,"role":"agent","turn":"t","ev":{"t":"tool-call-end","call":${quote(toolUseId)}}}}""",
        seq, seq,
    )

    /** A user line as the Mac mirror uploads it: a session envelope with the user role. */
    private fun envelope(seq: Long, text: String, subagent: String? = null) = MessageRecord(
        "s", seq, "e$seq", null,
        """{"role":"session","content":{"id":"e$seq","time":$seq,"role":"user",""" +
            (subagent?.let { """"subagent":${quote(it)},""" } ?: "") +
            """"ev":{"t":"text","text":${quote(text)}}}}""",
        seq, seq,
    )

    private fun quote(text: String) = kotlinx.serialization.json.JsonPrimitive(text).toString()

    /** Seqs 1..[count], agent text except where [at] says otherwise. */
    private fun records(count: Int, at: Map<Long, (Long) -> MessageRecord> = emptyMap()) =
        (1L..count).map { seq -> at[seq]?.invoke(seq) ?: agent(seq) }

    @Test
    fun fewerThanSpanAtBeginningReadsAll() {
        val records = records(120, mapOf(5L to { s -> user(s) }))
        assertEquals(1L, RecentWindow.floor(records, atBeginning = true))
    }

    @Test
    fun snapsBackToTheNearestTurnStart() {
        val records = records(1000, mapOf(650L to { s -> user(s) }, 720L to { s -> user(s) }))
        assertEquals(650L, RecentWindow.floor(records, atBeginning = false))
    }

    @Test
    fun searchesBackAsFarAsTheRecordsGiven() {
        val records = records(1000, mapOf(1L to { s -> user(s) }, 990L to { s -> user(s) }))
        assertEquals(1L, RecentWindow.floor(records, atBeginning = false))
    }

    @Test
    fun noTurnStartFallsToFirstSafeAgentRecord() {
        val records = records(1000, mapOf(701L to { s -> toolResultRecord(s, "call-1") }))
        assertEquals(702L, RecentWindow.floor(records, atBeginning = false))
    }

    @Test
    fun noTurnStartAtBeginningStartsAtTheFirstRecord() {
        assertEquals(1L, RecentWindow.floor(records(200), atBeginning = true))
        // Longer than a span: still the first record, since nothing is older.
        assertEquals(1L, RecentWindow.floor(records(500), atBeginning = true))
        assertEquals(201L, RecentWindow.floor(records(500), atBeginning = false))
    }

    @Test
    fun emptyRecordsHaveNoFloor() {
        assertNull(RecentWindow.floor(emptyList(), atBeginning = true))
    }

    @Test
    fun interruptMarkerIsNotATurnStart() {
        val records = records(
            1000,
            mapOf(
                600L to { s -> user(s) },
                690L to { s -> user(s, "[Request interrupted by user for tool use]") },
                695L to { s -> envelope(s, "  [Request interrupted by user]\n") },
            ),
        )
        assertEquals(600L, RecentWindow.floor(records, atBeginning = false))
        assertFalse(RecentWindow.isTurnStart(user(1, "[Request interrupted by user]")))
        assertTrue(RecentWindow.isTurnStart(user(1, "[Request interrupted by user] and then more")))
    }

    @Test
    fun subagentUserEchoIsNotATurnStart() {
        // A CUID-shaped id: the envelope schema rejects anything else, which would pass this test for the wrong reason.
        assertFalse(RecentWindow.isTurnStart(envelope(1, "do it", subagent = "task1")))
        assertTrue(RecentWindow.isTurnStart(envelope(1, "do it")))
        val wrapped = MessageRecord(
            "s", 2, "w2", null,
            """{"role":"session","content":{"type":"session","data":{"id":"w2","time":2,"role":"user","subagent":"task1","ev":{"t":"text","text":"do it"}}}}""",
            2, 2,
        )
        assertFalse(RecentWindow.isTurnStart(wrapped))
    }

    @Test
    fun phoneAndMacInputsBothCount() {
        assertTrue(RecentWindow.isTurnStart(user(1)))
        assertTrue(RecentWindow.isTurnStart(envelope(1, "from the Mac")))
        assertFalse(RecentWindow.isTurnStart(agent(1)))
        assertFalse(RecentWindow.isTurnStart(toolResultRecord(1, "call-1")))
    }
}
