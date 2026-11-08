package com.slopus.happy.auth

import com.slopus.happy.crypto.AccountEncryption
import com.slopus.happy.crypto.AccountLink
import com.slopus.happy.crypto.Base64Variant
import com.slopus.happy.crypto.RandomSource
import com.slopus.happy.crypto.SecureRandomSource
import com.slopus.happy.crypto.Sodium
import com.slopus.happy.crypto.decodeBase64
import com.slopus.happy.crypto.encryptBox
import com.slopus.happy.net.HttpStatusException
import kotlinx.coroutines.delay
import java.io.IOException
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

/** What the other phone handed over: the account secret and a token for it. */
class LinkedAccount(val token: String, val secret: ByteArray)

/**
 * The new phone's side of an account link (restore/index.tsx with
 * authQRStart.ts and authQRWait.ts). It offers [url] as a QR code; the phone
 * that has the account scans it and seals the secret to [keyPair].
 */
class AccountLinkRequest(
    private val api: AuthApi,
    random: RandomSource = SecureRandomSource,
) {
    val keyPair: Sodium.KeyPair = AccountLink.generateKeyPair(random)

    /** What the QR code carries: `happy:///account?<base64url public key>`. */
    val url: String = AccountLink.linkUrl(keyPair.publicKey)

    /** authQRStart: registers the request. Throws if the server can't be reached. */
    suspend fun start() {
        api.requestAccountLink(keyPair.publicKey)
    }

    /**
     * authQRWait: asks again until the request is authorized, at once and
     * then every [pollInterval]. Null when the answer doesn't open with this
     * key pair; throws when the server refuses a request, as authQRWait gives
     * up then too. A request that gets no answer at all is asked again:
     * Android cuts a backgrounded app's network, and linking from another
     * account app on this same phone puts this one behind it while it scans.
     */
    suspend fun awaitApproval(pollInterval: Duration = 1.seconds): LinkedAccount? {
        while (true) {
            val state = try {
                api.requestAccountLink(keyPair.publicKey)
            } catch (e: HttpStatusException) {
                throw e
            } catch (_: IOException) {
                delay(pollInterval)
                continue
            }
            if (state.state == "authorized") {
                val token = state.token ?: return null
                val response = state.response?.let {
                    try {
                        decodeBase64(it)
                    } catch (_: IllegalArgumentException) {
                        null
                    }
                } ?: return null
                val secret = AccountLink.openSecret(response, keyPair) ?: return null
                return LinkedAccount(token, secret)
            }
            delay(pollInterval)
        }
    }
}

/** A scanned or pasted link that is not the kind the flow expects. */
class InvalidLinkException(message: String) : IllegalArgumentException(message)

/**
 * The existing phone's side (useConnectAccount.ts processAuthUrl with
 * authAccountApprove.ts): seals this account's secret to the key in a
 * `happy:///account?` link and posts it.
 *
 * Throws [InvalidLinkException] for anything that is not an account link
 * (happy-app's "Invalid authentication URL"), and any other exception when the
 * key is malformed or the request fails ("Failed to link device").
 */
suspend fun approveAccountLink(
    api: AuthApi,
    credentials: AuthCredentials,
    url: String,
    random: RandomSource = SecureRandomSource,
) {
    if (!url.startsWith(AccountLink.URL_PREFIX)) throw InvalidLinkException("Not an account link")
    val publicKey = decodeBase64(url.substring(AccountLink.URL_PREFIX.length), Base64Variant.Url)
    val response = AccountLink.sealSecret(credentials.secretBytes(), publicKey, random)
    api.approveAccountLink(credentials.token, publicKey, response)
}

/** The prefix of the link a terminal (the CLI or Happy Desktop) shows as a QR code. */
const val TERMINAL_URL_PREFIX = "happy://terminal?"

/**
 * Connecting a terminal (useConnectTerminal.ts processAuthUrl with
 * authApprove.ts). The terminal waits with a box key pair; this phone seals
 * two answers to it: v1 is the account secret, v2 is `0x00 || the content
 * public key` (`sync.encryption.contentDataKey`), which lets a v2 terminal
 * work without the secret. The server says which one the terminal takes. A
 * request that is already answered or gone needs nothing, and counts as done.
 *
 * Throws [InvalidLinkException] when [url] is not a terminal link, and any
 * other exception when the key is malformed or a request fails.
 */
suspend fun approveTerminal(
    api: AuthApi,
    credentials: AuthCredentials,
    encryption: AccountEncryption,
    url: String,
    random: RandomSource = SecureRandomSource,
) {
    if (!url.startsWith(TERMINAL_URL_PREFIX)) throw InvalidLinkException("Not a terminal link")
    val publicKey = decodeBase64(url.substring(TERMINAL_URL_PREFIX.length), Base64Variant.Url)
    val responseV1 = encryptBox(credentials.secretBytes(), publicKey, random)
    val responseV2 = encryptBox(byteArrayOf(0) + encryption.contentPublicKey, publicKey, random)
    val status = api.terminalAuthStatus(publicKey)
    if (status.status == "pending") {
        api.approveTerminal(credentials.token, publicKey, if (status.supportsV2) responseV2 else responseV1)
    }
}
