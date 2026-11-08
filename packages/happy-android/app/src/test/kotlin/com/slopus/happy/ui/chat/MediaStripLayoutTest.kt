package com.slopus.happy.ui.chat

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.sync.BashResult
import com.slopus.happy.sync.GitFile
import com.slopus.happy.sync.GitFileContent
import com.slopus.happy.sync.GitState
import com.slopus.happy.sync.ReadFileChunkResult
import com.slopus.happy.sync.ReadFileResult
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.files.MediaKind
import com.slopus.happy.ui.files.SessionFileOps
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.nio.file.Files
import java.util.Base64

/**
 * The media under a turn: a page the turn wrote is a full-width card named
 * by its `<title>` (its file name without one) that opens the page, while
 * pictures stay 112 tiles in the row under it; the same file named twice
 * shows once, read against the folder the agent works in first.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MediaStripLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private val root = "/Users/me/games"
    private val worktree = "$root/.claude/worktrees/trapmark"

    /** A computer whose pages are [pages] (absolute path to HTML); anything else can't be read. */
    private class Computer(val pages: Map<String, String>) : SessionFileOps {
        override suspend fun bash(sessionId: String, command: String, cwd: String?, timeoutMs: Long) = BashResult(false)
        override suspend fun readFile(sessionId: String, path: String) = ReadFileResult(false, error = "ENOENT")
        override suspend fun gitState(sessionId: String): GitState = throw UnsupportedOperationException()
        override suspend fun readGitFile(sessionId: String, base: String, file: GitFile): GitFileContent = throw UnsupportedOperationException()
        override suspend fun readFileChunk(sessionId: String, path: String, offset: Long, length: Int): ReadFileChunkResult {
            val page = pages[path] ?: return ReadFileChunkResult(false, error = "ENOENT")
            return ReadFileChunkResult(true, Base64.getEncoder().encodeToString(page.toByteArray()), page.length.toLong(), eof = true)
        }
    }

    private fun host(pages: Map<String, String>, cwd: String? = null, open: (String) -> Unit = {}) =
        SessionMediaHost("s", root, Computer(pages), Files.createTempDirectory("media").toFile(), cwd, open)

    // 16 in from each side and 4 below the row above, at least 68 high; the picture's 112 tile 4 + 4 under it.
    @Test
    fun aWrittenPageIsAFullWidthCardAbovePictureTiles() {
        val page = "$root/compare/index.html"
        val opened = ArrayList<String>()
        val host = host(mapOf(page to "<html><head><title>Tie-break compare</title></head>"), open = { opened += it })
        rule.setHappyContent {
            CompositionLocalProvider(LocalSessionMedia provides host) {
                MediaStrip(listOf(ChatMedia(page, made = true), ChatMedia("$root/shot.png")))
            }
        }
        rule.waitForIdle()
        val card = rule.node(MediaStripTags.card(page)).bounds
        assertDp("card left", 16, card.left)
        assertDp("card width", PHONE_WIDTH - 32, card.width)
        assertDp("card top", 4, card.top)
        assertTrue("card height ${card.height}", card.height >= 68.dp)
        rule.node(PageCardTags.TITLE).assertTextEquals("Tie-break compare")
        val tile = rule.node(MediaStripTags.tile("$root/shot.png")).bounds
        assertDp("tile size", 112, tile.width)
        assertDp("tile height", 112, tile.height)
        assertDp("tile left", 16, tile.left)
        assertDp("tile below the card", 8, tile.top - card.bottom)
        rule.node(MediaStripTags.card(page)).performClick()
        assertEquals(listOf(page), opened)
    }

    @Test
    fun aPageWithoutATitleIsNamedByItsFile() {
        val page = "$root/plain.html"
        val host = host(mapOf(page to "<p>no head</p>"))
        rule.setHappyContent {
            CompositionLocalProvider(LocalSessionMedia provides host) { MediaStrip(listOf(ChatMedia(page, made = true))) }
        }
        rule.waitForIdle()
        rule.node(PageCardTags.TITLE).assertTextEquals("plain.html")
    }

    @Test
    fun aPageOnlyNamedStaysATile() {
        val page = "$root/named.html"
        rule.setHappyContent {
            CompositionLocalProvider(LocalSessionMedia provides host(emptyMap())) { MediaStrip(listOf(ChatMedia(page))) }
        }
        rule.node(MediaStripTags.tile(page)).assertExists()
        rule.node(MediaStripTags.card(page)).assertDoesNotExist()
    }

    @Test
    fun aRelativeNameAndTheWritesAbsolutePathAreOneCardInTheAgentsFolder() {
        val written = "$worktree/index.html"
        val items = host(emptyMap(), cwd = worktree).items(listOf(ChatMedia("index.html"), ChatMedia(written, made = true), ChatMedia("shot.png")))
        assertEquals(
            listOf(MediaItem(written, written, MediaKind.Page, card = true), MediaItem("shot.png", "$worktree/shot.png", MediaKind.Picture, card = false)),
            items,
        )
        // Without the agent's folder a relative name reads against the session's, as before.
        assertEquals("$root/index.html", host(emptyMap()).absolute("index.html"))
    }

    @Test
    fun aTitleIsReadFromTheAgentsFolderAndThenTheSessionsOnce() {
        val inRoot = "$root/old.html"
        val reads = ArrayList<String>()
        val ops = object : SessionFileOps by Computer(mapOf(inRoot to "<title>Old</title>")) {
            override suspend fun readFileChunk(sessionId: String, path: String, offset: Long, length: Int): ReadFileChunkResult {
                reads += path
                return Computer(mapOf(inRoot to "<title>Old</title>")).readFileChunk(sessionId, path, offset, length)
            }
        }
        val host = SessionMediaHost("s", root, ops, Files.createTempDirectory("media").toFile(), worktree) {}
        kotlinx.coroutines.runBlocking {
            assertEquals("Old", host.title("old.html"))
            assertEquals("Old", host.title("old.html"))
        }
        assertEquals(listOf("$worktree/old.html", inRoot), reads)
    }
}
