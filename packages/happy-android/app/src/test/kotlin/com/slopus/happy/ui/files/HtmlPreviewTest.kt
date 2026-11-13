package com.slopus.happy.ui.files

import android.content.Context
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
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

    @Test fun aRootInsideADotFolderStillServesItsOwnFiles() {
        // A session in a git worktree: the root itself sits under `.claude/`.
        val worktree = "/Users/me/game/.claude/worktrees/cb"
        val page = "$worktree/_proto/p-3d/index.html"
        fun from(relative: String) =
            htmlAssetPath(java.net.URI(htmlBaseUrl(page)).resolve(java.net.URI(null, null, relative, null)).toASCIIString(), worktree)
        assertEquals("$worktree/_proto/p-3d/game.js", from("game.js"))
        assertEquals("$worktree/common/kit/kit.js", from("../../common/kit/kit.js"))
        // Below the root, dot-named folders and files are still refused.
        assertNull(from("../../.git/hooks.js"))
        assertNull(from(".cache/x.js"))
        assertNull(from("../../../../../.ssh/x.css"))
    }

    @Test fun aPageMayAskWhetherAFileIsThereButNotSendToTheComputer() {
        // A hub page probes its links with HEAD before showing them as ready.
        val url = java.net.URI(htmlBaseUrl("$root/index.html")).resolve("game/index.html").toASCIIString()
        assertEquals("$root/game/index.html", htmlAssetPath(url, root, "HEAD"))
        assertEquals("$root/game/index.html", htmlAssetPath(url, root, "get"))
        assertNull(htmlAssetPath(url, root, "POST"))
        assertNull(htmlAssetPath(url, root, "PUT"))
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
        rule.onNodeWithTag(FileTags.RENDERED_TAB, useUnmergedTree = true).assertIsSelected()
        rule.onNodeWithTag(FileTags.RENDERED).assertExists()
        rule.onNodeWithTag(HtmlPreviewTags.MEMO).assertExists()
        // A fragment's first heading names it in the bar.
        rule.onNodeWithText("Hi", useUnmergedTree = true).assertExists()
    }

    private val fragment = "<svg><title>Flow</title></svg>\n<h1>Inbound steps</h1>\n<p>Scan the box.</p>\n"

    @Test fun aFragmentShowsAsTheFinishedPageThatHoldsIt() {
        val asked = ArrayList<String>()
        val finished = "<!doctype html><html><head><title>FMS inbound guide</title></head><body>$fragment</body></html>"
        rule.setHappyContent {
            FileScreen(
                FileLoad.Loaded(fragment, null), "$root/fms-guide/body.html", onBack = {},
                readAsset = { path -> asked += path; finished.toByteArray() },
                assetRoot = root,
            )
        }
        rule.waitUntil(5_000) { rule.onAllNodesWithText("FMS inbound guide", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag(FileTags.RENDERED).assertExists()
        assertEquals(listOf("$root/fms-guide/fms-guide.html"), asked.distinct())
    }

    @Test fun aFragmentEditedSinceItsFinishedPageShowsItself() {
        val stale = "<!doctype html><html><head><title>Old guide</title></head><body><h1>Inbound</h1></body></html>"
        rule.setHappyContent {
            FileScreen(FileLoad.Loaded(fragment, null), "$root/fms-guide/body.html", onBack = {}, readAsset = { stale.toByteArray() }, assetRoot = root)
        }
        rule.waitUntil(5_000) { rule.onAllNodesWithText("Inbound steps", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        rule.onAllNodesWithText("Old guide", useUnmergedTree = true).assertCountEquals(0)
        rule.onNodeWithTag(FileTags.RENDERED).assertExists()
    }

    @Test fun aFragmentWhoseFinishedPageIsMissingShowsItself() {
        rule.setHappyContent {
            FileScreen(FileLoad.Loaded(fragment, null), "$root/fms-guide/body.html", onBack = {}, readAsset = { null }, assetRoot = root)
        }
        rule.waitUntil(5_000) { rule.onAllNodesWithText("Inbound steps", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag(FileTags.RENDERED).assertExists()
        // Source is the fragment itself, a tap away.
        rule.onNodeWithTag(FileTags.FILE_TAB, useUnmergedTree = true).performClick()
        rule.onNodeWithTag(FileTags.CODE, useUnmergedTree = true).assertExists()
    }
}
