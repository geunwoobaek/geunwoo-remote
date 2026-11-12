package com.slopus.happy.config

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.config.ServerHeader.Parse
import com.slopus.happy.config.ServerHeader.Problem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The custom server's extra request headers: the Server screen's
 * `Name: value` lines, what is refused, and how ServerConfig keeps them
 * beside the URL.
 */
@RunWith(AndroidJUnit4::class)
class ServerHeaderTest {
    private fun prefs() = ApplicationProvider.getApplicationContext<Context>()
        .getSharedPreferences(ServerConfig.PREFS_NAME, Context.MODE_PRIVATE)
        .also { it.edit().clear().commit() }

    @Test
    fun aGoodLineIsOneHeader() {
        assertEquals(Parse.Valid(listOf(ServerHeader("X-Example-Key", "abc123"))), ServerHeader.parse("X-Example-Key: abc123"))
        // Spaces around the colon and the value are not part of either; a colon in the value is.
        assertEquals(Parse.Valid(listOf(ServerHeader("X-Example-Key", "a:b c"))), ServerHeader.parse("  X-Example-Key :  a:b c  "))
        assertEquals(Parse.Valid(listOf(ServerHeader("X-Empty", ""))), ServerHeader.parse("X-Empty:"))
    }

    @Test
    fun severalLinesAreSeveralHeadersAndBlankLinesAreSkipped() {
        val text = "CF-Access-Client-Id: id.example\n\n  \r\nCF-Access-Client-Secret: s3cret\r\nX-Example-Key: k"
        assertEquals(
            Parse.Valid(
                listOf(
                    ServerHeader("CF-Access-Client-Id", "id.example"),
                    ServerHeader("CF-Access-Client-Secret", "s3cret"),
                    ServerHeader("X-Example-Key", "k"),
                ),
            ),
            ServerHeader.parse(text),
        )
        assertEquals(Parse.Valid(emptyList()), ServerHeader.parse(""))
        assertEquals(Parse.Valid(emptyList()), ServerHeader.parse("\n  \n"))
    }

    @Test
    fun aLineWithoutAColonOrANameIsMalformed() {
        assertEquals(Parse.Invalid(1, Problem.Malformed), ServerHeader.parse("X-Example-Key abc"))
        assertEquals(Parse.Invalid(2, Problem.Malformed), ServerHeader.parse("X-A: 1\n: value"))
        assertEquals(Parse.Invalid(3, Problem.Malformed), ServerHeader.parse("X-A: 1\n\nnot a header"))
    }

    @Test
    fun aNameMustBeAToken() {
        assertEquals(Parse.Invalid(1, Problem.BadName), ServerHeader.parse("X Example: 1"))
        assertEquals(Parse.Invalid(1, Problem.BadName), ServerHeader.parse("X(Example): 1"))
        assertEquals(Parse.Invalid(1, Problem.BadName), ServerHeader.parse("Ключ: 1"))
        assertTrue(ServerHeader.isName("x-a_b.c~1!#$%&'*+^`|"))
        assertFalse(ServerHeader.isName(""))
        assertFalse(ServerHeader.isName("a:b"))
    }

    @Test
    fun aValueMayNotCarryCrLfOrOtherControlCharacters() {
        // In the field a CR or LF starts a new line, so it can't end up inside a value.
        assertEquals(Parse.Invalid(2, Problem.Malformed), ServerHeader.parse("X-A: 1\rInjected"))
        assertEquals(Parse.Invalid(2, Problem.Malformed), ServerHeader.parse("X-A: 1\nInjected"))
        assertEquals(Problem.BadValue, ServerHeader.check("X-A", "1\r\nX-B: 2"))
        assertEquals(Problem.BadValue, ServerHeader.check("X-A", "1\n2"))
        assertEquals(Problem.BadValue, ServerHeader.check("X-A", "a\u0000b"))
        assertEquals(Parse.Invalid(1, Problem.BadValue), ServerHeader.parse("X-A: café"))
        assertEquals(null, ServerHeader.check("X-A", "tab\there ~"))
    }

    @Test
    fun headersTheAppSetsItselfAreRefused() {
        for (name in listOf("Host", "content-length", "AUTHORIZATION")) {
            assertEquals(name, Parse.Invalid(1, Problem.Forbidden), ServerHeader.parse("$name: x"))
        }
        assertEquals(Parse.Invalid(2, Problem.Forbidden), ServerHeader.parse("X-A: 1\nAuthorization: Bearer x"))
    }

    @Test
    fun atMostSixteen() {
        val sixteen = (1..16).joinToString("\n") { "X-H$it: $it" }
        assertEquals(16, (ServerHeader.parse(sixteen) as Parse.Valid).headers.size)
        assertEquals(Parse.Invalid(17, Problem.TooMany), ServerHeader.parse("$sixteen\nX-H17: 17"))
    }

    @Test
    fun theValueNeverPrints() {
        val header = ServerHeader("X-Example-Key", "do-not-print")
        assertFalse(header.toString().contains("do-not-print"))
        val snapshot = ServerConfig.Snapshot("https://happy.example.com", listOf(header))
        assertFalse(snapshot.toString().contains("do-not-print"))
        assertEquals("X-Example-Key: do-not-print", header.line())
    }

    @Test
    fun headersAreKeptWithTheCustomUrlAndGoWithIt() {
        val prefs = prefs()
        val config = ServerConfig(prefs, "https://api.default.example")
        assertEquals(emptyList<ServerHeader>(), config.headers)

        val headers = listOf(ServerHeader("X-Example-Key", "k1"), ServerHeader("CF-Access-Client-Id", "id"))
        config.set("https://happy.example.com:3005/", headers)
        assertEquals("https://happy.example.com:3005", config.url.value)
        assertEquals(headers, config.headers)
        assertEquals(ServerConfig.Snapshot("https://happy.example.com:3005", headers), config.current.value)

        val restarted = ServerConfig(prefs, "https://api.default.example")
        assertEquals("survive a restart", headers, restarted.headers)
        assertEquals("https://happy.example.com:3005", restarted.url.value)

        // Saving the URL alone saves it without headers.
        config.set("https://happy.example.com:3005")
        assertEquals(emptyList<ServerHeader>(), config.headers)

        config.set("https://happy.example.com:3005", headers)
        config.set(null)
        assertEquals("https://api.default.example", config.url.value)
        assertEquals("reset clears them", emptyList<ServerHeader>(), config.headers)
        assertEquals(emptyList<ServerHeader>(), ServerConfig(prefs, "https://api.default.example").headers)

        config.set("https://happy.example.com", headers)
        config.set("  ", headers)
        assertEquals("a blank URL is the default, which has none", emptyList<ServerHeader>(), config.headers)
        config.set("https://api.default.example", headers)
        assertEquals("so does the default URL itself", emptyList<ServerHeader>(), config.headers)
    }

    @Test
    fun invalidHeadersAreNeverKept() {
        val prefs = prefs()
        val config = ServerConfig(prefs, "https://api.default.example")
        config.set(
            "https://happy.example.com",
            listOf(ServerHeader("Host", "evil.example"), ServerHeader("X-Good", "1"), ServerHeader("X-Bad", "a\u0007")),
        )
        assertEquals(listOf(ServerHeader("X-Good", "1")), config.headers)
        // What is on disk is read through the same checks.
        prefs.edit().putString("custom-server-headers", "X-Good: 1\nnot a header\nAuthorization: x\nX-Two: 2").commit()
        assertEquals(listOf(ServerHeader("X-Good", "1"), ServerHeader("X-Two", "2")), ServerConfig(prefs, "https://api.default.example").headers)
    }
}
