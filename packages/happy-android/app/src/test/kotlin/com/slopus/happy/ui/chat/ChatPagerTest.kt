package com.slopus.happy.ui.chat

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.sync.AccountHarness
import com.slopus.happy.sync.RecordDecoder
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The chat's top reach, as the chat route wires it: the screen's window
 * lowers one batch from what the device already holds, before any page is
 * asked of the server.
 */
@RunWith(AndroidJUnit4::class)
class ChatPagerTest {
    private lateinit var h: AccountHarness

    @Before
    fun setUp() {
        h = AccountHarness()
    }

    @After
    fun tearDown() = h.close()

    /** Every tenth record (seq 1, 11, 21, ...) is the user's prompt, the rest the agent's text. */
    private fun chatContent(seq: Long) = Json.parseToJsonElement(
        if (seq % 10 == 1L) {
            """{"role":"user","content":{"type":"text","text":"ask $seq"}}"""
        } else {
            """{"role":"session","content":{"id":"e$seq","time":$seq,"role":"agent","turn":"t","ev":{"t":"text","text":"answer $seq"}}}"""
        },
    ).jsonObject

    /** A chat of [count] records, all of it stored on the device. */
    private fun storedChat(count: Int) = runBlocking {
        h.server.addSession("s", updatedAt = 100)
        repeat(count) { h.server.appendMessage("s", chatContent(it + 1L)) }
        h.store.upsertSessions(listOfNotNull(RecordDecoder(h.server.encryption).session(h.server.sessions.single())))
        h.account.messages.catchUp("s")
        while (h.account.messages.loadOlder("s")) Unit
    }

    private fun backwardRequests() =
        h.server.requestsTo("/v3/sessions/s/messages").count { it.method == "GET" && it.url.queryParameter("before_seq") != null }

    private suspend fun firstShown(token: String?) =
        withTimeout(10_000) { h.account.messages.messages("s", token).first { it.isNotEmpty() } }.first().seq

    @Test
    fun theChatsTopReachLowersItsWindowFromTheDevice() = runBlocking {
        storedChat(1_200)
        assertFalse(h.store.messageHistory("s")!!.hasOlder)
        assertEquals(901L, firstShown("t1"))
        val pages = backwardRequests()

        assertTrue(showOlderInChat(h.account, "s"))
        assertEquals("the device had the records", pages, backwardRequests())
        assertEquals(601L, firstShown(null))
    }

    @Test
    fun signedOutTheChatHasNothingOlderToShow() = runBlocking {
        assertFalse(showOlderInChat(null, "s"))
    }
}
