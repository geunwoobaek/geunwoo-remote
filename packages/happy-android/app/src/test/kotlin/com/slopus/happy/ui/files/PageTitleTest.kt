package com.slopus.happy.ui.files

import com.slopus.happy.sync.BashResult
import com.slopus.happy.sync.GitFile
import com.slopus.happy.sync.GitFileContent
import com.slopus.happy.sync.GitState
import com.slopus.happy.sync.ReadFileChunkResult
import com.slopus.happy.sync.ReadFileResult
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.Base64

/**
 * A page card's title: the page's `<title>`, decoded and tidied, read from
 * one small slice at the start of the file, or nothing when there is none.
 */
class PageTitleTest {
    @Test fun theTitleIsReadFromTheHead() {
        assertEquals("Tie-break compare", PageTitle.of("<!doctype html><html><head><meta charset=utf-8><title>Tie-break compare</title></head>"))
    }

    @Test fun entitiesAreDecodedAndSpacesCollapsed() {
        assertEquals("A & B — “café” ★", PageTitle.of("<TITLE lang=en>\n  A &amp; B &mdash; &#8220;caf&#xE9;&#8221; &#9733;\n</TITLE>"))
    }

    @Test fun anUnknownEntityIsLeftAsItIs() {
        assertEquals("x &bogus; y", PageTitle.of("<title>x &bogus; y</title>"))
    }

    @Test fun noTitleOrAnEmptyOneIsNone() {
        assertNull(PageTitle.of("<html><body><h1>Hi</h1></body></html>"))
        assertNull(PageTitle.of("<title>   </title>"))
        assertNull(PageTitle.of("<title>never closed"))
    }

    @Test fun aPicturesOwnTitleNeverNamesThePage() {
        assertNull(PageTitle.of("<html><body><svg><title>Inbound flow</title><rect/></svg></body></html>"))
        assertEquals("Guide", PageTitle.of("<html><head><title>Guide</title></head><body><svg><title>Chart</title></svg>"))
    }

    @Test fun aFragmentIsNamedByItsFirstHeading() {
        assertEquals("FMS inbound guide", PageTitle.of("<svg viewBox=\"0 0 1 1\"><title>Flow</title></svg>\n<h1 class=t>FMS <em>inbound</em>\nguide</h1><h1>Second</h1>"))
        // A whole page without a title is still nameless: its heading is the page's text, not its name.
        assertNull(PageTitle.of("<html><body><h1>Hi</h1></body></html>"))
    }

    /** A computer holding one page, with or without slices. */
    private class Computer(val page: String, val chunked: Boolean) : SessionFileOps {
        var asked: Pair<Long, Int>? = null
        override suspend fun bash(sessionId: String, command: String, cwd: String?, timeoutMs: Long) = BashResult(false)
        override suspend fun readFile(sessionId: String, path: String) = ReadFileResult(true, Base64.getEncoder().encodeToString(page.toByteArray()))
        override suspend fun gitState(sessionId: String): GitState = throw UnsupportedOperationException()
        override suspend fun readGitFile(sessionId: String, base: String, file: GitFile): GitFileContent = throw UnsupportedOperationException()
        override suspend fun readFileChunk(sessionId: String, path: String, offset: Long, length: Int): ReadFileChunkResult {
            if (!chunked) return ReadFileChunkResult(false, error = SessionMedia.METHOD_NOT_FOUND)
            asked = offset to length
            val bytes = page.toByteArray()
            val slice = bytes.copyOfRange(0, minOf(bytes.size, length))
            return ReadFileChunkResult(true, Base64.getEncoder().encodeToString(slice), bytes.size.toLong())
        }
    }

    @Test fun onlyTheStartOfTheFileIsAskedFor() = runTest {
        val computer = Computer("<title>Big page</title>" + "x".repeat(100_000), chunked = true)
        assertEquals("Big page", computer.readPageTitle("s", "/p/index.html"))
        assertEquals(0L to PageTitle.HEAD_BYTES, computer.asked)
    }

    @Test fun anOlderCliSendsTheWholeFileOnce() = runTest {
        assertEquals("Old", Computer("<title>Old</title>", chunked = false).readPageTitle("s", "/p/index.html"))
    }
}
