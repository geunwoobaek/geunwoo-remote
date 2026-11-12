package com.slopus.happy.ui.files

/**
 * Makes an HTML file the agent wrote readable on a phone.
 *
 * A body fragment (no `<html>`, `<head>` or `<body>`, meant to be assembled
 * into a page later) gets a reading stylesheet in front of it, so its own
 * styles still win. A whole page only gets the mobile viewport when it lacks
 * one. A fragment whose assembled page sits beside it ([finishedPath]) is
 * shown as that page when the page holds the fragment unchanged.
 */
object ReadablePage {
    private val documentTag = Regex("<(html|head|body)[\\s>/]", RegexOption.IGNORE_CASE)
    private val viewport = Regex("<meta[^>]+name\\s*=\\s*[\"']?viewport", RegexOption.IGNORE_CASE)
    private val headOpen = Regex("<head\\b[^>]*>", RegexOption.IGNORE_CASE)
    private val htmlOpen = Regex("<html\\b[^>]*>", RegexOption.IGNORE_CASE)

    const val VIEWPORT = "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"

    /**
     * The stylesheet a fragment is read with: margins, Korean-friendly line
     * breaks, wide tables and code that scroll on their own, and diagrams
     * whose colours come from the missing page stylesheet (`var(--node)`)
     * drawn light with outlines instead of solid black.
     */
    const val READING_CSS = """
html{-webkit-text-size-adjust:100%}
body{margin:0;padding:20px 18px 96px;font:17px/1.7 system-ui,-apple-system,"Noto Sans KR",sans-serif;color:#1f2328;background:#fff;word-break:keep-all;overflow-wrap:break-word}
h1{font-size:1.55em;line-height:1.3;margin:.2em 0 .7em}
h2{font-size:1.28em;line-height:1.35;margin:1.7em 0 .5em}
h3{font-size:1.1em;line-height:1.4;margin:1.4em 0 .4em}
p,ul,ol,dl,blockquote,table,pre,figure{margin:0 0 1em}
ul,ol{padding-left:1.3em}
li{margin:.3em 0}
a{color:#0969da}
img,video{max-width:100%;height:auto}
table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse;font-size:.92em;line-height:1.5}
th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left;vertical-align:top}
th{background:#f6f8fa}
pre{overflow-x:auto;background:#f6f8fa;padding:12px;border-radius:8px;font-size:.85em;line-height:1.5}
code{font-family:ui-monospace,Menlo,monospace;font-size:.9em;background:#f6f8fa;padding:.1em .3em;border-radius:4px}
pre code{background:none;padding:0}
blockquote{border-left:4px solid #d0d7de;padding:.2em 1em;color:#57606a}
hr{border:0;border-top:1px solid #d0d7de;margin:1.6em 0}
svg{fill:#eef1f4;stroke:#8c959f}
svg text{fill:#1f2328;stroke:none}
"""

    /**
     * Keeps a fragment as wide as the phone: anything wider (a diagram held
     * to `min-width` by a stylesheet the fragment doesn't carry) scrolls
     * sideways inside the nearest box that still fits, instead of widening
     * the whole page. Run once the page and again once its pictures load.
     */
    const val FIT_SCRIPT = """
(function(){function fit(){var w=document.documentElement.clientWidth;var all=document.body?document.body.getElementsByTagName('*'):[];for(var i=0;i<all.length;i++){var e=all[i],p=e.parentElement;if(!p||p===document.body||e.getBoundingClientRect().width<=w)continue;while(p&&p!==document.body&&p.getBoundingClientRect().width>w)p=p.parentElement;if(p&&p!==document.body){p.style.overflowX='auto';p.style.maxWidth='100%'}}}
document.addEventListener('DOMContentLoaded',fit);window.addEventListener('load',fit)})();
"""

    /** Whether [html] is a body fragment rather than a whole page. */
    fun isFragment(html: String): Boolean = !documentTag.containsMatchIn(html)

    /** [html] as the phone should load it: see [ReadablePage]. */
    fun forPhone(html: String): String = when {
        isFragment(html) -> "<!doctype html><html><head><meta charset=\"utf-8\">$VIEWPORT<style>$READING_CSS</style><script>$FIT_SCRIPT</script></head><body>\n$html\n</body></html>"
        viewport.containsMatchIn(html) -> html
        else -> headOpen.find(html)?.let { html.replaceRange(it.range.last + 1, it.range.last + 1, VIEWPORT) }
            ?: htmlOpen.find(html)?.let { html.replaceRange(it.range.last + 1, it.range.last + 1, "<head>$VIEWPORT</head>") }
            ?: VIEWPORT + html
    }

    /** Where the page assembled from the fragment at [path] would be: `folder/folder.html`; null for a page not in a folder or already that page. */
    fun finishedPath(path: String): String? {
        if (!isHtmlPath(path)) return null
        val folder = path.substringBeforeLast('/', "").takeIf { it.isNotEmpty() } ?: return null
        val name = folder.substringAfterLast('/').takeIf { it.isNotEmpty() } ?: return null
        return "$folder/$name.html".takeIf { it != path }
    }

    /** Whether [finished] is a whole page that holds the fragment [fragment] unchanged. */
    fun holds(finished: String, fragment: String): Boolean {
        val body = fragment.trim()
        return body.isNotEmpty() && !isFragment(finished) && finished.contains(body)
    }

    /** `folder/name` for [path], the name alone when it has no folder. */
    fun shortName(path: String): String {
        val name = path.substringAfterLast('/').ifEmpty { path }
        val folder = path.substringBeforeLast('/', "").substringAfterLast('/')
        return if (folder.isEmpty()) name else "$folder/$name"
    }
}
