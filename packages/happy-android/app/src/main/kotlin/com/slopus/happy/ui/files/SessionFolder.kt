package com.slopus.happy.ui.files

import com.slopus.happy.agent.WorkspaceFiles
import com.slopus.happy.sync.ListDirectoryResult

/**
 * A Happy session's folder as the workspace browser lists it: the
 * computer's `listDirectory` answer (one call, no paging) turned into the
 * browser's rows, each with its absolute path so a folder opens the next
 * level and a file opens in the session's viewer. The computer keeps the
 * listing inside the session's working folder.
 */
object SessionFolder {
    class ListingFailed(message: String?) : Exception(message)

    /** [result] for the folder at [dir], or [ListingFailed] with the computer's reason. */
    fun page(dir: String, result: ListDirectoryResult): WorkspaceFiles.Page {
        if (!result.success) throw ListingFailed(result.error)
        val base = dir.trimEnd('/')
        val entries = result.entries.orEmpty().map { entry ->
            WorkspaceFiles.Entry(
                name = entry.name,
                path = "$base/${entry.name}",
                directory = entry.type == "directory",
                size = entry.size?.toLong() ?: 0L,
            )
        }
        return WorkspaceFiles.Page(entries, nextCursor = null)
    }

    /** The folder's name for the bar: its last segment, or the whole path at the root of the disk. */
    fun title(dir: String): String = dir.trimEnd('/').substringAfterLast('/').ifEmpty { dir }
}
