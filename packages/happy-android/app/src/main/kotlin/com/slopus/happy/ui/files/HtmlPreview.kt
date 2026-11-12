package com.slopus.happy.ui.files

import android.annotation.SuppressLint
import android.content.Intent
import android.content.res.Resources
import android.net.Uri
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.slopus.happy.R
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Prompt
import com.slopus.happy.ui.components.PromptModal
import com.slopus.happy.ui.components.themedWebView
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import java.io.ByteArrayInputStream
import java.net.URI
import java.net.URISyntaxException

object HtmlPreviewTags {
    const val WEB = "file.htmlWeb"
    const val MEMO = "file.memo"
}

/** An HTML file: shown as a page, with its source a tab away. */
fun isHtmlPath(path: String): Boolean = path.substringAfterLast('.', "").lowercase() in setOf("html", "htm")

/**
 * The made-up origin an HTML file is shown under, so its relative links
 * (`style.css`, `img/logo.png`) come back as requests this viewer answers
 * from the computer through the session's readFile. `.invalid` never
 * resolves on the network.
 */
internal const val HTML_ASSET_HOST = "happy-file.invalid"

/** The page's base: the file's folder on the computer, under [HTML_ASSET_HOST]. */
internal fun htmlBaseUrl(filePath: String): String {
    val folder = filePath.substringBeforeLast('/', "").ifEmpty { "" }
    return URI("https", HTML_ASSET_HOST, "$folder/", null).toASCIIString()
}

/**
 * What a page may read from the computer: pictures, fonts, stylesheets,
 * scripts and other pages. Not data (`.json`, `.env`, keys), since the
 * page can also reach the network.
 */
private val assetTypes = mapOf(
    "html" to "text/html", "htm" to "text/html",
    "css" to "text/css",
    "js" to "text/javascript", "mjs" to "text/javascript",
    "png" to "image/png", "jpg" to "image/jpeg", "jpeg" to "image/jpeg", "gif" to "image/gif",
    "webp" to "image/webp", "avif" to "image/avif", "bmp" to "image/bmp", "ico" to "image/x-icon", "svg" to "image/svg+xml",
    "woff" to "font/woff", "woff2" to "font/woff2", "ttf" to "font/ttf", "otf" to "font/otf",
)

/** The type a page asset is served as, by its name. */
internal fun htmlAssetType(path: String): String? = assetTypes[path.substringAfterLast('.', "").lowercase()]

/**
 * The file on the computer a page's request [url] stands for, or null when
 * it is refused: another host, outside [root] (`..` included), anything
 * under a dot-named folder or file, or a type [htmlAssetType] doesn't serve.
 */
internal fun htmlAssetPath(url: String, root: String): String? {
    val uri = try {
        URI(url).normalize()
    } catch (_: URISyntaxException) {
        return null
    }
    if (uri.host != HTML_ASSET_HOST || uri.scheme != "https") return null
    val path = uri.path?.takeIf { it.startsWith("/") } ?: return null
    val segments = path.split('/').filter { it.isNotEmpty() }
    if (segments.any { it.startsWith(".") }) return null
    val top = root.trimEnd('/')
    if (!path.startsWith("$top/")) return null
    return path.takeIf { htmlAssetType(it) != null }
}

/**
 * The message a memo on [filePath] sends the session: the note, the
 * selected words it is about when there are any (cut to 300 characters),
 * and the ask to change the file for it.
 */
internal fun memoMessage(resources: Resources, filePath: String, quote: String?, note: String): String {
    val about = quote?.trim()?.replace(Regex("\\s+"), " ")?.takeIf { it.isNotEmpty() }?.let { if (it.length > 300) it.take(300) + "…" else it }
    return if (about == null) resources.getString(R.string.file_memo_message, filePath, note.trim())
    else resources.getString(R.string.file_memo_message_quoted, filePath, about, note.trim())
}

/**
 * An HTML file shown as a page. Its own files load from the computer
 * through [readAsset] (held to [root] by [htmlAssetPath]); anything else
 * loads from the network, as in a browser; a tapped link off the page
 * opens in one. With [onMemo], a Memo button sends a note about the page,
 * or the words selected on it, for the agent to change the file.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
internal fun HtmlFilePage(
    html: String,
    filePath: String,
    root: String,
    readAsset: (suspend (String) -> ByteArray?)?,
    onMemo: ((quote: String?, note: String) -> Unit)?,
    modifier: Modifier = Modifier,
) {
    var selection by remember(filePath) { mutableStateOf<String?>(null) }
    var writing by remember { mutableStateOf<String?>(null) }
    val read by rememberUpdatedState(readAsset)
    Box(modifier) {
        AndroidView(
            factory = { ctx ->
                themedWebView(ctx, Color.White, dark = false).apply {
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.allowFileAccess = false
                    settings.allowContentAccess = false
                    overScrollMode = View.OVER_SCROLL_NEVER
                    addJavascriptInterface(MemoSelection { text -> post { selection = text.takeIf { it.isNotBlank() } } }, MEMO_BRIDGE)
                    webViewClient = HtmlFileClient(root) { path -> read?.invoke(path) }
                    loadDataWithBaseURL(htmlBaseUrl(filePath), ReadablePage.forPhone(html), "text/html", "utf-8", null)
                    tag = html
                }
            },
            update = { view ->
                if (view.tag != html) {
                    view.tag = html
                    view.loadDataWithBaseURL(htmlBaseUrl(filePath), ReadablePage.forPhone(html), "text/html", "utf-8", null)
                }
            },
            onRelease = { view ->
                view.stopLoading()
                view.destroy()
            },
            modifier = Modifier.fillMaxSize().testTag(HtmlPreviewTags.WEB),
        )
        if (onMemo != null) {
            val label = stringResource(if (selection != null) R.string.file_memo_on_selection else R.string.file_memo)
            Row(
                Modifier
                    .align(Alignment.BottomEnd)
                    .navigationBarsPadding()
                    .padding(16.dp)
                    .clip(RoundedCornerShape(20.dp))
                    .background(Color(0xFF1C1C1E))
                    .clickable(role = Role.Button) { writing = selection.orEmpty() }
                    .testTag(HtmlPreviewTags.MEMO)
                    .padding(horizontal = 14.dp, vertical = 9.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Ionicon.CreateOutline, 16.dp, Color.White)
                Text(label, style = happyTextStyle(fontSize = 14, weight = FontWeight.SemiBold), color = Color.White, modifier = Modifier.padding(start = 6.dp))
            }
        }
    }
    writing?.let { quote ->
        PromptModal(
            Prompt(
                title = stringResource(R.string.file_memo_title),
                message = quote.takeIf { it.isNotEmpty() }?.let { "“${it.take(300)}”" },
                placeholder = stringResource(R.string.file_memo_placeholder),
                confirmText = stringResource(R.string.file_memo_send),
                allowBlank = false,
                onResult = { note -> if (!note.isNullOrBlank()) onMemo?.invoke(quote.ifEmpty { null }, note) },
            ),
            onDismiss = { writing = null },
        )
    }
}

/** The selection messages: one string, kept only as the quote a memo is about. */
private class MemoSelection(private val onSelected: (String) -> Unit) {
    @JavascriptInterface
    fun selected(text: String?) {
        onSelected(text.orEmpty().take(2_000))
    }
}

/**
 * The page's client: its own files read from the computer (GET, held to
 * [root], refused after 10 seconds), a link tapped to anywhere else opened
 * in the browser, and the selection watched once each document loads.
 */
private class HtmlFileClient(private val root: String, private val read: suspend (String) -> ByteArray?) : WebViewClient() {
    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        if (request.url.host != HTML_ASSET_HOST) return null
        val path = htmlAssetPath(request.url.toString(), root)?.takeIf { request.method.equals("GET", ignoreCase = true) } ?: return missing()
        val bytes = runCatching { runBlocking { withTimeoutOrNull(10_000) { read(path) } } }.getOrNull() ?: return missing()
        return WebResourceResponse(htmlAssetType(path), null, ByteArrayInputStream(bytes))
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url
        if (url.host == HTML_ASSET_HOST) return false
        if (request.isForMainFrame && request.hasGesture() && (url.scheme == "https" || url.scheme == "http")) {
            runCatching { view.context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url.toString())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        }
        return true
    }

    override fun onPageFinished(view: WebView, url: String?) {
        view.evaluateJavascript(SELECTION_SCRIPT, null)
    }

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean = true

    private fun missing() = WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
}

private const val MEMO_BRIDGE = "happyMemo"

private val SELECTION_SCRIPT = """
(function () {
  if (window.__happyMemo) return;
  window.__happyMemo = true;
  var timer;
  document.addEventListener('selectionchange', function () {
    clearTimeout(timer);
    timer = setTimeout(function () {
      var text = String(window.getSelection() || '').trim();
      if (window.$MEMO_BRIDGE) window.$MEMO_BRIDGE.selected(text);
    }, 150);
  });
})();
""".trimIndent()
