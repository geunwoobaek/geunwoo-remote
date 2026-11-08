package com.slopus.happy.ui.files

import android.widget.MediaController
import android.widget.VideoView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.FileProvider
import java.io.File

/**
 * A recording read into the cache ([SessionMedia]), played by the
 * platform's player on black with its own controls, looping. It is handed
 * to the player through the app's file provider (the media server can't
 * open the app's private cache by path).
 */
@Composable
fun VideoFile(file: File, name: String, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val uri = remember(file) { FileProvider.getUriForFile(context, "${context.packageName}.conversation.media", file) }
    Box(modifier.background(Color.Black), contentAlignment = Alignment.Center) {
        AndroidView(
            factory = { ctx ->
                VideoView(ctx).apply {
                    contentDescription = name
                    val controls = MediaController(ctx)
                    controls.setAnchorView(this)
                    setMediaController(controls)
                    setOnPreparedListener { player ->
                        player.isLooping = true
                        start()
                        controls.show(3_000)
                    }
                    setVideoURI(uri)
                }
            },
            onRelease = { it.stopPlayback() },
            modifier = Modifier.fillMaxWidth().testTag(FileTags.VIDEO),
        )
    }
}
