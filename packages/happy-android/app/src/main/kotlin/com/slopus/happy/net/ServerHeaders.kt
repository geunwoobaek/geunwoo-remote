package com.slopus.happy.net

import com.slopus.happy.config.ServerConfig
import com.slopus.happy.config.ServerHeader
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

/**
 * The custom server's extra request headers ([ServerConfig.headers]) on
 * every request to that server, and on no other: a request gets them only
 * when its scheme, host and port are the custom server URL's. The config is
 * read per request, so a change applies to the next one without a restart.
 *
 * [interceptor] is an application interceptor, so it also runs for OkHttp
 * WebSocket handshakes (the socket.io connection, tunnels), whose `wss:` URL
 * OkHttp gives as `https:`. [redirectGuard], a network interceptor, takes
 * the headers off again on a redirect to another origin: OkHttp itself only
 * drops `Authorization` there. Clients get both through [withServerHeaders].
 */
class ServerHeaders(private val source: () -> ServerConfig.Snapshot?) {
    /** On a request: the header names it was given here, or by a caller that set its own ([explicit]). */
    class Sent(val names: Set<String>) {
        override fun toString() = "Sent(${names.size})"
    }

    val interceptor = Interceptor { chain ->
        val request = chain.request()
        if (request.tag(Sent::class.java) != null) return@Interceptor chain.proceed(request)
        val snapshot = source() ?: return@Interceptor chain.proceed(request)
        val headers = snapshot.headers
        if (headers.isEmpty()) return@Interceptor chain.proceed(request)
        val origin = snapshot.url.toHttpUrlOrNull() ?: return@Interceptor chain.proceed(request)
        if (!sameOrigin(request.url, origin)) return@Interceptor chain.proceed(request)
        // A header the caller set itself stays as the caller set it.
        val added = headers.filter { request.header(it.name) == null }
        if (added.isEmpty()) return@Interceptor chain.proceed(request)
        chain.proceed(
            request.newBuilder()
                .apply { for (header in added) addHeader(header.name, header.value) }
                .tag(Sent::class.java, Sent(added.mapTo(LinkedHashSet()) { it.name }))
                .build(),
        )
    }

    val redirectGuard = Interceptor { chain ->
        val request = chain.request()
        val sent = request.tag(Sent::class.java)
        if (sent == null || sameOrigin(request.url, chain.call().request().url)) return@Interceptor chain.proceed(request)
        chain.proceed(request.newBuilder().apply { for (name in sent.names) removeHeader(name) }.build())
    }

    /** [builder] with both interceptors. A client derived with `newBuilder()` from one has them already. */
    fun install(builder: OkHttpClient.Builder): OkHttpClient.Builder =
        builder.addInterceptor(interceptor).addNetworkInterceptor(redirectGuard)

    companion object {
        @Volatile private var installed: () -> ServerConfig.Snapshot? = { null }

        /** The app's server config, read by [process]; set as the app's graph is built. */
        fun use(config: ServerConfig) {
            installed = { config.current.value }
        }

        /** The one instance every client in the process shares. */
        val process = ServerHeaders { installed() }

        fun sameOrigin(a: HttpUrl, b: HttpUrl): Boolean = a.scheme == b.scheme && a.host == b.host && a.port == b.port

        /**
         * [builder] carrying [headers] the caller chose itself (the Server
         * screen's check of a server not saved yet): the interceptor leaves
         * it alone (none means none, not the saved ones), and the guard
         * still keeps them off other origins.
         */
        fun explicit(builder: Request.Builder, headers: List<ServerHeader>): Request.Builder {
            for (header in headers) builder.addHeader(header.name, header.value)
            return builder.tag(Sent::class.java, Sent(headers.mapTo(LinkedHashSet()) { it.name }))
        }
    }
}

/** This client sends the custom server's headers to it ([ServerHeaders.process]). */
fun OkHttpClient.Builder.withServerHeaders(headers: ServerHeaders = ServerHeaders.process): OkHttpClient.Builder = headers.install(this)
