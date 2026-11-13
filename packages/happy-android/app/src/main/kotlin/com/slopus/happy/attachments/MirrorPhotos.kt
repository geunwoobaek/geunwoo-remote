package com.slopus.happy.attachments

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import com.slopus.happy.sync.SessionOps
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.text.SimpleDateFormat
import java.util.Base64
import java.util.Date
import java.util.Locale

/**
 * Photos for a Mac background session's mirror. Such a session takes only
 * text (the Claude Code session it mirrors reads no uploads), so a picked
 * photo is saved into the session's folder on the computer, under
 * [FOLDER] (kept out of git by its own `.gitignore`), and the message names
 * it: `Photo: <path>` lines ahead of the text, which the agent opens with
 * its own file tools.
 */
object MirrorPhotos {
    /** The folder, in the session's working directory, photos are saved to. */
    const val FOLDER = ".jarvis-photos"

    /** A saved photo's longest side, in pixels. */
    const val LONG_EDGE = 2048

    /** The most one photo may weigh: one file write is one relay message. */
    const val MAX_BYTES = 3 * 1024 * 1024

    /** The JPEG qualities tried in turn until a photo fits [MAX_BYTES]. */
    val QUALITIES = listOf(85, 70, 55)

    /** The shell command that makes [FOLDER] and its `.gitignore`, run in the session's folder. */
    const val PREPARE = "mkdir -p $FOLDER && { [ -e $FOLDER/.gitignore ] || printf '*\\n' > $FOLDER/.gitignore; }"

    /** The message: one `Photo:` line per saved path, then a blank line and [text] when there is any. */
    fun message(paths: List<String>, text: String): String {
        if (paths.isEmpty()) return text
        val lines = paths.joinToString("\n") { "Photo: $it" }
        return if (text.isBlank()) lines else "$lines\n\n$text"
    }

    /** Where photo [index] of a send at [now] is saved, in [root]: by the time, and [id] so two never meet. */
    fun pathFor(root: String, now: Date, index: Int, id: String): String {
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(now)
        val tag = id.filter { it.isLetterOrDigit() }.take(8).ifEmpty { "photo" }
        return "${root.trimEnd('/')}/$FOLDER/$stamp-${index + 1}-$tag.jpg"
    }

    /** The size [width]×[height] is drawn at so its longest side is at most [LONG_EDGE]. */
    fun fitted(width: Int, height: Int): Pair<Int, Int> {
        val longest = maxOf(width, height)
        if (longest <= LONG_EDGE || longest <= 0) return width to height
        val scale = LONG_EDGE.toDouble() / longest
        return maxOf(1, Math.round(width * scale).toInt()) to maxOf(1, Math.round(height * scale).toInt())
    }
}

/** What saving a send's photos came to: the paths on the computer, and how many could not be saved. */
data class MirrorPhotoResult(val paths: List<String>, val failed: Int)

/**
 * Saves [images] into [root]/[MirrorPhotos.FOLDER] on the computer: the
 * folder is made by [prepare], each photo [shrink]s to fit and [write]s as
 * a new file. A photo that can't be read, shrunk or written counts as failed.
 */
suspend fun saveMirrorPhotos(
    root: String,
    images: List<AttachmentPreview>,
    now: Date = Date(),
    prepare: suspend () -> Boolean,
    shrink: suspend (AttachmentPreview) -> ByteArray?,
    write: suspend (path: String, base64: String) -> Boolean,
): MirrorPhotoResult {
    if (images.isEmpty()) return MirrorPhotoResult(emptyList(), 0)
    if (!root.startsWith("/") || guard { prepare() } != true) return MirrorPhotoResult(emptyList(), images.size)
    val paths = mutableListOf<String>()
    images.forEachIndexed { index, image ->
        val bytes = guard { shrink(image) }
        val path = MirrorPhotos.pathFor(root, now, index, image.id)
        if (bytes != null && guard { write(path, Base64.getEncoder().encodeToString(bytes)) } == true) paths += path
    }
    return MirrorPhotoResult(paths, images.size - paths.size)
}

/** [saveMirrorPhotos] through the session's shell and file writes. */
suspend fun SessionOps.saveMirrorPhotos(sessionId: String, root: String, images: List<AttachmentPreview>): MirrorPhotoResult =
    saveMirrorPhotos(
        root = root,
        images = images,
        prepare = { bash(sessionId, MirrorPhotos.PREPARE, cwd = root, timeoutMs = 15_000).let { it.success && it.exitCode == 0 } },
        shrink = ::shrinkMirrorPhoto,
        write = { path, base64 -> writeFile(sessionId, path, base64, expectedHash = null).success },
    )

/** A picked photo as a JPEG at most [MirrorPhotos.LONG_EDGE] on its long side and [MirrorPhotos.MAX_BYTES]; null when it can't be. */
suspend fun shrinkMirrorPhoto(image: AttachmentPreview): ByteArray? = withContext(Dispatchers.IO) {
    val file = Uri.parse(image.uri).path ?: return@withContext null
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return@withContext null
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= MirrorPhotos.LONG_EDGE) sample *= 2
    val decoded = BitmapFactory.decodeFile(file, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return@withContext null
    val (w, h) = MirrorPhotos.fitted(decoded.width, decoded.height)
    val bitmap = if (w == decoded.width && h == decoded.height) decoded else Bitmap.createScaledBitmap(decoded, w, h, true)
    try {
        MirrorPhotos.QUALITIES.firstNotNullOfOrNull { quality ->
            ByteArrayOutputStream().use { out ->
                bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)
                out.toByteArray().takeIf { it.size <= MirrorPhotos.MAX_BYTES }
            }
        }
    } finally {
        if (bitmap !== decoded) bitmap.recycle()
        decoded.recycle()
    }
}

private inline fun <T> guard(block: () -> T): T? = try {
    block()
} catch (e: CancellationException) {
    throw e
} catch (_: Exception) {
    null
}
