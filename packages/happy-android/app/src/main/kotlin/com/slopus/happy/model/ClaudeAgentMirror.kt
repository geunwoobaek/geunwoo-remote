package com.slopus.happy.model

/**
 * A Happy session that mirrors a Mac `claude agents` background session
 * names that session's agent id in its metadata (`claudeAgentId`). Messages
 * typed on the phone are typed into the Mac session and dialogs are answered
 * by pressing keys there, so what only a session of our own can do (fork,
 * resume, picking a model or mode, attachments, "allow always" answers) is
 * turned off for it.
 */
fun SessionMetadata?.isClaudeAgentMirror(): Boolean = !this?.claudeAgentId.isNullOrBlank()
