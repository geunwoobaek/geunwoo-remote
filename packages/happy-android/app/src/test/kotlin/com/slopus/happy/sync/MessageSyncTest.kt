package com.slopus.happy.sync

import com.slopus.happy.testing.cancelAndAwait
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.data.HappyDatabase
import com.slopus.happy.data.HappyStore
import com.slopus.happy.net.HappyHttp
import com.slopus.happy.net.HttpStatusException
import com.slopus.happy.testing.FakeHappyServer
import com.slopus.happy.chat.RecentWindow
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * sync.history.spec.ts against the real store: a chat opens on its newest
 * page, catches up forward, and pages back on demand within a background
 * budget. Message contents are irrelevant here; what is checked is which
 * pages are requested and what the stored run becomes.
 */
@RunWith(AndroidJUnit4::class)
class MessageSyncTest {
    private lateinit var server: FakeHappyServer
    private lateinit var database: HappyDatabase
    private lateinit var store: HappyStore
    private lateinit var scope: CoroutineScope
    private lateinit var sync: MessageSync

    @Before
    fun setUp() {
        server = FakeHappyServer().start()
        database = HappyDatabase(ApplicationProvider.getApplicationContext(), name = null)
        store = HappyStore(database)
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val api = SyncApi(HappyHttp(OkHttpClient(), serverUrl = { server.url }, clientId = "android/test"), server.token)
        sync = MessageSync(api, store, RecordDecoder(server.encryption), scope, Dispatchers.IO, prefetchPauseMs = 0)
    }

    @After
    fun tearDown() {
        scope.cancelAndAwait()
        database.close()
        server.close()
    }

    /** A session with [count] messages, synced as a listing would. */
    private fun session(count: Int) = runBlocking {
        server.addSession("s", updatedAt = 100)
        repeat(count) { server.appendMessage("s", buildJsonObject { put("n", it + 1) }) }
        store.upsertSessions(listOfNotNull(RecordDecoder(server.encryption).session(server.sessions.single())))
    }

    private fun messageRequests() = server.requestsTo("/v3/sessions/s/messages").filter { it.method == "GET" }

    private fun seqs() = store.messages("s").map { it.seq }

    @Test
    fun opensOnTheNewestPageAndReachesOlderRows() = runBlocking {
        session(102)
        sync.catchUp("s")
        assertEquals((3L..102L).toList(), seqs())
        assertEquals("2147483647", messageRequests().single().url.queryParameter("before_seq"))
        assertEquals(true, store.messageHistory("s")!!.hasOlder)

        sync.catchUp("s")
        assertEquals("102", messageRequests().last().url.queryParameter("after_seq"))

        assertTrue(sync.loadOlder("s"))
        assertEquals((1L..102L).toList(), seqs())
        assertFalse(store.messageHistory("s")!!.hasOlder)
        val calls = messageRequests().size
        assertFalse(sync.loadOlder("s"))
        assertEquals(calls, messageRequests().size)
    }

    @Test
    fun keepsTheFiveAttemptBackgroundBudgetWhileExplicitDemandGoesFurther() = runBlocking {
        session(702)
        sync.catchUp("s")
        sync.prefetchOlder("s")
        assertEquals(6, messageRequests().size)
        assertEquals(true, store.messageHistory("s")!!.hasOlder)
        sync.prefetchOlder("s")
        assertEquals(6, messageRequests().size)

        assertTrue(sync.loadOlder("s"))
        assertEquals(3L, store.messageHistory("s")!!.oldestSeq)
        assertTrue(sync.loadOlder("s"))
        assertEquals(1L, store.messageHistory("s")!!.oldestSeq)
        assertFalse(store.messageHistory("s")!!.hasOlder)
    }

    @Test
    fun aFailedOlderPageClearsLoadingKeepsTheCursorAndCanBeRetried() = runBlocking {
        session(102)
        sync.catchUp("s")
        server.failPages += 503
        val error = runCatching { sync.loadOlder("s") }.exceptionOrNull()
        assertEquals(503, (error as HttpStatusException).status)
        assertEquals(emptySet<String>(), sync.loadingOlder.value)
        assertEquals(3L, store.messageHistory("s")!!.oldestSeq)
        assertTrue(sync.loadOlder("s"))
        assertEquals(102, seqs().size)
    }

    @Test
    fun reportsCursorProgressTrueOnlyWhenThePageMovedBack() = runBlocking {
        session(202)
        assertFalse("no initial fetch yet", sync.loadOlder("s"))
        sync.catchUp("s")
        assertTrue(sync.loadOlder("s"))
        assertTrue(sync.loadOlder("s"))
        assertFalse(store.messageHistory("s")!!.hasOlder)
        assertFalse(sync.loadOlder("s"))
    }

    @Test
    fun aMissingSessionKeyFailsInsteadOfSilentlyDoingNothing() = runBlocking {
        session(102)
        sync.catchUp("s")
        store.upsertSessions(listOf(store.session("s")!!.copy(wrappedDataKey = "bm90IGEga2V5")))
        val calls = messageRequests().size
        val error = runCatching { sync.loadOlder("s") }.exceptionOrNull()
        assertTrue("$error", error?.message?.contains("encryption not ready") == true)
        assertEquals(true, store.messageHistory("s")!!.hasOlder)
        assertEquals(emptySet<String>(), sync.loadingOlder.value)
        assertEquals(calls, messageRequests().size)
    }

    @Test
    fun aBackwardPageThatDoesNotMoveTheCursorEndsHistory() = runBlocking {
        session(102)
        sync.catchUp("s")
        // A misbehaving server repeats the newest page for every cursor.
        val newest = server.messages.getValue("s").filter { it.seq == 102L || it.seq == 3L }.sortedByDescending { it.seq }
        server.pageOverride = { request -> if (request.url.queryParameter("before_seq") == "3") ApiMessagePage(newest, hasMore = true) else null }
        assertFalse(sync.loadOlder("s"))
        assertFalse(store.messageHistory("s")!!.hasOlder)
        assertEquals(3L, store.messageHistory("s")!!.oldestSeq)
        val calls = messageRequests().size
        sync.loadOlder("s")
        assertEquals(calls, messageRequests().size)
    }

    @Test
    fun anEmptyBackwardPageEndsHistoryEvenIfItAdvertisesMore() = runBlocking {
        session(102)
        sync.catchUp("s")
        server.pageOverride = { ApiMessagePage(emptyList(), hasMore = true) }
        assertFalse(sync.loadOlder("s"))
        assertFalse(store.messageHistory("s")!!.hasOlder)
        assertEquals(3L, store.messageHistory("s")!!.oldestSeq)
    }

    @Test
    fun aFailedFirstPageLeavesNothingLoadedAndAnEmptySessionLoads() = runBlocking {
        session(0)
        server.failPages += 503
        assertTrue(runCatching { sync.catchUp("s") }.isFailure)
        assertFalse(store.messageHistory("s")!!.isLoaded)

        sync.catchUp("s")
        val history = store.messageHistory("s")!!
        assertTrue(history.isLoaded)
        assertFalse(history.hasOlder)
        assertEquals(emptyList<Long>(), seqs())
    }

    /** A record as the chat stores it: every tenth (seq 1, 11, 21, ...) is the user's prompt, the rest the agent's text. */
    private fun chatContent(seq: Long) = Json.parseToJsonElement(
        if (seq % 10 == 1L) {
            """{"role":"user","content":{"type":"text","text":"ask $seq"}}"""
        } else {
            """{"role":"session","content":{"id":"e$seq","time":$seq,"role":"agent","turn":"t","ev":{"t":"text","text":"answer $seq"}}}"""
        },
    ).jsonObject

    /** A session of [count] chat records on the server, synced as a listing would. */
    private fun chat(count: Int) = runBlocking {
        server.addSession("s", updatedAt = 100)
        repeat(count) { server.appendMessage("s", chatContent(it + 1L)) }
        store.upsertSessions(listOfNotNull(RecordDecoder(server.encryption).session(server.sessions.single())))
    }

    /** Stores the newest page, then pages back [pages] times (all of it by default). */
    private suspend fun storeHistory(pages: Int = Int.MAX_VALUE) {
        sync.catchUp("s")
        var left = pages
        while (left-- > 0 && sync.loadOlder("s")) Unit
    }

    private fun backwardRequests() = messageRequests().count { it.url.queryParameter("before_seq") != null }

    private suspend fun window(token: String? = null) =
        withTimeout(10_000) { sync.messages("s", token).first { it.isNotEmpty() } }

    private suspend fun eventually(check: suspend () -> Boolean) = withTimeout(10_000) {
        while (!check()) delay(20)
    }

    @Test
    fun opensOnTheNewestThreeHundredSnappedToATurn() = runBlocking {
        chat(1_200)
        storeHistory()
        assertEquals((1L..1_200L).toList(), seqs())
        val shown = window("t1")
        // The 300th from the newest is seq 901, itself a prompt.
        assertEquals(901L, shown.first().seq)
        assertTrue(RecentWindow.isTurnStart(shown.first()))
        assertTrue("${shown.size}", shown.size in 300..309)
        assertEquals(1_200L, shown.last().seq)
    }

    @Test
    fun showOlderUsesTheDeviceBeforeTheServer() = runBlocking {
        chat(1_500)
        sync.catchUp("s")
        sync.prefetchOlder("s") // Spends the background budget, so opening the chat fetches no older page.
        while (store.messageHistory("s")!!.oldestSeq > 301) sync.loadOlder("s")
        assertTrue(store.messageHistory("s")!!.hasOlder)
        assertEquals(1_201L, window("t1").first().seq)

        val pages = backwardRequests()
        assertTrue(sync.showOlder("s"))
        assertEquals(pages, backwardRequests())
        assertEquals(901L, window().first().seq)
        assertTrue(sync.showOlder("s"))
        assertTrue(sync.showOlder("s"))
        assertEquals(301L, window().first().seq)
        assertEquals("nothing older on the device yet", pages, backwardRequests())

        // The floor is at the device's oldest record and the server has more: now a page is fetched.
        assertTrue(sync.showOlder("s"))
        assertTrue(backwardRequests() > pages)
        assertEquals(201L, window().first().seq)
    }

    @Test
    fun oneTopReachIsOneBatch() = runBlocking {
        chat(1_200)
        storeHistory()
        val firsts = mutableListOf<Long>()
        val chat = scope.launch { sync.messages("s", "t1").collect { list -> list.firstOrNull()?.let { synchronized(firsts) { firsts += it.seq } } } }
        eventually { synchronized(firsts) { firsts.isNotEmpty() } }
        assertTrue(sync.showOlder("s"))
        eventually { synchronized(firsts) { firsts.last() == 601L } }
        delay(300)
        assertEquals(listOf(901L, 601L), synchronized(firsts) { firsts.distinct() })
        chat.cancel()
    }

    @Test
    fun nothingShownDisappearsWhileTheWindowSettles() = runBlocking {
        chat(700)
        val decoder = RecordDecoder(server.encryption)
        val cipher = decoder.cipher(store.session("s")!!.wrappedDataKey)!!
        fun decoded(seq: Long) = decoder.message("s", server.messages.getValue("s").single { it.seq == seq }, cipher)
        // A live message lands before the chat has loaded anything.
        store.insertMessages("s", listOf(decoded(700)))

        val emissions = mutableListOf<Set<Long>>()
        val chat = scope.launch { sync.messages("s", "t1").collect { list -> synchronized(emissions) { emissions += list.mapTo(HashSet()) { it.seq } } } }
        sync.catchUp("s")
        sync.prefetchOlder("s")
        eventually { store.messageHistory("s")!!.oldestSeq == 200L && sync.loadingOlder.value.isEmpty() }
        repeat(10) {
            val message = server.appendMessage("s", chatContent(701L + it))
            store.insertLiveMessage("s", decoder.message("s", message, cipher))
        }
        eventually { synchronized(emissions) { emissions.lastOrNull()?.contains(710L) == true } }
        chat.cancel()

        val seen = synchronized(emissions) { emissions.toList() }
        assertTrue("${seen.size} emissions", seen.size >= 2)
        seen.zipWithNext().forEach { (before, after) ->
            assertTrue("lost ${before - after}", after.containsAll(before))
        }
        // The window settled (about 300 records, cut at a prompt) without dropping anything already shown.
        assertTrue("${seen.last().size}", seen.last().size >= RecentWindow.SPAN)
        assertTrue(seen.last().containsAll(seen.first()))
        assertTrue(seen.last().containsAll((700L..710L).toList()))
    }

    @Test
    fun newTokenStartsAFreshWindowAndNullJoins() = runBlocking {
        chat(1_200)
        storeHistory()
        assertEquals(901L, window("t1").first().seq)
        assertTrue(sync.showOlder("s"))
        assertEquals(601L, window("t1").first().seq)
        assertEquals(601L, window(null).first().seq)
        assertEquals(901L, window("t2").first().seq)
        assertEquals(901L, window(null).first().seq)
    }

    @Test
    fun pagingSaysMoreWhileTheFloorIsAboveTheDevice() = runBlocking {
        chat(1_200)
        storeHistory()
        assertFalse(store.messageHistory("s")!!.hasOlder)
        window("t1")
        assertTrue(withTimeout(5_000) { sync.paging("s").first() }.hasMoreOlder)
        var batches = 0
        while (sync.showOlder("s")) batches++
        assertEquals(3, batches)
        assertEquals(1L, window().first().seq)
        assertFalse(withTimeout(5_000) { sync.paging("s").first() }.hasMoreOlder)
    }

    @Test
    fun collectingMessagesOpensTheChatAndFillsInHistory() = runBlocking {
        session(250)
        val sizes = mutableListOf<Int>()
        withTimeout(10_000) {
            sync.messages("s").first { sizes += it.size; it.size == 250 }
        }
        // Observers may skip a page that landed while they were busy, never see a partial one.
        assertTrue("$sizes", sizes.all { it in setOf(0, 100, 200, 250) } && sizes == sizes.sorted())
        // The last page is stored a moment before its load clears the loading flag: wait for that, not the first value.
        val settled = MessagePaging(isLoaded = true, hasMoreOlder = false, isLoadingOlder = false)
        assertEquals(settled, withTimeout(5_000) { sync.paging("s").first { it == settled } })
    }
}
