package com.slopus.happy.ui.files

import android.content.Context
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** An HTML file shown as a page: what it may read from the computer, and the memo it sends. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class HtmlPreviewTest {
    @get:Rule val rule = createComposeRule()
    private val resources get() = ApplicationProvider.getApplicationContext<Context>().resources
    private val root = "/Users/me/my app"

    private fun asset(relative: String, from: String = "$root/docs/report.html") =
        // As WebView asks for it: the link resolved against the base, percent-encoded.
        htmlAssetPath(java.net.URI(htmlBaseUrl(from)).resolve(java.net.URI(null, null, relative, null)).toASCIIString(), root)

    @Test fun htmlFilesAreRecognised() {
        assertTrue(isHtmlPath("/a/report.HTML"))
        assertTrue(isHtmlPath("index.htm"))
        assertFalse(isHtmlPath("/a/notes.md"))
    }

    @Test fun relativeAssetsResolveInsideTheRootEvenThroughSpacesAndParents() {
        assertEquals("https://happy-file.invalid/Users/me/my%20app/docs/", htmlBaseUrl("$root/docs/report.html"))
        assertEquals("$root/docs/style.css", asset("style.css"))
        assertEquals("$root/assets/logo.png", asset("../assets/logo.png"))
        assertEquals("$root/docs/한글 그림.svg", asset("한글 그림.svg"))
    }

    @Test fun readsOutsideTheRootOrOfDataOrDotFilesAreRefused() {
        assertNull(asset("../../secret.css"))
        assertNull(asset("data.json"))
        assertNull(asset(".env"))
        assertNull(asset("../.git/config.js"))
        assertNull(asset("../node_modules/.cache/x.js"))
        assertNull(htmlAssetPath("https://cdn.example.com$root/docs/style.css", root))
        assertNull(htmlAssetPath("http://happy-file.invalid$root/docs/style.css", root))
        assertNull(htmlAssetPath("https://happy-file.invalid/Users/me/my app2/x.css", root))
    }

    @Test fun assetTypesFollowTheName() {
        assertEquals("text/css", htmlAssetType("a/b.CSS"))
        assertEquals("font/woff2", htmlAssetType("f.woff2"))
        assertNull(htmlAssetType("Makefile"))
    }

    @Test fun memoNamesTheFileTheQuoteAndAsksForTheChange() {
        assertEquals(
            "Memo on $root/docs/report.html:\nMake the title bigger\n\nUpdate the file to address it.",
            memoMessage(resources, "$root/docs/report.html", null, "  Make the title bigger "),
        )
        assertEquals(
            "Memo on /r/a.html, about “Q3 revenue grew”:\nUse a bar chart\n\nUpdate the file to address it.",
            memoMessage(resources, "/r/a.html", "Q3   revenue\ngrew", "Use a bar chart"),
        )
        val long = memoMessage(resources, "/r/a.html", "x".repeat(400), "n")
        assertTrue(long.contains("“" + "x".repeat(300) + "…”"))
    }

    @Test fun anHtmlFileOpensOnItsRenderedPage() {
        rule.setHappyContent {
            FileScreen(FileLoad.Loaded("<h1>Hi</h1>", null), "$root/docs/report.html", onBack = {}, onMemo = { _, _ -> })
        }
        rule.onNodeWithTag(FileTags.RENDERED_TAB, useUnmergedTree = true).assertExists()
        rule.onNodeWithTag(FileTags.RENDERED).assertExists()
        rule.onNodeWithTag(HtmlPreviewTags.MEMO).assertExists()
    }
}
