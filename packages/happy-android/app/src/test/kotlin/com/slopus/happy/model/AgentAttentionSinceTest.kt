package com.slopus.happy.model

import com.slopus.happy.chat.AgentState
import com.slopus.happy.model.HomeModelFixtures.session
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** When a session started waiting on the user: the home list's Needs input clock. */
class AgentAttentionSinceTest {
    private fun state(json: String) = requireNotNull(AgentState.parse(json))

    @Test fun earliestOpenRequestOrQuestionIsTheWaitStart() {
        val waiting = state(
            """
            {"requests":{
               "r1":{"tool":"Bash","arguments":{},"createdAt":200},
               "r2":{"tool":"Edit","arguments":{},"createdAt":100}},
             "communications":{
               "c1":{"kind":"approval","createdAt":150,"title":"Pick one"}}}
            """,
        )
        assertEquals(100L, AgentAttention.of(waiting).waitingSince)
        val asking = state("""{"communications":{"c1":{"kind":"approval","createdAt":150,"title":"Pick one"}}}""")
        assertEquals(150L, AgentAttention.of(asking).waitingSince)

        val undated = state("""{"requests":{"r1":{"tool":"Bash","arguments":{}}}}""")
        assertNull(AgentAttention.of(undated).waitingSince)
        assertNull(AgentAttention.None.waitingSince)
    }

    @Test fun blockedRowCarriesItsWaitStart() {
        val blocked = session("a", attention = AgentAttention(1, 0, waitingSince = 100))
        val thinking = session("b", thinking = true, attention = AgentAttention(0, 0, waitingSince = 100))
        val inputs = SessionListInputs(listOf(blocked, thinking), emptyMap())
        assertEquals(100L, buildSessionRowData(blocked, inputs).stateSince)
        assertNull(buildSessionRowData(thinking, inputs).stateSince)
    }
}
