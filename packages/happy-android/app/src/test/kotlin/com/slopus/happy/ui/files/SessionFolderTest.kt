package com.slopus.happy.ui.files

import com.slopus.happy.agent.WorkspaceFiles
import com.slopus.happy.sync.DirectoryEntry
import com.slopus.happy.sync.ListDirectoryResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A session folder's rows: the computer's listing with absolute paths, a
 * folder told from a file, no size read as zero, one page only, and the
 * computer's reason when it refuses.
 */
class SessionFolderTest {
    @Test fun theListingBecomesRowsWithAbsolutePaths() {
        val page = SessionFolder.page(
            "/Users/me/project",
            ListDirectoryResult(
                true,
                listOf(
                    DirectoryEntry("src", "directory", size = 96.0),
                    DirectoryEntry("chart.png", "file", size = 2048.0),
                    DirectoryEntry("socket", "other"),
                ),
            ),
        )
        assertEquals(
            listOf(
                WorkspaceFiles.Entry("src", "/Users/me/project/src", directory = true, size = 96),
                WorkspaceFiles.Entry("chart.png", "/Users/me/project/chart.png", directory = false, size = 2048),
                WorkspaceFiles.Entry("socket", "/Users/me/project/socket", directory = false, size = 0),
            ),
            page.entries,
        )
        assertNull(page.nextCursor)
    }

    @Test fun aTrailingSlashDoesNotDoubleUp() {
        val page = SessionFolder.page("/Users/me/project/", ListDirectoryResult(true, listOf(DirectoryEntry("a.txt", "file"))))
        assertEquals("/Users/me/project/a.txt", page.entries.single().path)
    }

    @Test fun anEmptyFolderHasNoRows() {
        assertTrue(SessionFolder.page("/p", ListDirectoryResult(true, null)).entries.isEmpty())
    }

    @Test fun aRefusalCarriesTheComputersReason() {
        val error = assertThrows(SessionFolder.ListingFailed::class.java) {
            SessionFolder.page("/etc", ListDirectoryResult(false, error = "Access denied: path outside working directory"))
        }
        assertEquals("Access denied: path outside working directory", error.message)
    }

    @Test fun theBarNamesTheLastSegment() {
        assertEquals("project", SessionFolder.title("/Users/me/project"))
        assertEquals("project", SessionFolder.title("/Users/me/project/"))
        assertEquals("/", SessionFolder.title("/"))
    }
}
