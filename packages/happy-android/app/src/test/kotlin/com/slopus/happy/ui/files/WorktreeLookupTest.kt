package com.slopus.happy.ui.files

import com.slopus.happy.sync.DirectoryEntry
import com.slopus.happy.sync.ListDirectoryResult
import com.slopus.happy.ui.files.WorktreeLookup.Copy
import com.slopus.happy.ui.files.WorktreeLookup.Located
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A file the chat names in the session's folder that the agent wrote in one
 * of its worktrees: found there, the newest first, and left alone whenever
 * it is where it says or there's nowhere else to look.
 */
class WorktreeLookupTest {
    private val root = "/Users/me/games"
    private val page = "$root/compare/tie-break/index.html"

    /** A computer whose disk holds [files] (absolute paths, with modified times). */
    private fun disk(vararg files: Pair<String, Double>): suspend (String) -> ListDirectoryResult = { dir ->
        val prefix = "$dir/"
        val entries = LinkedHashMap<String, DirectoryEntry>()
        for ((file, modified) in files) {
            if (!file.startsWith(prefix)) continue
            val rest = file.removePrefix(prefix)
            val name = rest.substringBefore('/')
            entries[name] = if ('/' in rest) DirectoryEntry(name, "directory") else DirectoryEntry(name, "file", modified = modified)
        }
        if (entries.isEmpty()) ListDirectoryResult(false, error = "ENOENT") else ListDirectoryResult(true, entries.values.toList())
    }

    @Test fun aFileInTheSessionsFolderOpensAsItIs() = runBlocking {
        val list = disk(page to 1.0, "$root/.claude/worktrees/a/compare/tie-break/index.html" to 2.0)
        assertEquals(Located.Here(page), WorktreeLookup.locate(root, page, list))
    }

    @Test fun aMissingFileIsFoundInTheWorktreeThatHasIt() = runBlocking {
        val copy = "$root/.claude/worktrees/trapmark/compare/tie-break/index.html"
        val list = disk(copy to 5.0, "$root/.claude/worktrees/other/README.md" to 1.0)
        assertEquals(Located.InWorktrees(listOf(Copy("trapmark", copy, 5.0))), WorktreeLookup.locate(root, page, list))
    }

    @Test fun severalWorktreesListTheNewestFirst() = runBlocking {
        val old = "$root/.claude/worktrees/oldboss/compare/tie-break/index.html"
        val new = "$root/.claude/worktrees/trapmark/compare/tie-break/index.html"
        val list = disk(old to 1.0, new to 9.0)
        assertEquals(
            Located.InWorktrees(listOf(Copy("trapmark", new, 9.0), Copy("oldboss", old, 1.0))),
            WorktreeLookup.locate(root, page, list),
        )
    }

    @Test fun nowhereElseLeavesThePathAlone() = runBlocking {
        val list = disk("$root/.claude/worktrees/a/README.md" to 1.0)
        assertEquals(Located.Here(page), WorktreeLookup.locate(root, page, list))
    }

    @Test fun aPathOutsideTheFolderOrAlreadyInAWorktreeIsNotLookedFor() = runBlocking {
        var asked = 0
        val list: suspend (String) -> ListDirectoryResult = { asked++; ListDirectoryResult(false) }
        assertEquals(Located.Here("/etc/hosts"), WorktreeLookup.locate(root, "/etc/hosts", list))
        val inside = "$root/.claude/worktrees/a/x.html"
        assertEquals(Located.Here(inside), WorktreeLookup.locate(root, inside, list))
        assertEquals(Located.Here(page), WorktreeLookup.locate(null, page, list))
        assertEquals(0, asked)
    }

    @Test fun aFileInTheAgentsFolderIsTakenBeforeTheSessionsFolderOrTheWorktrees() = runBlocking {
        val agent = "$root/.claude/worktrees/trapmark"
        val copy = "$agent/compare/tie-break/index.html"
        val list = disk(page to 1.0, copy to 2.0, "$root/.claude/worktrees/other/compare/tie-break/index.html" to 3.0)
        assertEquals(Located.Here(copy), WorktreeLookup.locate(root, page, list, agentCopy = copy, cwd = agent))
    }

    @Test fun anAgentsFolderWithoutTheFileFallsBackToTheSessionsFolderAndItsWorktrees() = runBlocking {
        val agent = "$root/.claude/worktrees/empty"
        val copy = "$root/.claude/worktrees/trapmark/compare/tie-break/index.html"
        assertEquals(Located.Here(page), WorktreeLookup.locate(root, page, disk(page to 1.0), agentCopy = "$agent/compare/tie-break/index.html", cwd = agent))
        assertEquals(
            Located.InWorktrees(listOf(Copy("trapmark", copy, 5.0))),
            WorktreeLookup.locate(root, page, disk(copy to 5.0), agentCopy = "$agent/compare/tie-break/index.html", cwd = agent),
        )
    }

    @Test fun ofSeveralWorktreeCopiesTheOneInTheAgentsFolderOpensWithoutAChoice() = runBlocking {
        val old = "$root/.claude/worktrees/oldboss/compare/tie-break/index.html"
        val new = "$root/.claude/worktrees/trapmark/compare/tie-break/index.html"
        val list = disk(old to 1.0, new to 9.0)
        assertEquals(
            Located.InWorktrees(listOf(Copy("oldboss", old, 1.0))),
            WorktreeLookup.locate(root, page, list, cwd = "$root/.claude/worktrees/oldboss"),
        )
        // An agent in none of them still gets the choice.
        assertEquals(2, (WorktreeLookup.locate(root, page, list, cwd = "$root/sub") as Located.InWorktrees).copies.size)
    }

    @Test fun aComputerThatCantListLeavesThePathAlone() = runBlocking {
        val list: suspend (String) -> ListDirectoryResult = { throw java.io.IOException("offline") }
        assertEquals(Located.Here(page), WorktreeLookup.locate(root, page, list))
    }
}
