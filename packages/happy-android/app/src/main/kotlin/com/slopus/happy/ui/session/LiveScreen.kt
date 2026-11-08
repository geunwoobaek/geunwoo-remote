package com.slopus.happy.ui.session

import android.content.Context
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.slopus.happy.R
import com.slopus.happy.sync.ScreenFrameResult
import com.slopus.happy.sync.ScreenStreamResult
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import livekit.org.webrtc.DataChannel
import livekit.org.webrtc.DefaultVideoDecoderFactory
import livekit.org.webrtc.EglBase
import livekit.org.webrtc.IceCandidate
import livekit.org.webrtc.MediaConstraints
import livekit.org.webrtc.MediaStream
import livekit.org.webrtc.MediaStreamTrack
import livekit.org.webrtc.PeerConnection
import livekit.org.webrtc.PeerConnectionFactory
import livekit.org.webrtc.RendererCommon
import livekit.org.webrtc.RtpReceiver
import livekit.org.webrtc.RtpTransceiver
import livekit.org.webrtc.SdpObserver
import livekit.org.webrtc.SessionDescription
import livekit.org.webrtc.SurfaceViewRenderer
import livekit.org.webrtc.VideoTrack
import java.util.Base64

/** The width-to-height shape of a live frame, or null before one has a size. */
internal fun liveVideoAspect(width: Int, height: Int): Float? =
    if (width > 0 && height > 0) width.toFloat() / height else null

/** What the live screen asks of the session's computer (happy-cli `screenStreamStart` / `screenStreamStop` / `screenFrame`). */
interface LiveScreenOps {
    suspend fun screenStreamStart(sessionId: String, sdp: String, maxWidth: Int, fps: Int): ScreenStreamResult
    suspend fun screenStreamStop(sessionId: String, id: String?)
    suspend fun screenFrame(sessionId: String, maxWidth: Int): ScreenFrameResult
}

/** Sync's session ops. */
class SyncLiveScreenOps(private val account: com.slopus.happy.sync.AccountSync) : LiveScreenOps {
    override suspend fun screenStreamStart(sessionId: String, sdp: String, maxWidth: Int, fps: Int) = account.sessionOps.screenStreamStart(sessionId, sdp, maxWidth, fps)
    override suspend fun screenStreamStop(sessionId: String, id: String?) = account.sessionOps.screenStreamStop(sessionId, id)
    override suspend fun screenFrame(sessionId: String, maxWidth: Int) = account.sessionOps.screenFrame(sessionId, maxWidth)
}

/** How the screen is coming: connecting, peer to peer, as relayed stills, or not at all. */
sealed interface LiveMode {
    data object Connecting : LiveMode
    data object Direct : LiveMode
    data object Relay : LiveMode
    data class Failed(val reason: String?) : LiveMode
}

object LiveScreenSpec {
    const val MAX_WIDTH = 1280
    const val FPS = 15
    const val FRAME_WIDTH = 960

    /** No direct connection by then (a strict NAT, no TURN relay): stills through the relay instead. */
    const val DIRECT_TIMEOUT_MS = 10_000L
    const val FRAME_INTERVAL_MS = 1_000L
    const val GATHER_TIMEOUT_MS = 5_000L
}

object LiveScreenTags {
    const val SCREEN = "liveScreen"
    const val VIDEO = "liveScreen.video"
    const val FRAME = "liveScreen.frame"
    const val STATUS = "liveScreen.status"
    const val CLOSE = "liveScreen.close"
}

/**
 * Stills of the screen through the relay, one per [intervalMillis], until
 * cancelled. A failed still is skipped; [maxFailures] in a row ends it.
 */
suspend fun pollScreenFrames(
    ops: LiveScreenOps,
    sessionId: String,
    onFrame: (ByteArray) -> Unit,
    intervalMillis: Long = LiveScreenSpec.FRAME_INTERVAL_MS,
    maxFailures: Int = 5,
): String? {
    var failures = 0
    var last: String? = null
    while (true) {
        val frame = try {
            ops.screenFrame(sessionId, LiveScreenSpec.FRAME_WIDTH)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            ScreenFrameResult(false, error = e.message)
        }
        val bytes = frame.content?.takeIf { frame.success }?.let { runCatching { Base64.getMimeDecoder().decode(it) }.getOrNull() }
        if (bytes != null) {
            failures = 0
            onFrame(bytes)
        } else {
            last = frame.error
            if (++failures >= maxFailures) return last
        }
        delay(intervalMillis)
    }
}

private class LoggingSdp(private val result: CompletableDeferred<SessionDescription?>) : SdpObserver {
    override fun onCreateSuccess(description: SessionDescription) {
        result.complete(description)
    }
    override fun onSetSuccess() {
        result.complete(null)
    }
    override fun onCreateFailure(error: String?) {
        result.completeExceptionally(IllegalStateException(error ?: "createOffer failed"))
    }
    override fun onSetFailure(error: String?) {
        result.completeExceptionally(IllegalStateException(error ?: "setDescription failed"))
    }
}

/**
 * The receiving side of the live screen: a receive-only peer connection
 * whose offer goes to the computer as a session RPC (through the encrypted
 * relay) and whose video comes straight from it, DTLS-SRTP encrypted. The
 * offer carries every candidate (no trickling), so one RPC sets it up.
 */
private class LiveScreenPeer(context: Context, val egl: EglBase) {
    private val factory: PeerConnectionFactory
    val connected = CompletableDeferred<Unit>()
    val gathered = CompletableDeferred<Unit>()
    var onVideo: ((VideoTrack) -> Unit)? = null
    var onFailed: (() -> Unit)? = null
    val pc: PeerConnection

    init {
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context.applicationContext).createInitializationOptions())
        factory = PeerConnectionFactory.builder()
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
            .createPeerConnectionFactory()
        val config = PeerConnection.RTCConfiguration(listOf(PeerConnection.IceServer.builder(STUN).createIceServer())).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        pc = factory.createPeerConnection(config, object : PeerConnection.Observer {
            override fun onSignalingChange(state: PeerConnection.SignalingState?) = Unit
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) = Unit
            override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {
                if (state == PeerConnection.IceGatheringState.COMPLETE) gathered.complete(Unit)
            }
            override fun onIceCandidate(candidate: IceCandidate?) = Unit
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) = Unit
            override fun onAddStream(stream: MediaStream?) = Unit
            override fun onRemoveStream(stream: MediaStream?) = Unit
            override fun onDataChannel(channel: DataChannel?) = Unit
            override fun onRenegotiationNeeded() = Unit
            override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) {
                (receiver?.track() as? VideoTrack)?.let { onVideo?.invoke(it) }
            }
            override fun onConnectionChange(state: PeerConnection.PeerConnectionState?) {
                when (state) {
                    PeerConnection.PeerConnectionState.CONNECTED -> connected.complete(Unit)
                    PeerConnection.PeerConnectionState.FAILED, PeerConnection.PeerConnectionState.CLOSED -> onFailed?.invoke()
                    else -> Unit
                }
            }
        }) ?: error("No peer connection")
        pc.addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.RECV_ONLY))
    }

    /** The offer with its candidates gathered (or what is gathered by the time limit). */
    suspend fun offer(): String {
        val created = CompletableDeferred<SessionDescription?>()
        pc.createOffer(LoggingSdp(created), MediaConstraints())
        val offer = created.await() ?: error("No offer")
        val set = CompletableDeferred<SessionDescription?>()
        pc.setLocalDescription(LoggingSdp(set), offer)
        set.await()
        withTimeoutOrNull(LiveScreenSpec.GATHER_TIMEOUT_MS) { gathered.await() }
        return pc.localDescription?.description ?: offer.description
    }

    suspend fun answer(sdp: String) {
        val set = CompletableDeferred<SessionDescription?>()
        pc.setRemoteDescription(LoggingSdp(set), SessionDescription(SessionDescription.Type.ANSWER, sdp))
        set.await()
    }

    fun release() {
        runCatching { pc.dispose() }
        runCatching { factory.dispose() }
    }

    companion object {
        const val STUN = "stun:stun.l.google.com:19302"
    }
}

/**
 * The computer's screen, live, full screen: peer to peer when a direct
 * connection forms within [LiveScreenSpec.DIRECT_TIMEOUT_MS], otherwise
 * about one still a second through the relay. Closing ends the stream on
 * the computer (which also ends it on its own if the phone goes away).
 */
@Composable
fun LiveScreenDialog(ops: LiveScreenOps, sessionId: String, onDismiss: () -> Unit) {
    val context = LocalContext.current
    var mode by remember { mutableStateOf<LiveMode>(LiveMode.Connecting) }
    var frame by remember { mutableStateOf<ImageBitmap?>(null) }
    val egl = remember { EglBase.create() }
    // The renderer crops to whatever box it is given, so the box takes the frame's shape.
    var videoAspect by remember { mutableStateOf<Float?>(null) }
    val renderer = remember {
        SurfaceViewRenderer(context).apply {
            init(egl.eglBaseContext, object : RendererCommon.RendererEvents {
                override fun onFirstFrameRendered() = Unit
                override fun onFrameResolutionChanged(width: Int, height: Int, rotation: Int) {
                    val turned = rotation % 180 != 0
                    val aspect = liveVideoAspect(if (turned) height else width, if (turned) width else height)
                    post { videoAspect = aspect }
                }
            })
            setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
            setEnableHardwareScaler(true)
        }
    }
    val latestDismiss by rememberUpdatedState(onDismiss)

    LaunchedEffect(sessionId) {
        var peer: LiveScreenPeer? = null
        var streamId: String? = null
        try {
            val live = LiveScreenPeer(context, egl)
            peer = live
            val track = CompletableDeferred<VideoTrack>()
            live.onVideo = { track.complete(it) }
            val offer = live.offer()
            val started = ops.screenStreamStart(sessionId, offer, LiveScreenSpec.MAX_WIDTH, LiveScreenSpec.FPS)
            streamId = started.id
            val answer = started.sdp
            if (started.success && answer != null) {
                live.answer(answer)
                val direct = withTimeoutOrNull(LiveScreenSpec.DIRECT_TIMEOUT_MS) { live.connected.await() } != null
                if (direct) {
                    // Unified plan reports the track on the transceiver even when onAddTrack came first.
                    val video = track.takeIf { it.isCompleted }?.await()
                        ?: live.pc.transceivers.firstNotNullOfOrNull { it.receiver.track() as? VideoTrack }
                    video?.addSink(renderer)
                    mode = LiveMode.Direct
                    CompletableDeferred<Unit>().also { done -> live.onFailed = { done.complete(Unit) } }.await()
                }
            }
            // No direct connection (or it dropped): stills through the relay.
            streamId?.let { ops.screenStreamStop(sessionId, it) }
            streamId = null
            live.release()
            peer = null
            mode = LiveMode.Relay
            val reason = pollScreenFrames(ops, sessionId, onFrame = { bytes ->
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.let { frame = it.asImageBitmap() }
            })
            mode = LiveMode.Failed(reason ?: started.error)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            mode = LiveMode.Failed(e.message)
        } finally {
            withContext(NonCancellable) {
                streamId?.let { runCatching { ops.screenStreamStop(sessionId, it) } }
                peer?.release()
            }
        }
    }
    DisposableEffect(Unit) {
        onDispose {
            renderer.release()
            egl.release()
        }
    }

    Dialog(onDismissRequest = { latestDismiss() }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black).testTag(LiveScreenTags.SCREEN)) {
            when (mode) {
                LiveMode.Direct -> AndroidView(
                    factory = { renderer },
                    modifier = Modifier.align(Alignment.Center)
                        .then(videoAspect?.let { Modifier.aspectRatio(it) } ?: Modifier.fillMaxSize())
                        .testTag(LiveScreenTags.VIDEO),
                )
                LiveMode.Relay -> frame?.let {
                    Image(it, contentDescription = null, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize().testTag(LiveScreenTags.FRAME))
                }
                else -> Unit
            }
            Row(
                Modifier.fillMaxWidth().statusBarsPadding().background(Color(0x99000000)).padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                val close = stringResource(R.string.session_live_close)
                IconButton(onClick = { latestDismiss() }, modifier = Modifier.testTag(LiveScreenTags.CLOSE).semantics { contentDescription = close }) {
                    Icon(Ionicon.Close, 24.dp, Color.White)
                }
                if (mode == LiveMode.Connecting) CircularProgressIndicator(Modifier.size(16.dp), color = Color.White, strokeWidth = 2.dp)
                val status = when (val m = mode) {
                    LiveMode.Connecting -> stringResource(R.string.session_live_connecting)
                    LiveMode.Direct -> stringResource(R.string.session_live_direct)
                    LiveMode.Relay -> stringResource(R.string.session_live_relay)
                    is LiveMode.Failed -> listOfNotNull(stringResource(R.string.session_live_failed), m.reason).joinToString(" · ")
                }
                Text(status, style = happyTextStyle(fontSize = 14), color = Color.White, modifier = Modifier.testTag(LiveScreenTags.STATUS))
            }
        }
    }
}
