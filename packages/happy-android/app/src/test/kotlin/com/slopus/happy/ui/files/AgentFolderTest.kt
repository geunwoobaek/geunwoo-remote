package com.slopus.happy.ui.files

import com.slopus.happy.model.SessionMetadata
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The folder the agent works in now: a relative path is looked for there
 * first and in the session's folder after, an absolute one is left as it
 * is, and a session whose CLI never said reads exactly as before.
 */
class AgentFolderTest {
    private val root = "/Users/me/games"
    private val worktree = "$root/.claude/worktrees/trapmark"

    @Test fun aRelativePathIsReadAgainstTheAgentsFolderFirstThenTheSessions() {
        assertEquals(listOf("$worktree/index.html", "$root/index.html"), AgentFolder.candidates("index.html", root, worktree))
        assertEquals(listOf("$worktree/out/a.png", "$root/out/a.png"), AgentFolder.candidates("./out/a.png", root, worktree))
    }

    @Test fun aLineSuffixIsDropped() {
        assertEquals(listOf("$worktree/index.html", "$root/index.html"), AgentFolder.candidates("index.html:12", root, worktree))
    }

    @Test fun anAbsolutePathIsLeftAsItIs() {
        assertEquals(listOf("$root/index.html"), AgentFolder.candidates("$root/index.html", root, worktree))
        assertEquals(listOf("/tmp/shot.png"), AgentFolder.candidates("/tmp/shot.png", root, worktree))
    }

    @Test fun withoutAnAgentFolderOnlyTheSessionsFolderIsUsed() {
        assertEquals(listOf("$root/index.html"), AgentFolder.candidates("index.html", root, null))
        assertEquals(listOf("$root/index.html"), AgentFolder.candidates("index.html", root, root))
        assertEquals(listOf("$root/index.html"), AgentFolder.candidates("index.html", root, "$root/"))
        assertEquals(listOf("$root/index.html"), AgentFolder.candidates("index.html", root, "relative/folder"))
    }

    @Test fun aRelativePathWithNoFolderAtAllHasNowhereToBe() {
        assertEquals(emptyList<String>(), AgentFolder.candidates("index.html", null, null))
        assertEquals(listOf("$worktree/index.html"), AgentFolder.candidates("index.html", null, worktree))
    }

    @Test fun ofWorktreeCopiesTheAgentsOwnIsPreferred() {
        val copies = listOf(
            WorktreeLookup.Copy("other", "$root/.claude/worktrees/other/a.html", 9.0),
            WorktreeLookup.Copy("trapmark", "$worktree/a.html", 1.0),
        )
        assertEquals(copies[1], AgentFolder.preferred(copies, root, worktree))
        assertNull(AgentFolder.preferred(copies, root, null))
        assertNull(AgentFolder.preferred(copies, root, "$root/sub"))
    }

    @Test fun metadataReadsTheAgentsFolderAndAnOldOrBrokenOneIsOnlyMissing() {
        assertEquals(worktree, SessionMetadata.parse("""{"path":"$root","host":"mac","cwd":"$worktree"}""")?.cwd)
        assertNull(SessionMetadata.parse("""{"path":"$root","host":"mac"}""")?.cwd)
        val broken = SessionMetadata.parse("""{"path":"$root","host":"mac","cwd":42}""")
        assertEquals(root, broken?.path)
        assertNull(broken?.cwd)
    }
}
