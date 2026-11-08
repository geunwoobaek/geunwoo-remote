package com.slopus.happy.ui.home

import com.slopus.happy.data.MessageRecord
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import com.slopus.happy.model.HomeModelFixtures.metadata
import com.slopus.happy.model.HomeModelFixtures.session
import com.slopus.happy.model.runningModel
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Home's session search: a session's own words first, then the messages kept on this phone. */
class SessionSearchTest {
    private fun summarized(id: String, text: String, activeAt: Long, path: String = "/repo", machineId: String? = null, model: String? = null) = session(
        id,
        metadata = metadata(path = path) {
            putJsonObject("summary") {
                put("text", text)
                put("updatedAt", 1L)
            }
            machineId?.let { put("machineId", it) }
            model?.let { put("runningModel", it) }
        },
        activeAt = activeAt,
    )

    private fun record(sessionId: String, json: String, createdAt: Long = 0) =
        MessageRecord(sessionId, seq = createdAt, id = "m$createdAt", localId = null, contentJson = json, createdAt = createdAt, updatedAt = createdAt)

    @Test
    fun ownWordsComeFirstByRecencyThenMessageOnlyMatches() {
        val old = summarized("old", "Fix login bug", activeAt = 10)
        val new = summarized("new", "LOGIN screen polish", activeAt = 20)
        val other = summarized("other", "Refactor billing", activeAt = 30)
        val hits = sessionHits(listOf(old, new, other), emptyList(), " login ", mapOf("other" to "…the login flow…", "old" to "login here"))

        assertEquals(listOf("new", "old", "other"), hits.map { it.sessionId })
        assertEquals("login here", hits[1].snippet)
        assertNull(hits[0].snippet)
        assertEquals("Refactor billing", hits[2].title)
    }

    @Test
    fun matchesFolderMachineAndModelButNothingForBlank() {
        val s = summarized("s", "Untitled", activeAt = 1, path = "/Users/dev/happy-fork", machineId = "m1", model = "claude-opus-5-5")
        val machines = listOf(machine("m1", machineMetadata(host = "studio.local")))

        assertEquals(listOf("s"), sessionHits(listOf(s), machines, "happy-fork", emptyMap()).map { it.sessionId })
        assertEquals(listOf("s"), sessionHits(listOf(s), machines, "STUDIO", emptyMap()).map { it.sessionId })
        assertEquals(listOf("s"), sessionHits(listOf(s), machines, "opus-5-5", emptyMap()).map { it.sessionId })
        assertTrue(sessionHits(listOf(s), machines, "   ", emptyMap()).isEmpty())
        assertTrue(sessionHits(listOf(s), machines, "nowhere", emptyMap()).isEmpty())
        assertTrue(hitPlace(sessionHits(listOf(s), machines, "studio", emptyMap())).contains("studio.local"))
    }

    private fun hitPlace(hits: List<SessionSearchHit>) = hits.single().place.orEmpty()

    @Test
    fun snippetsSkipBookkeepingKeysAndTrimAroundTheMatch() {
        val long = "a".repeat(60) + " the Deploy   script failed " + "b".repeat(60)
        val snippets = messageSnippets(
            listOf(
                record("s1", """{"role":"user","content":{"type":"text","text":"$long"}}""", createdAt = 2),
                record("s1", """{"role":"user","content":{"type":"text","text":"deploy older"}}""", createdAt = 1),
                record("s2", """{"type":"deploy","id":"deploy-1","content":"nothing"}"""),
                record("s3", "not json"),
            ),
            "deploy",
        )

        assertEquals(setOf("s1"), snippets.keys)
        val snippet = snippets.getValue("s1")
        assertTrue(snippet, snippet.startsWith("…") && snippet.endsWith("…"))
        assertTrue(snippet, snippet.contains("the Deploy script failed"))
    }

    @Test
    fun shortTextIsKeptWholeWithoutEllipses() {
        val snippets = messageSnippets(listOf(record("s", """{"content":[{"text":"Run the tests"}]}""")), "tests")
        assertEquals("Run the tests", snippets["s"])
    }

    @Test
    fun runningModelIgnoresBlankAndMissing() {
        assertEquals("claude-opus-5-5", metadata { put("runningModel", "claude-opus-5-5") }.runningModel())
        assertNull(metadata { put("runningModel", " ") }.runningModel())
        assertNull(metadata().runningModel())
        assertNull((null as com.slopus.happy.model.SessionMetadata?).runningModel())
    }
}
