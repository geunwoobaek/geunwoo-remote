package com.slopus.happy.net

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.config.ServerConfig
import com.slopus.happy.config.ServerHeader
import com.slopus.happy.connection.WebSocketTunnel
import com.slopus.happy.testing.SoftwareKeys
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Request
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.TimeUnit

/**
 * The process-wide wiring: a real AppGraph installs its ServerConfig into
 * [ServerHeaders.process], so the graph's own client and the clients built
 * without it (here the tunnels') send what the Server screen saved, and
 * stop when it is reset.
 */
@RunWith(AndroidJUnit4::class)
class ServerHeadersAppTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val custom = MockWebServer().apply { start() }

    @After
    fun tearDown() {
        custom.close()
        context.getSharedPreferences(ServerConfig.PREFS_NAME, Context.MODE_PRIVATE).edit().clear().commit()
    }

    @Test
    fun whatTheServerScreenSavesReachesEveryClient() = runBlocking {
        val graph = AppGraph(context, "android/test", "http://127.0.0.1:9", SoftwareKeys(), databaseName = null)
        val url = custom.url("/").toString().trimEnd('/')
        graph.serverConfig.set(url, listOf(ServerHeader("X-Example-Key", "k1")))

        custom.enqueue(MockResponse.Builder().body("{}").build())
        graph.http.send("GET", "/v1/anything")
        assertEquals("k1", custom.takeRequest(5, TimeUnit.SECONDS)!!.headers["X-Example-Key"])

        custom.enqueue(MockResponse.Builder().body("ok").build())
        WebSocketTunnel.client.newCall(Request.Builder().url(custom.url("/plain")).build()).execute().close()
        assertEquals("a client built without the graph", "k1", custom.takeRequest(5, TimeUnit.SECONDS)!!.headers["X-Example-Key"])

        graph.serverConfig.set(url, listOf(ServerHeader("X-Example-Key", "k2")))
        custom.enqueue(MockResponse.Builder().body("{}").build())
        graph.http.send("GET", "/v1/anything")
        assertEquals("k2", custom.takeRequest(5, TimeUnit.SECONDS)!!.headers["X-Example-Key"])

        graph.serverConfig.set(null)
        custom.enqueue(MockResponse.Builder().body("ok").build())
        graph.okHttp.newCall(Request.Builder().url(custom.url("/after-reset")).build()).execute().close()
        assertNull(custom.takeRequest(5, TimeUnit.SECONDS)!!.headers["X-Example-Key"])
    }
}
