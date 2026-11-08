package com.slopus.happy.ui.files

import kotlinx.coroutines.CancellationException
import java.util.Base64

/**
 * A page's `<title>`, for the chat's page card. Only the start of the file is
 * read ([HEAD_BYTES], where a title is), so a large page costs one small read.
 */
object PageTitle {
    /** How much of the file is read: a `<head>` holds its title well within this. */
    const val HEAD_BYTES = 16 * 1024

    private val title = Regex("<title\\b[^>]*>([\\s\\S]*?)</title\\s*>", RegexOption.IGNORE_CASE)
    private val entity = Regex("&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);")
    private val named = mapOf("amp" to "&", "lt" to "<", "gt" to ">", "quot" to "\"", "apos" to "'", "nbsp" to " ", "middot" to "·", "mdash" to "—", "ndash" to "–")

    /** The title [head] (a page's first bytes as text) gives, entities decoded and spaces collapsed; null when it gives none. */
    fun of(head: String): String? {
        val raw = title.find(head)?.groupValues?.get(1) ?: return null
        val decoded = entity.replace(raw) { m ->
            val name = m.groupValues[1]
            when {
                name.startsWith("#x") || name.startsWith("#X") -> name.substring(2).toIntOrNull(16)?.let(::codePoint)
                name.startsWith("#") -> name.substring(1).toIntOrNull()?.let(::codePoint)
                else -> named[name.lowercase()]
            } ?: m.value
        }
        return decoded.replace(Regex("\\s+"), " ").trim().takeIf { it.isNotEmpty() }
    }

    private fun codePoint(value: Int): String? = if (Character.isValidCodePoint(value) && value != 0) String(Character.toChars(value)) else null
}

/**
 * The `<title>` of the page at [path], from its first [PageTitle.HEAD_BYTES]
 * (one slice; a CLI without slices sends the whole file once); null when it
 * has none or can't be read.
 */
suspend fun SessionFileOps.readPageTitle(sessionId: String, path: String): String? {
    val head = try {
        val chunk = readFileChunk(sessionId, path, 0, PageTitle.HEAD_BYTES)
        when {
            chunk.success -> chunk.content
            chunk.error == SessionMedia.METHOD_NOT_FOUND -> readFile(sessionId, path).takeIf { it.success }?.content
            else -> null
        }
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    } ?: return null
    val bytes = runCatching { Base64.getMimeDecoder().decode(head) }.getOrNull() ?: return null
    return PageTitle.of(String(bytes, 0, minOf(bytes.size, PageTitle.HEAD_BYTES), Charsets.UTF_8))
}
