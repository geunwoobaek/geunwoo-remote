package com.slopus.happy.ui.files

import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatRow
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.OutputStream
import java.security.MessageDigest
import java.util.Base64

/** What a session file shows as: a picture, a recording, or a web page. */
enum class MediaKind { Picture, Video, Page }

/**
 * The pictures, recordings and pages an agent makes, seen on the phone
 * without saving anything: their paths found in its words and tool calls,
 * and their bytes read from the computer a slice at a time (happy-cli
 * `readFileChunk`), so a recording larger than one relay message still
 * arrives. A CLI without chunked reads gets one whole `readFile` instead.
 */
object SessionMedia {
    const val METHOD_NOT_FOUND = "Method not found"

    /** One slice: 2 MB raw is about 3.6 MB on the wire, under the relay's 8 MB. */
    const val CHUNK_BYTES = 2 * 1024 * 1024
    const val MAX_PICTURE_BYTES = 40L * 1024 * 1024
    const val MAX_VIDEO_BYTES = 300L * 1024 * 1024

    /** Under the cache, and the one other folder conversation_media_paths.xml shares. */
    const val DIRECTORY = "session-media"

    /** The most a message shows under it. */
    const val MAX_PER_MESSAGE = 8

    private val pictures = setOf("png", "jpg", "jpeg", "gif", "webp", "bmp")
    private val videos = setOf("mp4", "mov", "m4v", "webm")
    private val pages = setOf("html", "htm")

    fun kindOf(path: String): MediaKind? = when (path.substringAfterLast('/').substringAfterLast('.', "").lowercase()) {
        in pictures -> MediaKind.Picture
        in videos -> MediaKind.Video
        in pages -> MediaKind.Page
        else -> null
    }

    private const val EXTENSIONS = "png|jpe?g|gif|webp|bmp|mp4|mov|m4v|webm|html?"

    /** A bare path: no spaces, not inside a URL (nothing word-like, `:` or `/` right before it). */
    private val barePath = Regex(
        "(?<![\\w.:/~\\-가-힣])((?:~|\\.{1,2})?/?(?:[\\w.\\-~가-힣]+/)*[\\w.\\-가-힣]+\\.(?:$EXTENSIONS))(?![\\w\\-가-힣])",
        RegexOption.IGNORE_CASE,
    )

    /** A path in backticks or quotes, which may hold spaces. */
    private val quotedPath = Regex("[`'\"]((?:~|\\.{1,2}|/)[^`'\"\\n]*?\\.(?:$EXTENSIONS))[`'\"]", RegexOption.IGNORE_CASE)

    /** The picture, recording and page paths [text] names, in order, each once. */
    fun pathsIn(text: String): List<String> {
        if (text.isEmpty()) return emptyList()
        val found = LinkedHashMap<Int, String>()
        for (m in quotedPath.findAll(text)) found[m.groups[1]!!.range.first] = m.groupValues[1]
        for (m in barePath.findAll(text)) {
            val start = m.groups[1]!!.range.first
            if (found.keys.none { it <= start && start < it + found.getValue(it).length }) found[start] = m.groupValues[1]
        }
        return found.toSortedMap().values.filterNot { "://" in it }.distinct()
    }

    /** Tools whose words name files by pattern or listing, not ones the agent made or looked at. */
    private val listingTools = setOf("Glob", "Grep", "LS", "ls", "glob", "grep")

    /**
     * What [row] names: an agent's words, or a tool call's input (a file it
     * wrote or read, a command that made one). Results are left out: a
     * listing would flood the strip.
     */
    fun pathsOf(row: ChatRow): List<String> = when (row) {
        is ChatRow.AgentText -> pathsIn(row.message.text)
        is ChatRow.Tool -> pathsOf(row.message)
        else -> emptyList()
    }

    private fun pathsOf(message: ChatMessage.ToolCallMessage): List<String> {
        if (message.tool.name in listingTools) return emptyList()
        val words = buildList { message.tool.input?.let { strings(it, this) } }
        return words.flatMap(::pathsIn).distinct()
    }

    private fun strings(element: JsonElement, into: MutableList<String>) {
        when (element) {
            is JsonPrimitive -> if (element.isString) into += element.content
            is JsonArray -> element.forEach { strings(it, into) }
            is JsonObject -> element.values.forEach { strings(it, into) }
        }
    }

    /** Where [path] of [sessionId] is kept while it is shown, named by both. */
    fun cacheFile(cacheDir: File, sessionId: String, path: String): File {
        val digest = MessageDigest.getInstance("SHA-256").digest("$sessionId\n$path".toByteArray())
        val name = digest.take(12).joinToString("") { "%02x".format(it) }
        val extension = path.substringAfterLast('/').substringAfterLast('.', "bin").lowercase()
        return File(File(cacheDir, DIRECTORY), "$name.$extension")
    }
}

/** How a read from the computer went: done, or why not. */
sealed interface MediaRead {
    data object Done : MediaRead
    data class Failed(val reason: String?) : MediaRead
    data object TooLarge : MediaRead
}

/**
 * [path] of [sessionId] into [sink], [SessionMedia.CHUNK_BYTES] at a time,
 * with [onProgress] (bytes so far, of the whole). Over [maxBytes] stops as
 * [MediaRead.TooLarge]. A CLI that has no chunked read gets one readFile.
 */
suspend fun SessionFileOps.readMedia(
    sessionId: String,
    path: String,
    sink: OutputStream,
    maxBytes: Long,
    onProgress: (Long, Long) -> Unit = { _, _ -> },
): MediaRead {
    var offset = 0L
    while (true) {
        val chunk = try {
            readFileChunk(sessionId, path, offset, SessionMedia.CHUNK_BYTES)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return MediaRead.Failed(e.message)
        }
        if (!chunk.success) {
            if (offset == 0L && chunk.error == SessionMedia.METHOD_NOT_FOUND) return readWhole(sessionId, path, sink, maxBytes, onProgress)
            return MediaRead.Failed(chunk.error)
        }
        val size = chunk.size ?: 0L
        if (size > maxBytes) return MediaRead.TooLarge
        val bytes = Base64.getMimeDecoder().decode(chunk.content.orEmpty())
        sink.write(bytes)
        offset += bytes.size
        onProgress(offset, size)
        if (chunk.eof || bytes.isEmpty()) return MediaRead.Done
    }
}

private suspend fun SessionFileOps.readWhole(sessionId: String, path: String, sink: OutputStream, maxBytes: Long, onProgress: (Long, Long) -> Unit): MediaRead {
    val read = try {
        readFile(sessionId, path)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        return MediaRead.Failed(e.message)
    }
    if (!read.success) return MediaRead.Failed(read.error)
    val bytes = Base64.getMimeDecoder().decode(read.content.orEmpty())
    if (bytes.size > maxBytes) return MediaRead.TooLarge
    sink.write(bytes)
    onProgress(bytes.size.toLong(), bytes.size.toLong())
    return MediaRead.Done
}

/** [path] whole in memory (a picture or a page), or null with why in [onFailure]. */
suspend fun SessionFileOps.readMediaBytes(sessionId: String, path: String, maxBytes: Long = SessionMedia.MAX_PICTURE_BYTES, onFailure: (MediaRead) -> Unit = {}): ByteArray? {
    val out = ByteArrayOutputStream()
    return when (val result = readMedia(sessionId, path, out, maxBytes)) {
        MediaRead.Done -> out.toByteArray()
        else -> {
            onFailure(result)
            null
        }
    }
}

/**
 * [path] into [target] (a recording, too large to hold), written beside it
 * first and moved into place when whole, so a half-read file never plays.
 */
suspend fun SessionFileOps.readMediaToFile(
    sessionId: String,
    path: String,
    target: File,
    maxBytes: Long = SessionMedia.MAX_VIDEO_BYTES,
    onProgress: (Long, Long) -> Unit = { _, _ -> },
): MediaRead {
    target.parentFile?.mkdirs()
    val partial = File(target.parentFile, target.name + ".part")
    val result = try {
        partial.outputStream().buffered().use { readMedia(sessionId, path, it, maxBytes, onProgress) }
    } catch (e: CancellationException) {
        partial.delete()
        throw e
    }
    if (result == MediaRead.Done) {
        if (!partial.renameTo(target)) {
            partial.delete()
            return MediaRead.Failed(null)
        }
    } else {
        partial.delete()
    }
    return result
}
