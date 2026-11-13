package com.slopus.happy.attachments

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64
import java.util.Calendar
import java.util.Date

/**
 * A photo sent to a Mac background session's mirror: saved into the
 * session's `.jarvis-photos` folder and named in the message.
 */
class MirrorPhotosTest {
    private fun photo(id: String) = AttachmentPreview(id, "file:///cache/$id.jpg", 4000, 3000, "image/jpeg", 1, "$id.jpg")

    private val at: Date = Calendar.getInstance().apply { set(2026, Calendar.NOVEMBER, 13, 20, 30, 5) }.time

    @Test fun theMessageNamesEachPhotoAheadOfTheText() {
        assertEquals("Photo: /p/a.jpg\nPhoto: /p/b.jpg\n\nlook", MirrorPhotos.message(listOf("/p/a.jpg", "/p/b.jpg"), "look"))
        assertEquals("Photo: /p/a.jpg", MirrorPhotos.message(listOf("/p/a.jpg"), "  "))
        assertEquals("look", MirrorPhotos.message(emptyList(), "look"))
    }

    @Test fun aPhotoIsSavedUnderTheSessionFolderByTimeAndId() {
        assertEquals("/Users/me/work/.jarvis-photos/20261113-203005-2-ab12cd34.jpg", MirrorPhotos.pathFor("/Users/me/work/", at, 1, "ab12-cd34-ef"))
        assertEquals("/w/.jarvis-photos/20261113-203005-1-photo.jpg", MirrorPhotos.pathFor("/w", at, 0, "--"))
    }

    @Test fun aLargePhotoShrinksToTheLongEdgeAndASmallOneStays() {
        assertEquals(2048 to 1536, MirrorPhotos.fitted(4000, 3000))
        assertEquals(1152 to 2048, MirrorPhotos.fitted(1500, 2667))
        assertEquals(800 to 600, MirrorPhotos.fitted(800, 600))
    }

    @Test fun theFolderIsMadeAndKeptOutOfGit() {
        assertTrue(MirrorPhotos.PREPARE.startsWith("mkdir -p .jarvis-photos"))
        assertTrue(".gitignore" in MirrorPhotos.PREPARE)
    }

    @Test fun eachPhotoIsWrittenAsANewFileAndFailuresAreCounted() = runTest {
        val written = mutableMapOf<String, String>()
        val result = saveMirrorPhotos(
            root = "/w",
            images = listOf(photo("a"), photo("b"), photo("c")),
            now = at,
            prepare = { true },
            shrink = { if (it.id == "b") null else it.id.toByteArray() },
            write = { path, base64 -> if ("-3-" in path) error("disk full") else { written[path] = base64; true } },
        )
        assertEquals(listOf("/w/.jarvis-photos/20261113-203005-1-a.jpg"), result.paths)
        assertEquals(2, result.failed)
        assertEquals("a", String(Base64.getDecoder().decode(written.getValue(result.paths[0]))))
    }

    @Test fun nothingIsWrittenWhenTheFolderCantBeMadeOrThePathIsNotAbsolute() = runTest {
        var writes = 0
        val write: suspend (String, String) -> Boolean = { _, _ -> writes++; true }
        assertEquals(MirrorPhotoResult(emptyList(), 2), saveMirrorPhotos("/w", listOf(photo("a"), photo("b")), at, { false }, { ByteArray(1) }, write))
        assertEquals(MirrorPhotoResult(emptyList(), 1), saveMirrorPhotos("w", listOf(photo("a")), at, { true }, { ByteArray(1) }, write))
        assertEquals(0, writes)
    }
}
