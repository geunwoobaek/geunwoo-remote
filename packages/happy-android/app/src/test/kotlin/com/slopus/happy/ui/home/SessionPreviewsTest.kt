package com.slopus.happy.ui.home

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.data.HappyDatabase
import com.slopus.happy.data.HappyStore
import com.slopus.happy.data.MessageRecord
import com.slopus.happy.data.SessionRecord
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** Each live session's last line, read from the stored messages and read again only when new ones arrive. */
@RunWith(AndroidJUnit4::class)
class SessionPreviewsTest {
    private lateinit var database: HappyDatabase
    private lateinit var store: HappyStore
    private val reads = mutableListOf<String>()
    private lateinit var previews: SessionPreviews

    @Before fun setUp() {
        database = HappyDatabase(ApplicationProvider.getApplicationContext(), name = null)
        store = HappyStore(database)
        previews = SessionPreviews(store, onRead = { reads += it })
    }

    @After fun tearDown() = database.close()

    private fun session(id: String) =
        SessionRecord(id, 100, 1, 1, true, 5, """{"path":"/Users/tester/project","host":"box"}""", 1, null, 1, "", null)

    private fun answer(id: String, seq: Long, text: String) = MessageRecord(
        id, seq, "$id-a$seq", null,
        """{"role":"session","content":{"id":"$id-e$seq","time":$seq,"role":"agent","turn":"t","ev":{"t":"text","text":"$text"}}}""",
        seq, seq,
    )

    @Test fun onlySessionsWithNewMessagesAreReadAgain() {
        store.upsertSessions(listOf(session("a"), session("b")))
        store.insertMessages("a", listOf(answer("a", 1, "First a")))
        store.insertMessages("b", listOf(answer("b", 1, "First b")))

        assertEquals("First a", previews.previews(listOf("a", "b"))["a"]?.line)
        previews.previews(listOf("a", "b"))
        assertEquals(listOf("a", "b"), reads.sorted())

        reads.clear()
        store.insertMessages("a", listOf(answer("a", 2, "Second a")))
        val after = previews.previews(listOf("a", "b"))
        assertEquals(listOf("a"), reads)
        assertEquals("Second a", after["a"]?.line)
        assertEquals("First b", after["b"]?.line)
    }

    @Test fun aSessionWithNoStoredMessagesIsLeftOut() {
        store.upsertSessions(listOf(session("a")))
        assertEquals(emptyMap<String, Any>(), previews.previews(listOf("a", "unknown")))
        assertEquals(emptyList<String>(), reads)
    }
}
