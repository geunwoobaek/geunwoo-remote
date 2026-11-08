package com.slopus.happy.model

import com.slopus.happy.chat.str

/**
 * The model a Happy CLI session's Claude actually started with, as the SDK
 * reported it (`claude-opus-5-5`): the fork CLI's `metadata.runningModel`.
 * What the composer picked ("opus") resolves to this on the computer.
 */
fun SessionMetadata?.runningModel(): String? = this?.raw?.get("runningModel").str?.takeIf { it.isNotBlank() }
