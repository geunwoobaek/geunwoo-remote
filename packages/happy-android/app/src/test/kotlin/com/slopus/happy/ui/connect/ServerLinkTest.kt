package com.slopus.happy.ui.connect

import com.slopus.happy.connection.ServerInvite
import com.slopus.happy.ui.ServerRoute
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `happy://server?url=…&header=…`: one parse ([ServerLink.parse]) for the
 * deep link and the Server screen's scanner. It only fills the screen in.
 */
class ServerLinkTest {
    private val link = "happy://server?url=https%3A%2F%2Fhappy.example.com%3A8443&header=X-Example-Key%3A%20abc123"

    @Test
    fun urlAndHeaderAreRead() {
        val parsed = ServerLink.parse(link)!!
        assertEquals("https://happy.example.com:8443", parsed.url)
        assertEquals(listOf("X-Example-Key: abc123"), parsed.headers)
        assertEquals("X-Example-Key: abc123", parsed.headerText)
        assertTrue(parsed.fillsIn)
    }

    @Test
    fun headerRepeats() {
        val parsed = ServerLink.parse(
            "happy://server?url=https%3A%2F%2Fhappy.example.com&header=CF-Access-Client-Id%3A%20id.example&header=CF-Access-Client-Secret%3A%20s3cret",
        )!!
        assertEquals(listOf("CF-Access-Client-Id: id.example", "CF-Access-Client-Secret: s3cret"), parsed.headers)
        assertEquals("CF-Access-Client-Id: id.example\nCF-Access-Client-Secret: s3cret", parsed.headerText)
    }

    @Test
    fun eitherAloneAndNeither() {
        assertEquals(ServerLink("https://happy.example.com", emptyList()), ServerLink.parse("happy://server?url=https%3A%2F%2Fhappy.example.com"))
        assertEquals(ServerLink(null, listOf("X-A: 1")), ServerLink.parse("happy://server?header=X-A%3A%201"))
        val plain = ServerLink.parse("happy://server")!!
        assertFalse(plain.fillsIn)
        assertEquals(ServerLink(null, emptyList()), plain)
        assertEquals(ServerLink(null, emptyList()), ServerLink.parse("happy://server/"))
        assertEquals(ServerLink(null, emptyList()), ServerLink.parse("happy://server?other=1"))
    }

    @Test
    fun plusIsASpaceAndUnencodedValuesStillRead() {
        // URLSearchParams: `+` is a space, as in every other app link's query.
        assertEquals(listOf("X-A: 1"), ServerLink.parse("happy://server?header=X-A:+1")!!.headers)
        assertEquals("https://happy.example.com/base", ServerLink.parse("happy://server?url=https://happy.example.com/base")!!.url)
        assertEquals("first url wins", "https://a.example.com", ServerLink.parse("happy://server?url=https%3A%2F%2Fa.example.com&url=https%3A%2F%2Fb.example.com")!!.url)
    }

    @Test
    fun aHeaderWithALineBreakIsNoLink() {
        assertNull(ServerLink.parse("happy://server?url=https%3A%2F%2Fhappy.example.com&header=X-A%3A%201%0D%0AX-B%3A%202"))
        assertNull(ServerLink.parse("happy://server?header=X-A%3A%201%0AX-B%3A%202"))
    }

    @Test
    fun otherLinksAreNotServerLinks() {
        listOf(
            "https://server?url=x",
            "happy://servers?url=x",
            "happy://server/extra?url=x",
            "happy://terminal?abc",
            "happy://direct?code=1",
            // A team server's code (ServerInvite) is a different thing entirely.
            "happy://a0123456789abcdefghijklm/server?url=https%3A%2F%2Fteam.example.com%2F",
            "not a link",
            "happy://server?url=%zz",
        ).forEach { assertNull(it, ServerLink.parse(it)) }
    }

    @Test
    fun aLinkWithAUrlBringsExactlyItsOwnHeaders() {
        val saved = "X-Old: secret"
        assertEquals("", ServerLink("https://other.example.com", emptyList()).headersReplacing(saved))
        assertEquals("X-A: 1", ServerLink("https://other.example.com", listOf("X-A: 1")).headersReplacing(saved))
        assertEquals("X-A: 1", ServerLink(null, listOf("X-A: 1")).headersReplacing(saved))
        assertEquals(saved, ServerLink(null, emptyList()).headersReplacing(saved))
    }

    @Test
    fun theTripleSlashFormIsTheSame() {
        assertEquals(ServerLink("https://happy.example.com", emptyList()), ServerLink.parse("happy:///server?url=https%3A%2F%2Fhappy.example.com"))
    }

    @Test
    fun theHeaderValueNeverPrints() {
        assertFalse(ServerLink.parse(link)!!.toString().contains("abc123"))
        assertFalse(ServerRoute("https://happy.example.com", "X-Example-Key: abc123").toString().contains("abc123"))
        assertFalse(parseDeepLink(link).toString().contains("abc123"))
    }

    @Test
    fun theDeepLinkOpensTheServerScreenFilledIn() {
        assertEquals(
            DeepLink.Screen(ServerRoute("https://happy.example.com:8443", "X-Example-Key: abc123"), signedOut = true),
            parseDeepLink(link),
        )
        assertEquals(
            DeepLink.Screen(ServerRoute(null, "X-A: 1\nX-B: 2"), signedOut = true),
            parseDeepLink("happy://server?header=X-A%3A%201&header=X-B%3A%202"),
        )
    }

    @Test
    fun aPlainServerLinkIsUnchanged() {
        assertEquals(DeepLink.Screen(ServerRoute(), signedOut = true), parseDeepLink("happy://server"))
        assertEquals(DeepLink.Screen(ServerRoute(), signedOut = true), parseDeepLink("https://app.happy.engineering/server"))
        // A malformed one opens the screen empty, as before.
        assertEquals(DeepLink.Screen(ServerRoute(), signedOut = true), parseDeepLink("happy://server?header=X-A%3A%201%0AX-B%3A%202"))
    }

    @Test
    fun scannersDoNotTakeItForATeamServer() {
        val code = HappyCode.classify(link)
        assertTrue(code.toString(), code is HappyCode.UnknownHappy)
        assertFalse(ServerInvite.isServerCode(link))
        assertNull(ServerInvite.parse(link))
        // The team server's code is still one.
        val invite = "happy://a0123456789abcdefghijklm/server?url=https%3A%2F%2Fteam.example.com%2F"
        assertTrue(HappyCode.classify(invite) is HappyCode.Server)
        assertNotNull(ServerInvite.parse(invite))
    }
}
