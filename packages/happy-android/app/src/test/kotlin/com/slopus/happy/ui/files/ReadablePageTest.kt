package com.slopus.happy.ui.files

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** An HTML file made readable on a phone: fragments styled, pages given the viewport, a fragment's finished page found. */
class ReadablePageTest {
    @Test fun aFragmentHasNoDocumentTags() {
        assertTrue(ReadablePage.isFragment("<section><h1>Guide</h1><p>Body</p></section>"))
        assertFalse(ReadablePage.isFragment("<!doctype html><html><body>x</body></html>"))
        assertFalse(ReadablePage.isFragment("<HEAD><title>t</title></HEAD>"))
        // A word that starts like a tag is not one.
        assertTrue(ReadablePage.isFragment("<header>top</header><p>body text</p>"))
    }

    @Test fun aFragmentIsWrappedWithTheViewportAndTheReadingStylesheetBeforeIt() {
        val shown = ReadablePage.forPhone("<style>h1{color:red}</style><h1>Guide</h1>")
        assertTrue(shown.startsWith("<!doctype html><html><head><meta charset=\"utf-8\">${ReadablePage.VIEWPORT}<style>"))
        assertTrue("Korean breaks between words", shown.contains("word-break:keep-all"))
        assertTrue("wide tables scroll", shown.contains("table{display:block;max-width:100%;overflow-x:auto"))
        // The fragment's own styles come after, so they win.
        assertTrue(shown.indexOf("word-break:keep-all") < shown.indexOf("h1{color:red}"))
        assertTrue(shown.endsWith("<h1>Guide</h1>\n</body></html>"))
    }

    @Test fun aPageWithoutAViewportGetsOneAndIsOtherwiseUntouched() {
        assertEquals(
            "<html><head lang=en>${ReadablePage.VIEWPORT}<title>t</title></head><body>x</body></html>",
            ReadablePage.forPhone("<html><head lang=en><title>t</title></head><body>x</body></html>"),
        )
        assertEquals("<html><head>${ReadablePage.VIEWPORT}</head><body>x</body></html>", ReadablePage.forPhone("<html><body>x</body></html>"))
        assertEquals(ReadablePage.VIEWPORT + "<body>x</body>", ReadablePage.forPhone("<body>x</body>"))
        val own = "<html><head><meta name=viewport content=\"width=500\"></head><body>x</body></html>"
        assertEquals(own, ReadablePage.forPhone(own))
    }

    @Test fun aFragmentsFinishedPageIsNamedAfterItsFolder() {
        assertEquals("/w/fms-guide/fms-guide.html", ReadablePage.finishedPath("/w/fms-guide/body.html"))
        assertNull("already the finished page", ReadablePage.finishedPath("/w/fms-guide/fms-guide.html"))
        assertNull("no folder", ReadablePage.finishedPath("body.html"))
        assertNull("not a page", ReadablePage.finishedPath("/w/fms-guide/notes.md"))
    }

    @Test fun aFinishedPageCountsOnlyWhenItHoldsTheFragmentUnchanged() {
        val fragment = "\n<h1>Guide</h1>\n<p>Step one</p>\n"
        assertTrue(ReadablePage.holds("<!doctype html><html><head><title>Guide</title></head><body><h1>Guide</h1>\n<p>Step one</p></body></html>", fragment))
        assertFalse("edited since", ReadablePage.holds("<html><body><h1>Guide</h1>\n<p>Step 1</p></body></html>", fragment))
        assertFalse("not a page", ReadablePage.holds("<h1>Guide</h1>\n<p>Step one</p>", fragment))
        assertFalse("nothing to hold", ReadablePage.holds("<html><body></body></html>", "  \n"))
    }

    @Test fun aShortNameIsTheFolderAndTheFile() {
        assertEquals("fms-guide/body.html", ReadablePage.shortName("/Users/tester/project/fms-guide/body.html"))
        assertEquals("body.html", ReadablePage.shortName("body.html"))
    }

    @Test fun aMarkdownFileIsNamedByItsFirstHeading() {
        assertEquals("Release notes", markdownTitle("\n# Release notes #\n\nBody"))
        assertNull(markdownTitle("Intro line\n# Later heading"))
        assertNull(markdownTitle("## Second level"))
        assertNull(markdownTitle(""))
    }
}
