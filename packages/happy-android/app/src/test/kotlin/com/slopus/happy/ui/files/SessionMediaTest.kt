package com.slopus.happy.ui.files

import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatRow
import com.slopus.happy.chat.ToolCall
import com.slopus.happy.chat.ToolState
import com.slopus.happy.chat.chatListItems
import com.slopus.happy.chat.groupChatRowsForDisplay
import com.slopus.happy.sync.BashResult
import com.slopus.happy.sync.GitFile
import com.slopus.happy.sync.GitFileContent
import com.slopus.happy.sync.GitState
import com.slopus.happy.sync.ReadFileChunkResult
import com.slopus.happy.sync.ReadFileResult
import com.slopus.happy.ui.chat.ChatMedia
import com.slopus.happy.ui.chat.chatMediaPaths
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.util.Base64

/**
 * The pictures, recordings and pages the chat shows under a message: the
 * paths found in an agent's words and tool calls (not URLs, not listings),
 * the work folded under an answer handing its paths to the answer, and the
 * bytes read a slice at a time, or whole from a CLI without slices.
 */
class SessionMediaTest {
    @Test fun pathsInWordsAreFoundOnceInOrderAndUrlsAreLeftOut() {
        val text = "Saved `/Users/me/shots/before shot.png` and ./out/chart.webp. Also see https://example.com/a.png, " +
            "then /tmp/demo.mp4 and report.html; ~/Desktop/스크린샷.jpg too. Not notes.txt. Again ./out/chart.webp"
        assertEquals(
            listOf("/Users/me/shots/before shot.png", "./out/chart.webp", "/tmp/demo.mp4", "report.html", "~/Desktop/스크린샷.jpg"),
            SessionMedia.pathsIn(text),
        )
        assertEquals(emptyList<String>(), SessionMedia.pathsIn("nothing here, and file.pngx isn't one"))
    }

    @Test fun nameTemplatesInCodeAreNotFiles() {
        // A script names the files it will make by pattern; those aren't files to show.
        val code = "for s in a b; do shot \"/tmp/x/\$s.png\"; done; open('/tmp/x/%s.png' % s); " +
            "Path(f\"/tmp/x/{s}.png\"); ls /tmp/x/*.png; cp '/tmp/x/<name>.png' . ; and /tmp/x/real.png"
        assertEquals(listOf("/tmp/x/real.png"), SessionMedia.pathsIn(code))
    }

    @Test fun kindsGoByExtension() {
        assertEquals(MediaKind.Picture, SessionMedia.kindOf("/a/B.PNG"))
        assertEquals(MediaKind.Video, SessionMedia.kindOf("x.mov"))
        assertEquals(MediaKind.Page, SessionMedia.kindOf("index.htm"))
        assertNull(SessionMedia.kindOf("style.css"))
        assertNull(SessionMedia.kindOf("png"))
    }

    private fun tool(id: String, at: Long, name: String, vararg input: Pair<String, String>) = ChatRow.Tool(
        ChatMessage.ToolCallMessage(
            id,
            at,
            ToolCall(name = name, state = ToolState.Completed, input = buildJsonObject { input.forEach { (k, v) -> put(k, JsonPrimitive(v)) } }, createdAt = at),
        ),
    )

    private fun text(id: String, at: Long, body: String) = ChatRow.AgentText(ChatMessage.AgentText(id, at, body), emptyList())

    private fun user(id: String, at: Long) = ChatRow.User(ChatMessage.UserText(id, null, at, "q"), com.slopus.happy.chat.UserDisplay.Text("q", emptyList()))

    @Test fun toolCallsNameTheirFilesButListingsDoNot() {
        assertEquals(listOf("/tmp/shot.png"), SessionMedia.pathsOf(tool("w", 1, "Write", "file_path" to "/tmp/shot.png", "content" to "x")))
        assertEquals(listOf("/tmp/rec.mov"), SessionMedia.pathsOf(tool("b", 1, "Bash", "command" to "screencapture -v /tmp/rec.mov")))
        assertEquals(emptyList<String>(), SessionMedia.pathsOf(tool("g", 1, "Glob", "pattern" to "**/a.png")))
    }

    @Test fun foldedWorkHandsItsMediaToTheAnswerAndAnOpenGroupKeepsItOnItsRows() {
        // Newest first: answer a1 after Write (picture) and Bash (recording), for prompt u1.
        val rows = listOf(
            text("a1", 30, "Done, see /tmp/page.html"),
            tool("t2", 20, "Bash", "command" to "screencapture -v /tmp/rec.mov"),
            tool("t1", 10, "Write", "file_path" to "/tmp/shot.png"),
            user("u1", 0),
        )
        val display = groupChatRowsForDisplay(rows, enabled = true, collapseCurrentTurn = true)
        val folded = chatMediaPaths(chatListItems(display) { false }).mapValues { (_, media) -> media.map { it.path } }
        assertEquals(mapOf("a1" to listOf("/tmp/page.html", "/tmp/shot.png", "/tmp/rec.mov")), folded)
        val open = chatMediaPaths(chatListItems(display) { true }).mapValues { (_, media) -> media.map { it.path } }
        assertEquals(
            mapOf("a1" to listOf("/tmp/page.html"), "t2" to listOf("/tmp/rec.mov"), "t1" to listOf("/tmp/shot.png")),
            open,
        )
    }

    @Test fun aPageAWriteOrEditMadeIsMarkedMadeAndOneOnlyNamedIsNot() {
        val made = "/Users/me/my site/index.html"
        assertEquals(listOf(made), SessionMedia.pagesMadeBy(tool("w", 1, "Write", "file_path" to made, "content" to "<p>")))
        assertEquals(listOf("/p/a.htm"), SessionMedia.pagesMadeBy(tool("e", 1, "Edit", "file_path" to "/p/a.htm")))
        assertEquals(emptyList<String>(), SessionMedia.pagesMadeBy(tool("w", 1, "Write", "file_path" to "/p/shot.png")))
        assertEquals(emptyList<String>(), SessionMedia.pagesMadeBy(tool("r", 1, "Read", "file_path" to "/p/a.html")))
        assertEquals(emptyList<String>(), SessionMedia.pagesMadeBy(text("t", 1, "see /p/a.html")))

        // Newest first: the answer names the page the folded Write made, and another it only mentions.
        val page = "/p/site/index.html"
        val rows = listOf(
            text("a1", 30, "Made $page, compare /p/old.html"),
            tool("t1", 10, "Write", "file_path" to page, "content" to "<title>x</title>"),
            user("u1", 0),
        )
        val folded = chatMediaPaths(chatListItems(groupChatRowsForDisplay(rows, enabled = true, collapseCurrentTurn = true)) { false })
        assertEquals(listOf(ChatMedia(page, made = true), ChatMedia("/p/old.html", made = false)), folded["a1"])
    }

    /** A computer whose file is [bytes], read in slices of [slice], or whole when [chunked] is false. */
    private class Computer(val bytes: ByteArray, val slice: Int, val chunked: Boolean = true) : SessionFileOps {
        val offsets = ArrayList<Long>()
        var wholeReads = 0
        override suspend fun bash(sessionId: String, command: String, cwd: String?, timeoutMs: Long) = BashResult(false)
        override suspend fun readFile(sessionId: String, path: String): ReadFileResult {
            wholeReads++
            return ReadFileResult(true, Base64.getEncoder().encodeToString(bytes))
        }
        override suspend fun gitState(sessionId: String): GitState = throw UnsupportedOperationException()
        override suspend fun readGitFile(sessionId: String, base: String, file: GitFile): GitFileContent = throw UnsupportedOperationException()
        override suspend fun readFileChunk(sessionId: String, path: String, offset: Long, length: Int): ReadFileChunkResult {
            if (!chunked) return super.readFileChunk(sessionId, path, offset, length)
            offsets += offset
            val end = minOf(bytes.size.toLong(), offset + minOf(length, slice)).toInt()
            val part = bytes.copyOfRange(offset.toInt(), end)
            return ReadFileChunkResult(true, Base64.getEncoder().encodeToString(part), bytes.size.toLong(), eof = end >= bytes.size)
        }
    }

    @Test fun slicesAreJoinedInOrderWithProgress() = runTest {
        val bytes = ByteArray(10) { it.toByte() }
        val computer = Computer(bytes, slice = 4)
        val out = ByteArrayOutputStream()
        val progress = ArrayList<Pair<Long, Long>>()
        assertEquals(MediaRead.Done, computer.readMedia("s", "/tmp/a.png", out, maxBytes = 100) { done, total -> progress += done to total })
        assertArrayEquals(bytes, out.toByteArray())
        assertEquals(listOf(0L, 4L, 8L), computer.offsets)
        assertEquals(listOf(4L to 10L, 8L to 10L, 10L to 10L), progress)
    }

    @Test fun tooLargeStopsAndAnOlderCliIsReadWhole() = runTest {
        val bytes = ByteArray(10) { (it * 3).toByte() }
        assertEquals(MediaRead.TooLarge, Computer(bytes, 4).readMedia("s", "/a.mp4", ByteArrayOutputStream(), maxBytes = 5))
        val older = Computer(bytes, 4, chunked = false)
        assertArrayEquals(bytes, older.readMediaBytes("s", "/a.png"))
        assertEquals(1, older.wholeReads)
    }

    @Test fun aTextFileComesInSlicesNotOneReply() = runTest {
        // One readFile reply over ~4.5 MB outgrows the relay's message and drops the connection.
        val text = (1..400).joinToString("") { "line $it of a long log\n" }
        val computer = Computer(text.toByteArray(), slice = 1024)
        assertEquals(FileLoad.Loaded(text, null), computer.loadFile("s", "/w/run.log", null, null))
        assertEquals(0, computer.wholeReads)
        assertEquals(true, computer.offsets.size >= 3)
        val page = Computer("<html><title>t</title></html>".toByteArray(), slice = 8)
        assertEquals(FileLoad.Loaded("<html><title>t</title></html>", null), page.loadFile("s", "/tmp/a.html", null, null))
    }

    @Test fun aTextFileOverTheCapIsTooLargeAndAnOlderCliIsReadWhole() = runTest {
        val big = object : SessionFileOps by Computer(ByteArray(0), 1) {
            override suspend fun readFileChunk(sessionId: String, path: String, offset: Long, length: Int) =
                ReadFileChunkResult(true, Base64.getEncoder().encodeToString("x".toByteArray()), SessionMedia.MAX_TEXT_BYTES + 1, eof = false)
        }
        assertEquals(FileLoad.Failed(com.slopus.happy.text.Words.ours(com.slopus.happy.R.string.session_media_too_large)), big.loadFile("s", "/w/huge.txt", null, null))
        // A page may be larger than text: its pictures and scripts are inside.
        val page = object : SessionFileOps by Computer(ByteArray(0), 1) {
            override suspend fun readFileChunk(sessionId: String, path: String, offset: Long, length: Int) =
                ReadFileChunkResult(true, Base64.getEncoder().encodeToString("<p>".toByteArray()), 3, eof = true)
        }
        assertEquals(FileLoad.Loaded("<p>", null), page.loadFile("s", "/w/big.html", null, null))
        val older = Computer("hello\n".toByteArray(), 4, chunked = false)
        assertEquals(FileLoad.Loaded("hello\n", null), older.loadFile("s", "/w/a.txt", null, null))
        assertEquals(1, older.wholeReads)
    }

    @Test fun aLongFileShowsItsStartCutAtALineEnd() {
        assertNull(shownStart("short\ntext", max = 100))
        assertEquals("aaaa\nbbbb", shownStart("aaaa\nbbbb\ncccc", max = 12))
        // No line end within reach: cut at the limit, never inside a surrogate pair.
        assertEquals("abc", shownStart("abc\uD83D\uDE00def", max = 4))
    }

    @Test fun aFileIsWrittenInPlaceOnlyWhenWhole() = runTest {
        val dir = kotlin.io.path.createTempDirectory("media").toFile()
        val target = SessionMedia.cacheFile(dir, "s", "/tmp/rec.mov")
        assertEquals(MediaRead.Done, Computer(ByteArray(9) { 1 }, 4).readMediaToFile("s", "/tmp/rec.mov", target))
        assertEquals(9L, target.length())
        val failing = object : SessionFileOps by Computer(ByteArray(0), 1) {
            override suspend fun readFileChunk(sessionId: String, path: String, offset: Long, length: Int) = ReadFileChunkResult(false, error = "nope")
        }
        val other = SessionMedia.cacheFile(dir, "s", "/tmp/other.mov")
        assertEquals(MediaRead.Failed("nope"), failing.readMediaToFile("s", "/tmp/other.mov", other))
        assertEquals(false, other.exists())
        assertEquals(listOf(target.name), dir.resolve(SessionMedia.DIRECTORY).list()!!.toList())
        dir.deleteRecursively()
    }
}
