package com.slopus.happy.ui.server

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.auth.AuthApi.ServerProbe
import com.slopus.happy.config.ServerHeader
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.connect.LocalQrScanner
import com.slopus.happy.ui.connect.QrScanner
import com.slopus.happy.ui.connect.ScanFailure
import com.slopus.happy.ui.connect.ScanResult
import com.slopus.happy.ui.connect.ServerLink
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The Server screen's request headers: saved with the URL after the probe
 * (which sends them) and the confirm, refused line by line, and filled in,
 * never saved, by a scanned server code or a server link.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ServerHeadersScreenTest {
    @get:Rule val rule = createComposeRule()

    private var scanned: ScanResult = ScanResult.Cancelled
    private val scanner = QrScanner { scanned }
    private val probed = mutableListOf<Pair<String, List<ServerHeader>>>()
    private val saved = mutableListOf<Pair<String, List<ServerHeader>>>()
    private var resets = 0

    private fun show(customUrl: String? = null, customHeaders: List<ServerHeader> = emptyList(), prefill: ServerLink? = null) {
        rule.setHappyContent {
            CompositionLocalProvider(LocalQrScanner provides scanner) {
                ServerScreen(
                    customUrl = customUrl,
                    customHeaders = customHeaders,
                    prefill = prefill,
                    probe = { url, headers -> probed += url to headers; ServerProbe.HappyServer },
                    onSave = { url, headers -> saved += url to headers },
                    onReset = { resets++ },
                    onBack = {},
                )
            }
        }
    }

    private fun saveAndConfirm() {
        rule.node(ServerTags.SAVE).performClick()
        rule.onNodeWithText("Continue with this server?").assertExists()
        rule.onNodeWithText("Continue").performClick()
        rule.waitForIdle()
    }

    private val key = ServerHeader("X-Example-Key", "abc123")

    /** What is typed in the headers field; what it shows is masked. */
    private fun headersText(): String = rule.node(ServerTags.HEADERS).fetchSemanticsNode().config[SemanticsProperties.InputText].text

    @Test
    fun headersAreProbedAndSavedWithTheUrl() {
        show()
        rule.node(ServerTags.INPUT).performTextReplacement("https://happy.example.com")
        rule.node(ServerTags.HEADERS).performTextReplacement("X-Example-Key: abc123\nCF-Access-Client-Id: id.example")
        saveAndConfirm()
        val headers = listOf(key, ServerHeader("CF-Access-Client-Id", "id.example"))
        assertEquals(listOf("https://happy.example.com" to headers), probed)
        assertEquals(listOf("https://happy.example.com" to headers), saved)
    }

    @Test
    fun aBadLineSaysWhichAndSavesNothing() {
        show()
        rule.node(ServerTags.INPUT).performTextReplacement("https://happy.example.com")
        rule.node(ServerTags.HEADERS).performTextReplacement("X-Example-Key: abc123\nno colon here")
        rule.node(ServerTags.SAVE).performClick()
        rule.node(ServerTags.HEADERS_ERROR).assertTextEquals("Line 2 isn't a header. Write it as Name: value.")
        rule.node(ServerTags.HEADERS).performTextReplacement("Authorization: Bearer x")
        rule.node(ServerTags.SAVE).performClick()
        rule.node(ServerTags.HEADERS_ERROR).assertTextEquals("Line 1: the app sets this header itself.")
        assertEquals(emptyList<Any>(), probed)
        assertEquals(emptyList<Any>(), saved)
    }

    @Test
    fun theSavedHeadersAreShownMaskedAndKeptOnSave() {
        show(customUrl = "https://happy.example.com", customHeaders = listOf(key))
        assertEquals("X-Example-Key: abc123", headersText())
        rule.node(ServerTags.HEADERS).assertTextEquals("X-Example-Key: ••••••")
        assertEquals("X-Example-Key: ••••••", MaskHeaderValues.mask("X-Example-Key: abc123"))
        assertEquals("A: •••\nB:•••\n", MaskHeaderValues.mask("A: x:y\nB:1:2\n"))
        saveAndConfirm()
        assertEquals(listOf("https://happy.example.com" to listOf(key)), saved)
    }

    @Test
    fun resetEmptiesBothFields() {
        show(customUrl = "https://happy.example.com", customHeaders = listOf(key))
        rule.node(ServerTags.RESET).performClick()
        rule.onNodeWithText("Reset").performClick()
        rule.waitForIdle()
        assertEquals(1, resets)
        rule.node(ServerTags.INPUT).assertTextEquals("")
        assertEquals("", headersText())
    }

    @Test
    fun aScannedServerCodeFillsInAndSavesNothing() {
        show(customUrl = "https://old.example.com")
        rule.assertActionsLabelled()
        scanned = ScanResult.Scanned("happy://server?url=https%3A%2F%2Fhappy.example.com%3A8443&header=X-Example-Key%3A%20abc123")
        rule.node(ServerTags.SCAN).performClick()
        rule.waitForIdle()
        rule.node(ServerTags.INPUT).assertTextEquals("https://happy.example.com:8443")
        assertEquals("X-Example-Key: abc123", headersText())
        assertEquals(emptyList<Any>(), saved)
        assertEquals(emptyList<Any>(), probed)
        saveAndConfirm()
        assertEquals(listOf("https://happy.example.com:8443" to listOf(key)), saved)
    }

    @Test
    fun anyOtherCodeIsNotOne() {
        show(customUrl = "https://old.example.com")
        for (code in listOf("happy://terminal?abc", "https://example.com", "happy://server", "happy://a0123456789abcdefghijklm/server?url=https%3A%2F%2Fteam.example.com%2F")) {
            scanned = ScanResult.Scanned(code)
            rule.node(ServerTags.SCAN).performClick()
            rule.waitForIdle()
            rule.onNodeWithText("This QR code isn't a Jarvis code.").assertExists()
            rule.onNodeWithText("OK").performClick()
            rule.waitForIdle()
            rule.node(ServerTags.INPUT).assertTextEquals("https://old.example.com")
        }
        scanned = ScanResult.Failed(ScanFailure.NoCamera)
        rule.node(ServerTags.SCAN).performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Error").assertExists()
        assertEquals(emptyList<Any>(), saved)
    }

    @Test
    fun aLinkFillsTheScreenIn() {
        show(customUrl = "https://old.example.com", customHeaders = listOf(ServerHeader("X-Old", "1")), prefill = ServerLink("https://happy.example.com", listOf("X-Example-Key: abc123")))
        rule.node(ServerTags.INPUT).assertTextEquals("https://happy.example.com")
        assertEquals("X-Example-Key: abc123", headersText())
        assertEquals("nothing saved by opening it", emptyList<Any>(), saved)
        assertNull(probed.firstOrNull())
        saveAndConfirm()
        assertEquals(listOf("https://happy.example.com" to listOf(key)), saved)
    }

    @Test
    fun aLinkWithOnlyHeadersKeepsTheUrl() {
        show(customUrl = "https://old.example.com", prefill = ServerLink(null, listOf("X-Example-Key: abc123")))
        rule.node(ServerTags.INPUT).assertTextEquals("https://old.example.com")
        assertEquals("X-Example-Key: abc123", headersText())
        assertFalse(saved.isNotEmpty())
    }

    /** A saved secret must never ride along to the server a link or code names. */
    @Test
    fun aLinkWithAUrlButNoHeadersClearsTheSavedOnes() {
        show(customUrl = "https://old.example.com", customHeaders = listOf(key), prefill = ServerLink("https://other.example.com", emptyList()))
        rule.node(ServerTags.INPUT).assertTextEquals("https://other.example.com")
        assertEquals("", headersText())
        saveAndConfirm()
        assertEquals(listOf("https://other.example.com" to emptyList<ServerHeader>()), probed)
        assertEquals(listOf("https://other.example.com" to emptyList<ServerHeader>()), saved)
    }

    @Test
    fun aScannedCodeWithAUrlButNoHeadersClearsTheSavedOnes() {
        show(customUrl = "https://old.example.com", customHeaders = listOf(key))
        scanned = ScanResult.Scanned("happy://server?url=https%3A%2F%2Fother.example.com")
        rule.node(ServerTags.SCAN).performClick()
        rule.waitForIdle()
        rule.node(ServerTags.INPUT).assertTextEquals("https://other.example.com")
        assertEquals("", headersText())
        // A code with only headers keeps the URL.
        scanned = ScanResult.Scanned("happy://server?header=X-Example-Key%3A%20abc123")
        rule.node(ServerTags.SCAN).performClick()
        rule.waitForIdle()
        rule.node(ServerTags.INPUT).assertTextEquals("https://other.example.com")
        assertEquals("X-Example-Key: abc123", headersText())
        saveAndConfirm()
        assertEquals(listOf("https://other.example.com" to listOf(key)), probed)
    }
}
