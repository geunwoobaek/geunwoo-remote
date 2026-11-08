package com.slopus.happy.ui.files

import com.slopus.happy.sync.DirectoryEntry
import com.slopus.happy.sync.ListDirectoryResult
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

/**
 * Where a file the chat names really is. The app reads a relative path
 * against the folder the session started in, but the agent may have moved
 * into one of that folder's worktrees (`.claude/worktrees/<name>`) and
 * written the file there. When the path isn't in the session's folder, the
 * same relative path is looked for in each worktree.
 */
object WorktreeLookup {
    const val WORKTREES = ".claude/worktrees"

    /** A worktree that holds the file: its [worktree] name, the file's absolute [path], and when it was [modified]. */
    data class Copy(val worktree: String, val path: String, val modified: Double?)

    sealed interface Located {
        /** Open [path] as it is: it is there, or there's nowhere else to look. */
        data class Here(val path: String) : Located

        /** Not in the session's folder, but in these worktrees, most recently changed first. */
        data class InWorktrees(val copies: List<Copy>) : Located
    }

    /**
     * [path] (absolute) for the session rooted at [root], looking in its
     * worktrees when it's missing. [list] is the computer's `listDirectory`;
     * a listing that fails counts as nothing there.
     *
     * [agentCopy] is the same name read against the folder the agent works in
     * now ([AgentFolder.candidates]): when it is there it is the one. [cwd] is
     * that folder: of several worktree copies, the one in it opens without a
     * choice.
     */
    suspend fun locate(
        root: String?,
        path: String,
        list: suspend (String) -> ListDirectoryResult,
        agentCopy: String? = null,
        cwd: String? = null,
    ): Located {
        if (agentCopy != null && agentCopy != path && entry(agentCopy, list) != null) return Located.Here(agentCopy)
        root ?: return Located.Here(path)
        val base = SessionFilePaths.normalize(root).trimEnd('/')
        val file = SessionFilePaths.normalize(path)
        if (!file.startsWith("$base/")) return Located.Here(path)
        val relative = file.substring(base.length + 1)
        if (relative == WORKTREES || relative.startsWith("$WORKTREES/")) return Located.Here(path)
        if (entry(file, list) != null) return Located.Here(path)
        val worktrees = listing("$base/$WORKTREES", list)?.filter { it.type == "directory" }?.map { it.name }.orEmpty()
        val gate = Semaphore(6)
        val copies = coroutineScope {
            worktrees.map { name ->
                async {
                    gate.withPermit {
                        val candidate = "$base/$WORKTREES/$name/$relative"
                        entry(candidate, list)?.let { Copy(name, candidate, it.modified) }
                    }
                }
            }.awaitAll()
        }.filterNotNull().sortedByDescending { it.modified ?: 0.0 }
        if (copies.isEmpty()) return Located.Here(path)
        val agents = AgentFolder.preferred(copies, root, cwd)
        return Located.InWorktrees(if (agents != null) listOf(agents) else copies)
    }

    private suspend fun entry(file: String, list: suspend (String) -> ListDirectoryResult): DirectoryEntry? {
        val name = file.substringAfterLast('/')
        return listing(file.substringBeforeLast('/'), list)?.firstOrNull { it.name == name && it.type != "directory" }
    }

    private suspend fun listing(dir: String, list: suspend (String) -> ListDirectoryResult): List<DirectoryEntry>? =
        try {
            list(dir).takeIf { it.success }?.entries.orEmpty()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
}
