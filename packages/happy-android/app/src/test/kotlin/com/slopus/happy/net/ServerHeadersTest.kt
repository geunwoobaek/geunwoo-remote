package com.slopus.happy.net

import com.slopus.happy.config.ServerConfig
import com.slopus.happy.config.ServerHeader
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * ServerHeaders: the custom server's headers go to exactly its scheme,
 * host and port, read live, also on WebSocket handshakes, and never on to
 * another origin by a redirect.
 */
class ServerHeadersTest {
    private val custom = MockWebServer().apply { start() }
    private val other = MockWebServer().apply { start() }

    @After
    fun tearDown() {
        custom.close()
        other.close()
    }

    private val key = ServerHeader("X-Example-Key", "k1")
    private val access = ServerHeader("CF-Access-Client-Id", "id.example")

    /** What ServerConfig would say: [url] and its headers, changed by the test. */
    @Volatile private var snapshot: ServerConfig.Snapshot? = null
    private val headers = ServerHeaders { snapshot }
    private val client = OkHttpClient.Builder().withServerHeaders(headers).build()

    private fun customUrl() = custom.url("/").toString().trimEnd('/')

    private fun get(url: String, configure: Request.Builder.() -> Unit = {}): RecordedRequest {
        val server = if (url.startsWith(custom.url("/").toString())) custom else other
        server.enqueue(MockResponse.Builder().body("ok").build())
        client.newCall(Request.Builder().url(url).apply(configure).build()).execute().use { it.body.string() }
        return server.takeRequest(5, TimeUnit.SECONDS)!!
    }

    @Test
    fun theCustomServerGetsItsHeaders() {
        snapshot = ServerConfig.Snapshot(customUrl(), listOf(key, access))
        val request = get(custom.url("/v1/sessions").toString())
        assertEquals("k1", request.headers["X-Example-Key"])
        assertEquals("id.example", request.headers["CF-Access-Client-Id"])
    }

    @Test
    fun theDefaultServerAndOtherHostsGetNone() {
        // On the default server there are none at all.
        snapshot = ServerConfig.Snapshot(customUrl(), emptyList())
        assertNull(get(custom.url("/").toString()).headers["X-Example-Key"])

        snapshot = ServerConfig.Snapshot(customUrl(), listOf(key))
        // Another host (the same machine by another name), as the default server or a third party would be.
        val elsewhere = other.url("/").newBuilder().host("127.0.0.1").build()
        assertNull(get(elsewhere.toString()).headers["X-Example-Key"])
        val byName = custom.url("/").newBuilder().host(if (custom.hostName == "localhost") "127.0.0.1" else "localhost").build()
        custom.enqueue(MockResponse.Builder().body("ok").build())
        client.newCall(Request.Builder().url(byName).build()).execute().close()
        assertNull("another host name for the same machine", custom.takeRequest(5, TimeUnit.SECONDS)!!.headers["X-Example-Key"])
    }

    @Test
    fun theSameHostOnAnotherPortGetsNone() {
        snapshot = ServerConfig.Snapshot(customUrl(), listOf(key))
        val samehost = other.url("/").newBuilder().host(custom.hostName).build()
        other.enqueue(MockResponse.Builder().body("ok").build())
        client.newCall(Request.Builder().url(samehost).build()).execute().close()
        assertNull(other.takeRequest(5, TimeUnit.SECONDS)!!.headers["X-Example-Key"])
    }

    @Test
    fun anotherSchemeGetsNone() {
        // https://host:port for a server reached over http://host:port.
        val https = custom.url("/").newBuilder().scheme("https").build().toString().trimEnd('/')
        snapshot = ServerConfig.Snapshot(https, listOf(key))
        assertNull(get(custom.url("/").toString()).headers["X-Example-Key"])
    }

    @Test
    fun aChangeAppliesToTheNextRequest() {
        snapshot = ServerConfig.Snapshot(customUrl(), listOf(key))
        assertEquals("k1", get(custom.url("/").toString()).headers["X-Example-Key"])
        snapshot = ServerConfig.Snapshot(customUrl(), listOf(ServerHeader("X-Example-Key", "k2")))
        assertEquals("k2", get(custom.url("/").toString()).headers["X-Example-Key"])
        snapshot = ServerConfig.Snapshot("https://happy.example.com", listOf(key))
        assertNull(get(custom.url("/").toString()).headers["X-Example-Key"])
    }

    @Test
    fun liveFromServerConfig() {
        val prefs = InMemoryPrefs()
        val config = ServerConfig(prefs, "https://api.default.example")
        val live = ServerHeaders { config.current.value }
        val client = OkHttpClient.Builder().withServerHeaders(live).build()
        fun send(): RecordedRequest {
            custom.enqueue(MockResponse.Builder().body("ok").build())
            client.newCall(Request.Builder().url(custom.url("/")).build()).execute().close()
            return custom.takeRequest(5, TimeUnit.SECONDS)!!
        }
        assertNull(send().headers["X-Example-Key"])
        config.set(customUrl(), listOf(key))
        assertEquals("k1", send().headers["X-Example-Key"])
        config.set(null)
        assertNull(send().headers["X-Example-Key"])
    }

    @Test
    fun aHeaderTheCallerSetStays() {
        snapshot = ServerConfig.Snapshot(customUrl(), listOf(key, access))
        val request = get(custom.url("/").toString()) { header("X-Example-Key", "mine") }
        assertEquals(listOf("mine"), request.headers.values("X-Example-Key"))
        assertEquals("id.example", request.headers["CF-Access-Client-Id"])
    }

    @Test
    fun explicitHeadersReplaceTheSavedOnes() {
        snapshot = ServerConfig.Snapshot(customUrl(), listOf(key, access))
        // The Server screen's check of a server not saved yet: its own headers, none of the saved ones.
        val request = get(custom.url("/").toString()) { ServerHeaders.explicit(this, listOf(ServerHeader("X-Example-Key", "draft"))) }
        assertEquals(listOf("draft"), request.headers.values("X-Example-Key"))
        assertNull(request.headers["CF-Access-Client-Id"])
        // None means none.
        assertNull(get(custom.url("/").toString()) { ServerHeaders.explicit(this, emptyList()) }.headers["X-Example-Key"])
    }

    @Test
    fun theProbeSendsTheHeadersBeingSaved() = runBlocking {
        snapshot = null
        val http = HappyHttp(client, { "https://api.default.example" }, "client-1")
        custom.enqueue(MockResponse.Builder().body("Welcome to Happy Server!").build())
        val api = com.slopus.happy.auth.AuthApi(http)
        assertEquals(com.slopus.happy.auth.AuthApi.ServerProbe.HappyServer, api.probeServer(customUrl(), listOf(key)))
        assertEquals("k1", custom.takeRequest(5, TimeUnit.SECONDS)!!.headers["X-Example-Key"])
    }

    @Test
    fun aRedirectToAnotherOriginDropsThem() {
        snapshot = ServerConfig.Snapshot(customUrl(), listOf(key))
        custom.enqueue(MockResponse.Builder().code(302).addHeader("Location", other.url("/landed")).build())
        other.enqueue(MockResponse.Builder().body("ok").build())
        client.newCall(Request.Builder().url(custom.url("/start")).build()).execute().use { assertEquals(200, it.code) }
        assertEquals("k1", custom.takeRequest(5, TimeUnit.SECONDS)!!.headers["X-Example-Key"])
        val landed = other.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("/landed", landed.target)
        assertNull("not carried to another origin", landed.headers["X-Example-Key"])

        // Why the guard: OkHttp alone carries every header but Authorization on to the redirect's origin.
        val unguarded = OkHttpClient.Builder().addInterceptor(headers.interceptor).build()
        custom.enqueue(MockResponse.Builder().code(302).addHeader("Location", other.url("/landed")).build())
        other.enqueue(MockResponse.Builder().body("ok").build())
        unguarded.newCall(Request.Builder().url(custom.url("/start")).build()).execute().close()
        custom.takeRequest(5, TimeUnit.SECONDS)
        assertEquals("k1", other.takeRequest(5, TimeUnit.SECONDS)!!.headers["X-Example-Key"])

        // Nor explicit ones.
        custom.enqueue(MockResponse.Builder().code(302).addHeader("Location", other.url("/landed")).build())
        other.enqueue(MockResponse.Builder().body("ok").build())
        client.newCall(ServerHeaders.explicit(Request.Builder().url(custom.url("/start")), listOf(access)).build()).execute().close()
        assertEquals("id.example", custom.takeRequest(5, TimeUnit.SECONDS)!!.headers["CF-Access-Client-Id"])
        assertNull(other.takeRequest(5, TimeUnit.SECONDS)!!.headers["CF-Access-Client-Id"])
    }

    @Test
    fun aRedirectWithinTheServerKeepsThem() {
        snapshot = ServerConfig.Snapshot(customUrl(), listOf(key))
        custom.enqueue(MockResponse.Builder().code(302).addHeader("Location", custom.url("/landed")).build())
        custom.enqueue(MockResponse.Builder().body("ok").build())
        client.newCall(Request.Builder().url(custom.url("/start")).build()).execute().close()
        assertEquals("k1", custom.takeRequest(5, TimeUnit.SECONDS)!!.headers["X-Example-Key"])
        assertEquals("k1", custom.takeRequest(5, TimeUnit.SECONDS)!!.headers["X-Example-Key"])
    }

    @Test
    fun aWebSocketHandshakeGetsThem() {
        snapshot = ServerConfig.Snapshot(customUrl(), listOf(key))
        custom.enqueue(MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {}).build())
        val opened = CountDownLatch(1)
        val wsUrl = custom.url("/v1/updates/").toString().replaceFirst("http", "ws")
        val socket = client.newWebSocket(
            Request.Builder().url(wsUrl).build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) = opened.countDown()
            },
        )
        assertTrue(opened.await(5, TimeUnit.SECONDS))
        assertEquals("k1", custom.takeRequest(5, TimeUnit.SECONDS)!!.headers["X-Example-Key"])
        socket.cancel()
    }

    @Test
    fun aDerivedClientKeepsThemOnce() {
        snapshot = ServerConfig.Snapshot(customUrl(), listOf(key))
        val derived = client.newBuilder().readTimeout(1, TimeUnit.SECONDS).build()
        custom.enqueue(MockResponse.Builder().body("ok").build())
        derived.newCall(Request.Builder().url(custom.url("/")).build()).execute().close()
        assertEquals(listOf("k1"), custom.takeRequest(5, TimeUnit.SECONDS)!!.headers.values("X-Example-Key"))
    }
}

/** SharedPreferences in memory, enough for ServerConfig. */
private class InMemoryPrefs : android.content.SharedPreferences {
    private val values = HashMap<String, Any?>()
    override fun getAll(): MutableMap<String, *> = HashMap(values)
    override fun getString(key: String, defValue: String?): String? = values[key] as String? ?: defValue
    override fun getStringSet(key: String, defValues: MutableSet<String>?): MutableSet<String>? = defValues
    override fun getInt(key: String, defValue: Int): Int = defValue
    override fun getLong(key: String, defValue: Long): Long = defValue
    override fun getFloat(key: String, defValue: Float): Float = defValue
    override fun getBoolean(key: String, defValue: Boolean): Boolean = values[key] as Boolean? ?: defValue
    override fun contains(key: String): Boolean = key in values
    override fun registerOnSharedPreferenceChangeListener(listener: android.content.SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
    override fun unregisterOnSharedPreferenceChangeListener(listener: android.content.SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
    override fun edit(): android.content.SharedPreferences.Editor = object : android.content.SharedPreferences.Editor {
        private val changes = HashMap<String, Any?>()
        private val removed = HashSet<String>()
        override fun putString(key: String, value: String?) = apply { changes[key] = value }
        override fun putStringSet(key: String, values: MutableSet<String>?) = this
        override fun putInt(key: String, value: Int) = this
        override fun putLong(key: String, value: Long) = this
        override fun putFloat(key: String, value: Float) = this
        override fun putBoolean(key: String, value: Boolean) = apply { changes[key] = value }
        override fun remove(key: String) = apply { removed += key }
        override fun clear() = apply { removed += values.keys }
        override fun commit(): Boolean {
            apply()
            return true
        }

        override fun apply() {
            removed.forEach(values::remove)
            values.putAll(changes)
        }
    }
}
