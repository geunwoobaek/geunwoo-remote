package com.slopus.happy.ui.files

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Paths an agent writes through a shell variable (`$CLAUDE_JOB_DIR/tmp/x.html`):
 * found whole, never cut at the `$` into a made-up path under the session;
 * opened at the folder the variable stands for when the app knows it, and
 * left out when it doesn't, or when the computer says the file can't be had.
 */
class SessionMediaVariablesTest {
    @Test fun aVariablePathIsFoundWholeNotCutAtTheDollar() {
        val text = """cp out.html "${'$'}CLAUDE_JOB_DIR/tmp/dolgae.html" && open ${'$'}{CLAUDE_JOB_DIR}/tmp/shot.png"""
        assertEquals(listOf("out.html", "\$CLAUDE_JOB_DIR/tmp/dolgae.html", "\$CLAUDE_JOB_DIR/tmp/shot.png"), SessionMedia.pathsIn(text))
        assertFalse(SessionMedia.pathsIn(text).any { it.startsWith("/tmp/") || it == "tmp/dolgae.html" })
    }

    @Test fun aTemplateIsNoPath() {
        assertEquals(emptyList<String>(), SessionMedia.pathsIn("frames go to \$OUT/frame-%03d.png and {name}.png"))
    }

    @Test fun theJobFolderIsTheClaudeSessionsFirstEightCharacters() {
        val vars = SessionMedia.variables("/Users/me/", "abcd1234-0000-4000-8000-000000000001")
        assertEquals("/Users/me", vars["HOME"])
        assertEquals("/Users/me/.claude/jobs/abcd1234", vars["CLAUDE_JOB_DIR"])
        assertEquals(emptyMap<String, String>(), SessionMedia.variables(null, "abcd1234"))
        assertNull(SessionMedia.variables("/Users/me", "abc")["CLAUDE_JOB_DIR"])
    }

    @Test fun aKnownVariableExpandsAndAnUnknownOneIsDropped() {
        val vars = mapOf("CLAUDE_JOB_DIR" to "/Users/me/.claude/jobs/abcd1234/")
        assertEquals("/Users/me/.claude/jobs/abcd1234/tmp/x.html", SessionMedia.expand("\$CLAUDE_JOB_DIR/tmp/x.html", vars))
        assertNull(SessionMedia.expand("\$UNKNOWN_DIR/x.png", vars))
        assertEquals("mini/a/index.html", SessionMedia.expand("mini/a/index.html", vars))
    }

    @Test fun missingRefusedAndFolderErrorsMeanItCantBeOpened() {
        assertTrue(SessionMedia.cannotOpen("ENOENT: no such file or directory, open '/w/tmp/x.html'"))
        assertTrue(SessionMedia.cannotOpen("Access denied: Path '/Users/me/.claude/jobs/x/a.html' is outside the working directory"))
        assertTrue(SessionMedia.cannotOpen("EISDIR: illegal operation on a directory"))
        assertFalse(SessionMedia.cannotOpen("Session not found"))
        assertFalse(SessionMedia.cannotOpen("timeout"))
        assertFalse(SessionMedia.cannotOpen(null))
    }
}
