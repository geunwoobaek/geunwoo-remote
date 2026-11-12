package com.slopus.happy.config

/**
 * One extra request header the custom server needs, such as the secret a
 * private relay in front of a self-hosted server checks. Sent only to that
 * server ([com.slopus.happy.net.ServerHeaders]). The value is a secret: it
 * never prints.
 */
class ServerHeader(val name: String, val value: String) {
    override fun equals(other: Any?): Boolean = other is ServerHeader && other.name == name && other.value == value

    override fun hashCode(): Int = name.hashCode() * 31 + value.hashCode()

    override fun toString(): String = "ServerHeader($name: …)"

    /** As the Server screen's field and a server link write it. */
    fun line(): String = "$name: $value"

    /** Why a line of the Server screen's headers field isn't a header. */
    enum class Problem {
        /** No `Name: value` shape: no colon, or nothing before it. */
        Malformed,

        /** The name has characters a header name can't (RFC 7230 token). */
        BadName,

        /** The value has control characters or non-ASCII (CR, LF and the rest). */
        BadValue,

        /** A header the app sets itself ([FORBIDDEN]). */
        Forbidden,

        /** More than [MAX_HEADERS]. */
        TooMany,
    }

    /** What the headers field reads as. */
    sealed interface Parse {
        data class Valid(val headers: List<ServerHeader>) : Parse

        /** The first line that isn't a header, counted from 1. */
        data class Invalid(val line: Int, val problem: Problem) : Parse
    }

    companion object {
        /** Headers the app sets itself, which a custom one would break. */
        val FORBIDDEN = setOf("host", "content-length", "authorization")

        /** At most this many headers are kept. */
        const val MAX_HEADERS = 16

        private const val TCHARS = "!#$%&'*+-.^_`|~"

        /** RFC 7230 `token`: what a header name may be. */
        fun isName(name: String): Boolean =
            name.isNotEmpty() && name.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it in TCHARS }

        /** Visible ASCII, space and tab: what OkHttp accepts in a value, so a kept header can never fail a request. */
        fun isValue(value: String): Boolean = value.all { it == '\t' || it in ' '..'~' }

        /** [name] and [value] as a header, or why not. */
        fun check(name: String, value: String): Problem? = when {
            !isName(name) -> if (name.isEmpty()) Problem.Malformed else Problem.BadName
            name.lowercase() in FORBIDDEN -> Problem.Forbidden
            !isValue(value) -> Problem.BadValue
            else -> null
        }

        /**
         * The headers field: one `Name: value` per line, blank lines
         * skipped, the value trimmed. Any line that isn't one makes the
         * whole field [Parse.Invalid], so nothing is saved half-read.
         */
        fun parse(text: String): Parse {
            val headers = ArrayList<ServerHeader>()
            // Split on every line break, so a lone CR can't hide inside a value.
            text.split("\r\n", "\n", "\r").forEachIndexed { index, raw ->
                if (raw.isBlank()) return@forEachIndexed
                val colon = raw.indexOf(':')
                if (colon < 0) return Parse.Invalid(index + 1, Problem.Malformed)
                val name = raw.substring(0, colon).trim()
                val value = raw.substring(colon + 1).trim()
                check(name, value)?.let { return Parse.Invalid(index + 1, it) }
                if (headers.size == MAX_HEADERS) return Parse.Invalid(index + 1, Problem.TooMany)
                headers += ServerHeader(name, value)
            }
            return Parse.Valid(headers)
        }

        /** [headers] as the field shows them, one per line. */
        fun format(headers: List<ServerHeader>): String = headers.joinToString("\n") { it.line() }
    }
}
