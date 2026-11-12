package com.slopus.happy.ui.connect

import java.net.URI
import java.net.URISyntaxException
import java.net.URLDecoder

/**
 * `happy://server?url=<server URL>&header=<Name: value>`, with `header`
 * repeated for each extra request header: a self-hoster's server settings,
 * from a link or a QR code read by the Server screen's scanner. Both values
 * are percent-encoded, and `+` reads as a space (URLSearchParams). It only
 * fills the Server screen in; nothing is saved until the person taps Save
 * and confirms. Exactly host `server`: a team server's
 * `happy://<instanceId>/server?url=…` ([com.slopus.happy.connection.ServerInvite])
 * is never one. The header values are secrets, so it never prints them.
 */
class ServerLink(val url: String?, val headers: List<String>) {
    /** Whether it has anything to fill in; plain `happy://server` has not. */
    val fillsIn: Boolean get() = url != null || headers.isNotEmpty()

    /** The headers as the Server screen's field shows them. */
    val headerText: String? get() = headers.takeIf { it.isNotEmpty() }?.joinToString("\n")

    /**
     * The headers field once this link fills it in over [current]. A link
     * with a URL brings exactly its own headers, none if it has none, so a
     * saved secret never rides along to another server; a link with only
     * headers keeps the URL and replaces the headers.
     */
    fun headersReplacing(current: String): String = headerText ?: if (url != null) "" else current

    override fun equals(other: Any?): Boolean = other is ServerLink && other.url == url && other.headers == headers

    override fun hashCode(): Int = url.hashCode() * 31 + headers.hashCode()

    override fun toString(): String = "ServerLink(url=$url, headers=${headers.size})"

    companion object {
        private const val MAX_LENGTH = 8 * 1024
        private const val MAX_HEADERS = 16

        /**
         * [text] as a server link, or null if it isn't one: another scheme
         * or host, an instance-locked link, or a header with a line break
         * in it (one header can't become two). Parameters it doesn't know
         * are ignored.
         */
        fun parse(text: String): ServerLink? {
            val trimmed = text.trim()
            if (trimmed.length > MAX_LENGTH) return null
            val uri = try {
                URI(trimmed)
            } catch (_: URISyntaxException) {
                return null
            }
            if (uri.scheme?.lowercase() != "happy") return null
            val path = uri.rawPath.orEmpty()
            val isServer = when (uri.host?.lowercase()) {
                "server" -> path.isEmpty() || path == "/"
                // `happy:///server`, as expo-router reads a link with an empty host.
                null -> uri.rawAuthority == null && (path == "/server" || path == "/server/")
                else -> false
            }
            if (!isServer) return null
            var url: String? = null
            val headers = ArrayList<String>()
            for (pair in uri.rawQuery.orEmpty().split('&')) {
                if (pair.isEmpty()) continue
                val name = decode(pair.substringBefore('=')) ?: return null
                val value = (if ('=' in pair) decode(pair.substringAfter('=')) else "") ?: return null
                when (name) {
                    "url" -> if (url == null) url = value.trim().takeIf { it.isNotEmpty() }
                    "header" -> {
                        if ('\r' in value || '\n' in value) return null
                        if (value.isNotBlank() && headers.size < MAX_HEADERS) headers += value.trim()
                    }
                }
            }
            return ServerLink(url, headers)
        }

        private fun decode(value: String): String? = try {
            URLDecoder.decode(value, "UTF-8") // The Charset overload is API 33.
        } catch (_: IllegalArgumentException) {
            null
        }
    }
}
