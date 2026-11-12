package com.slopus.happy.config

import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.net.URI
import java.net.URISyntaxException

/**
 * Which Happy server the app talks to. Mirrors
 * packages/happy-app/sources/sync/serverConfig.ts: a custom URL lives in its
 * own preferences file so it survives logout, and the default applies when
 * none is set. A custom server may also have extra request [headers] (a
 * private relay's secret), kept beside its URL and gone with it.
 */
class ServerConfig(
    private val prefs: SharedPreferences,
    val defaultUrl: String,
) {
    /** The URL and its headers, changed together so a request never sees one without the other. */
    data class Snapshot(val url: String, val headers: List<ServerHeader>)

    private val snapshot = MutableStateFlow(readSnapshot())
    private val state = MutableStateFlow(snapshot.value.url)

    /** The server URL in effect, without a trailing slash. */
    val url: StateFlow<String> = state.asStateFlow()

    /** The custom server's extra request headers; none on the default server. */
    val current: StateFlow<Snapshot> = snapshot.asStateFlow()

    val headers: List<ServerHeader> get() = snapshot.value.headers

    val isCustom: Boolean get() = state.value != defaultUrl

    /** serverConfig.ts: voice defaults to Happy's server, even for a self-hosted account. */
    var useCustomServerForVoice: Boolean
        get() = isCustom && prefs.getBoolean("use-custom-server-for-voice", false)
        set(value) { prefs.edit().putBoolean("use-custom-server-for-voice", value).apply() }

    val voiceUrl: String get() = if (useCustomServerForVoice) url.value else defaultUrl

    /** `host[:port]` of a custom server, for the header subtitle; null on the default server. */
    val customHostLabel: String?
        get() {
            if (!isCustom) return null
            return try {
                val uri = URI(state.value)
                if (uri.port >= 0) "${uri.host}:${uri.port}" else uri.host
            } catch (_: URISyntaxException) {
                state.value
            }
        }

    /**
     * A blank or null URL resets to the default, and the default server
     * never has [headers]. Call [validate] first; headers that aren't valid
     * ([ServerHeader.check]) are not kept.
     */
    fun set(url: String?, headers: List<ServerHeader> = emptyList()) {
        val trimmed = url?.trim()?.trimEnd('/')
        if (trimmed.isNullOrEmpty() || trimmed == defaultUrl) {
            prefs.edit().remove(KEY).remove(HEADERS_KEY).apply()
        } else {
            val kept = valid(headers)
            val edit = prefs.edit().putString(KEY, trimmed)
            if (kept.isEmpty()) edit.remove(HEADERS_KEY) else edit.putString(HEADERS_KEY, ServerHeader.format(kept))
            edit.apply()
        }
        snapshot.value = readSnapshot()
        state.value = snapshot.value.url
    }

    private fun read(): String = prefs.getString(KEY, null) ?: defaultUrl

    /** Read back through the same checks, so a header kept here can never fail a request. */
    private fun readSnapshot(): Snapshot {
        val url = read()
        if (url == defaultUrl) return Snapshot(url, emptyList())
        val lines = prefs.getString(HEADERS_KEY, null).orEmpty()
        val headers = lines.lines().mapNotNull { line ->
            val colon = line.indexOf(':')
            if (colon <= 0) null else ServerHeader(line.substring(0, colon).trim(), line.substring(colon + 1).trim())
        }
        return Snapshot(url, valid(headers))
    }

    private fun valid(headers: List<ServerHeader>): List<ServerHeader> =
        headers.filter { ServerHeader.check(it.name, it.value) == null }.take(ServerHeader.MAX_HEADERS)

    sealed interface Validation {
        data object Valid : Validation
        data object Empty : Validation
        data object NotHttp : Validation
        data object Malformed : Validation
    }

    companion object {
        const val PREFS_NAME = "server-config"
        private const val KEY = "custom-server-url"
        private const val HEADERS_KEY = "custom-server-headers"

        /** validateServerUrl */
        fun validate(url: String): Validation {
            val trimmed = url.trim()
            if (trimmed.isEmpty()) return Validation.Empty
            val uri = try {
                URI(trimmed)
            } catch (_: URISyntaxException) {
                return Validation.Malformed
            }
            val scheme = uri.scheme?.lowercase() ?: return Validation.Malformed
            if (scheme != "http" && scheme != "https") return Validation.NotHttp
            if (uri.host.isNullOrEmpty()) return Validation.Malformed
            return Validation.Valid
        }
    }
}
