package com.slopus.happy.ui.components

import android.content.Context
import android.view.ViewGroup
import android.webkit.WebView
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import com.slopus.happy.ui.theme.withNightMode

/**
 * A WebView in the app's theme from its first frame, not WebView's white.
 * Its context has the app's night mode ([withNightMode]), which a page sees
 * as `prefers-color-scheme`; [prepare] runs before anything else touches it
 * (a profile is fixed at first use); [background] shows until the page
 * paints, and wherever a page leaves its own background transparent.
 */
fun themedWebView(context: Context, background: Color, dark: Boolean, prepare: WebView.() -> Unit = {}): WebView =
    WebView(context.withNightMode(dark)).apply {
        prepare()
        setBackgroundColor(background.toArgb())
    }

/**
 * The layout a WebView that fills its box needs, so the page's viewport is
 * the box. Compose's AndroidView otherwise hands a view WRAP_CONTENT, which
 * WebView takes as "size to the content": the viewport height becomes 0, so
 * `100vh` is 0 and every height media query is wrong (a game asked a portrait
 * phone to turn to portrait, since `(orientation: landscape)` and
 * `(max-height: 500px)` both held). A view sized from the height its page
 * measures (an inline artifact, a diagram) keeps WRAP_CONTENT: given its
 * box's height, a `100vh` page would measure the box and only ever grow.
 */
fun pageLayoutParams(): ViewGroup.LayoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
