package com.slopus.happy.ui.server

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.auth.AuthApi.ServerProbe
import com.slopus.happy.config.ServerConfig
import com.slopus.happy.config.ServerHeader
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.HappyTextField
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.RoundButtonDisplay
import com.slopus.happy.ui.components.RoundButtonSize
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.connect.ScanFailure
import com.slopus.happy.ui.connect.ScanRequest
import com.slopus.happy.ui.connect.ScanResult
import com.slopus.happy.ui.connect.ServerLink
import com.slopus.happy.ui.connect.rememberQrScanner
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.AppMono
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.launch

object ServerTags {
    const val FORM = "server.form"
    const val LABEL = "server.label"
    const val INPUT = "server.input"
    const val ERROR = "server.error"
    const val SAVE = "server.save"
    const val RESET = "server.reset"
    const val STATUS = "server.status"
    const val HEADERS_LABEL = "server.headers.label"
    const val HEADERS = "server.headers"
    const val HEADERS_ERROR = "server.headers.error"
    const val SCAN = "server.scan"
}

/** server.tsx */
object ServerSpec {
    val paddingHorizontal = 16.dp
    val paddingVertical = 12.dp
    val labelGap = 8.dp
    val inputPaddingHorizontal = 14.dp
    val inputPaddingVertical = 12.dp
    val inputMinHeight = 44.dp
    val inputRadius = 10.dp
    val inputGap = 8.dp
    val messageGap = 12.dp
    val buttonGap = 4.dp
    val buttonsTop = 4.dp
    val buttonsBottom = 12.dp
    val label = happyTextStyle(fontSize = 12, letterSpacing = 0.5f, weight = FontWeight.SemiBold)
    val input = happyTextStyle(fontSize = 15, family = AppMono)
    val message = happyTextStyle(fontSize = 12)
}

/**
 * Server URL for self-hosters. Save validates the URL's form, then asks the
 * server for its banner, then confirms; Reset goes back to the default. The
 * voice-server section of happy-app is left out with voice.
 *
 * Under the URL, the custom server's extra request headers (a private
 * relay's secret), one `Name: value` per line, their values masked; they go
 * to that server alone ([com.slopus.happy.net.ServerHeaders]) and are saved
 * and reset with the URL. The banner check sends them too. Scan QR code
 * reads a server link ([ServerLink]) into both fields, as [prefill] does for
 * one opened from outside: nothing is saved until Save is confirmed.
 *
 * Spec: one footer-only group holding the form, 16/12 padding. Label 12
 * semibold uppercase (tracking 0.5) 8 above the input; input mono 15,
 * 14/12 padding, at least 44 high, radius 10, 8 below it; error or
 * "validating" line 12, 12 below; the headers' label and field the same,
 * with their own error line; normal-size buttons 4 apart with 4 above
 * and 12 below; status line 12, centred.
 */
@Composable
fun ServerScreen(
    customUrl: String?,
    probe: suspend (String, List<ServerHeader>) -> ServerProbe,
    onSave: (String, List<ServerHeader>) -> Unit,
    onReset: () -> Unit,
    onBack: () -> Unit,
    customHeaders: List<ServerHeader> = emptyList(),
    prefill: ServerLink? = null,
) {
    val colors = HappyTheme.colors
    val scope = rememberCoroutineScope()
    val scanner = rememberQrScanner()
    var input by rememberSaveable { mutableStateOf(prefill?.url ?: customUrl.orEmpty()) }
    var headerInput by rememberSaveable { mutableStateOf(prefill?.headerText ?: ServerHeader.format(customHeaders)) }
    var error by remember { mutableStateOf<String?>(null) }
    var headerError by remember { mutableStateOf<String?>(null) }
    var validating by remember { mutableStateOf(false) }
    var alert by remember { mutableStateOf<Alert?>(null) }

    val strings = ServerStrings(
        error = stringResource(R.string.common_error),
        ok = stringResource(R.string.common_ok),
        cancel = stringResource(R.string.common_cancel),
        continueLabel = stringResource(R.string.common_continue),
        reset = stringResource(R.string.common_reset),
        enterUrl = stringResource(R.string.server_enter_server_url),
        urlEmpty = stringResource(R.string.server_url_empty),
        urlProtocol = stringResource(R.string.server_url_protocol),
        urlInvalid = stringResource(R.string.server_url_invalid),
        serverError = stringResource(R.string.server_server_returned_error),
        notHappy = stringResource(R.string.server_not_valid_happy_server),
        unreachable = stringResource(R.string.server_failed_to_connect_to_server),
        changeServer = stringResource(R.string.server_change_server),
        continueWithServer = stringResource(R.string.server_continue_with_server),
        resetToDefault = stringResource(R.string.server_reset_to_default),
        resetServerDefault = stringResource(R.string.server_reset_server_default),
        headerMalformed = stringResource(R.string.server_header_malformed),
        headerBadName = stringResource(R.string.server_header_bad_name),
        headerBadValue = stringResource(R.string.server_header_bad_value),
        headerForbidden = stringResource(R.string.server_header_forbidden),
        headerTooMany = stringResource(R.string.server_header_too_many),
        notServerCode = stringResource(R.string.scan_not_happy_code),
        scanUnavailable = stringResource(R.string.scan_unavailable),
        scanNoCamera = stringResource(R.string.scan_no_camera),
        scanCameraFailed = stringResource(R.string.scan_camera_failed),
    )

    fun save() {
        val url = input
        if (url.isBlank()) {
            alert = Alert(strings.error, strings.enterUrl, listOf(AlertButton(strings.ok)))
            return
        }
        val headers = when (val parsed = ServerHeader.parse(headerInput)) {
            is ServerHeader.Parse.Valid -> parsed.headers.also { headerError = null }
            is ServerHeader.Parse.Invalid -> {
                headerError = strings.header(parsed)
                return
            }
        }
        when (ServerConfig.validate(url)) {
            ServerConfig.Validation.Empty -> error = strings.urlEmpty
            ServerConfig.Validation.NotHttp -> error = strings.urlProtocol
            ServerConfig.Validation.Malformed -> error = strings.urlInvalid
            ServerConfig.Validation.Valid -> scope.launch {
                validating = true
                error = null
                val result = probe(url, headers)
                validating = false
                error = when (result) {
                    ServerProbe.HappyServer -> null
                    ServerProbe.NotHappyServer -> strings.notHappy
                    ServerProbe.ServerError -> strings.serverError
                    ServerProbe.Unreachable -> strings.unreachable
                }
                if (result == ServerProbe.HappyServer) {
                    alert = Alert(
                        strings.changeServer,
                        strings.continueWithServer,
                        listOf(AlertButton(strings.cancel), AlertButton(strings.continueLabel, destructive = true) { onSave(url, headers) }),
                        // Modal.confirm: only a button answers it.
                        cancelable = false,
                    )
                }
            }
        }
    }

    fun reset() {
        alert = Alert(
            strings.resetToDefault,
            strings.resetServerDefault,
            listOf(
                AlertButton(strings.cancel),
                AlertButton(strings.reset, destructive = true) {
                    onReset()
                    input = ""
                    headerInput = ""
                    headerError = null
                },
            ),
            cancelable = false,
        )
    }

    var scanning by remember { mutableStateOf(false) }
    fun scan() {
        if (scanning) return
        scanning = true
        scope.launch {
            try {
                when (val result = scanner.scan(ScanRequest())) {
                    is ScanResult.Scanned -> {
                        val link = ServerLink.parse(result.value)?.takeIf { it.fillsIn }
                        if (link == null) {
                            alert = Alert(strings.error, strings.notServerCode, listOf(AlertButton(strings.ok)))
                        } else {
                            // Fills in, never saves: Save and its confirm still decide.
                            link.url?.let { input = it }
                            link.headerText?.let { headerInput = it }
                            error = null
                            headerError = null
                        }
                    }
                    is ScanResult.Failed -> alert = Alert(strings.error, strings.failure(result.reason), listOf(AlertButton(strings.ok)))
                    ScanResult.Cancelled, is ScanResult.Chose -> Unit
                }
            } finally {
                scanning = false
            }
        }
    }

    Screen(header = { StackHeader(stringResource(R.string.server_title), onBack) }, avoidKeyboard = true) {
        ItemList {
            ItemGroup(footer = stringResource(R.string.server_self_host_footer)) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = ServerSpec.paddingHorizontal, vertical = ServerSpec.paddingVertical)
                        .testTag(ServerTags.FORM),
                ) {
                    Text(
                        text = stringResource(R.string.server_server_url_label).uppercase(),
                        style = ServerSpec.label,
                        color = colors.textSecondary,
                        modifier = Modifier.padding(bottom = ServerSpec.labelGap).testTag(ServerTags.LABEL),
                    )
                    HappyTextField(
                        value = input,
                        onValueChange = {
                            input = it
                            error = null
                        },
                        placeholder = stringResource(R.string.common_url_placeholder),
                        textStyle = ServerSpec.input,
                        contentPadding = PaddingValues(
                            horizontal = ServerSpec.inputPaddingHorizontal,
                            vertical = ServerSpec.inputPaddingVertical,
                        ),
                        minHeight = ServerSpec.inputMinHeight,
                        cornerRadius = ServerSpec.inputRadius,
                        singleLine = true,
                        enabled = !validating,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
                        modifier = Modifier
                            .padding(bottom = ServerSpec.inputGap)
                            .alpha(if (validating) 0.6f else 1f)
                            .testTag(ServerTags.INPUT),
                    )
                    error?.let {
                        Text(
                            text = it,
                            style = ServerSpec.message,
                            color = colors.textDestructive,
                            modifier = Modifier.padding(bottom = ServerSpec.messageGap).testTag(ServerTags.ERROR),
                        )
                    }
                    if (validating) {
                        Text(
                            text = stringResource(R.string.server_validating_server),
                            style = ServerSpec.message,
                            color = colors.status.connecting,
                            modifier = Modifier.padding(bottom = ServerSpec.messageGap),
                        )
                    }
                    Text(
                        text = stringResource(R.string.server_headers_label).uppercase(),
                        style = ServerSpec.label,
                        color = colors.textSecondary,
                        modifier = Modifier.padding(bottom = ServerSpec.labelGap).testTag(ServerTags.HEADERS_LABEL),
                    )
                    HappyTextField(
                        value = headerInput,
                        onValueChange = {
                            headerInput = it
                            headerError = null
                        },
                        placeholder = stringResource(R.string.server_headers_placeholder),
                        textStyle = ServerSpec.input,
                        contentPadding = PaddingValues(
                            horizontal = ServerSpec.inputPaddingHorizontal,
                            vertical = ServerSpec.inputPaddingVertical,
                        ),
                        minHeight = ServerSpec.inputMinHeight,
                        cornerRadius = ServerSpec.inputRadius,
                        singleLine = false,
                        enabled = !validating,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, autoCorrectEnabled = false),
                        visualTransformation = MaskHeaderValues,
                        modifier = Modifier
                            .padding(bottom = ServerSpec.inputGap)
                            .alpha(if (validating) 0.6f else 1f)
                            .testTag(ServerTags.HEADERS),
                    )
                    headerError?.let {
                        Text(
                            text = it,
                            style = ServerSpec.message,
                            color = colors.textDestructive,
                            modifier = Modifier.padding(bottom = ServerSpec.messageGap).testTag(ServerTags.HEADERS_ERROR),
                        )
                    }
                    Column(
                        modifier = Modifier.padding(top = ServerSpec.buttonsTop, bottom = ServerSpec.buttonsBottom),
                        verticalArrangement = Arrangement.spacedBy(ServerSpec.buttonGap),
                    ) {
                        RoundButton(
                            title = stringResource(if (validating) R.string.server_validating else R.string.common_save),
                            onClick = ::save,
                            size = RoundButtonSize.Normal,
                            enabled = !validating,
                            modifier = Modifier.testTag(ServerTags.SAVE),
                        )
                        RoundButton(
                            title = stringResource(R.string.server_scan_qr),
                            onClick = ::scan,
                            size = RoundButtonSize.Normal,
                            display = RoundButtonDisplay.Inverted,
                            enabled = !validating,
                            modifier = Modifier.testTag(ServerTags.SCAN),
                        )
                        if (customUrl != null) {
                            RoundButton(
                                title = strings.resetToDefault,
                                onClick = ::reset,
                                size = RoundButtonSize.Normal,
                                display = RoundButtonDisplay.Inverted,
                                modifier = Modifier.testTag(ServerTags.RESET),
                            )
                        }
                    }
                    if (customUrl != null) {
                        Text(
                            text = stringResource(R.string.server_currently_using_custom_server),
                            style = ServerSpec.message,
                            color = colors.textSecondary,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth().testTag(ServerTags.STATUS),
                        )
                    }
                }
            }
        }
    }

    alert?.let { HappyAlert(alert = it, onDismiss = { alert = null }) }
}

/**
 * The headers field with each value hidden: every character after a line's
 * first colon reads as a dot. Same length, so the cursor maps one to one.
 */
internal object MaskHeaderValues : VisualTransformation {
    fun mask(text: String): String {
        val out = StringBuilder(text.length)
        var masking = false
        for (char in text) {
            when {
                char == '\n' || char == '\r' -> {
                    masking = false
                    out.append(char)
                }
                masking && char != ' ' -> out.append('•')
                else -> {
                    if (char == ':') masking = true
                    out.append(char)
                }
            }
        }
        return out.toString()
    }

    override fun filter(text: AnnotatedString): TransformedText =
        TransformedText(AnnotatedString(mask(text.text)), OffsetMapping.Identity)
}

private class ServerStrings(
    val error: String,
    val ok: String,
    val cancel: String,
    val continueLabel: String,
    val reset: String,
    val enterUrl: String,
    val urlEmpty: String,
    val urlProtocol: String,
    val urlInvalid: String,
    val serverError: String,
    val notHappy: String,
    val unreachable: String,
    val changeServer: String,
    val continueWithServer: String,
    val resetToDefault: String,
    val resetServerDefault: String,
    val headerMalformed: String,
    val headerBadName: String,
    val headerBadValue: String,
    val headerForbidden: String,
    val headerTooMany: String,
    val notServerCode: String,
    val scanUnavailable: String,
    val scanNoCamera: String,
    val scanCameraFailed: String,
) {
    /** The headers field's first bad line, in words. */
    fun header(invalid: ServerHeader.Parse.Invalid): String = when (invalid.problem) {
        ServerHeader.Problem.Malformed -> headerMalformed.format(invalid.line)
        ServerHeader.Problem.BadName -> headerBadName.format(invalid.line)
        ServerHeader.Problem.BadValue -> headerBadValue.format(invalid.line)
        ServerHeader.Problem.Forbidden -> headerForbidden.format(invalid.line)
        ServerHeader.Problem.TooMany -> headerTooMany.format(ServerHeader.MAX_HEADERS)
    }

    fun failure(reason: ScanFailure): String = when (reason) {
        ScanFailure.NoCamera -> scanNoCamera
        ScanFailure.CameraFailed -> scanCameraFailed
        ScanFailure.Unavailable -> scanUnavailable
    }
}
