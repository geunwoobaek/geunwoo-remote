package com.slopus.happy.ui.files

/**
 * The folder the agent works in now (`metadata.cwd`), beside the one the
 * session started in (`metadata.path`). The agent often moves into a
 * worktree (`.claude/worktrees/<name>`) or a subfolder and names files
 * relative to where it is, so a relative path is read against its folder
 * first and against the session's after. A session from an older happy-cli
 * has no `cwd`, and everything reads as it did: against the session's
 * folder alone.
 */
object AgentFolder {
    /** [cwd], normalized, when it is an absolute folder apart from [root]; null when the agent is in the session's folder or no CLI said. */
    fun of(root: String?, cwd: String?): String? {
        if (cwd.isNullOrBlank()) return null
        val folder = SessionFilePaths.normalize(cwd).let { if (it.length > 1) it.trimEnd('/') else it }
        if (!isAbsolute(folder)) return null
        if (root != null && folder == SessionFilePaths.normalize(root).trimEnd('/')) return null
        return folder
    }

    /**
     * The absolute places [path] may be, the likeliest first: a relative path
     * against the agent's folder, then against the session's; an absolute
     * path as it is. A `:line[:column]` suffix is dropped. Empty when the path
     * is relative and there is no folder to read it against.
     */
    fun candidates(path: String, root: String?, cwd: String?): List<String> {
        SessionFilePaths.resolve(path, null)?.let { return listOf(it.absolutePath).filter(::isAbsolute) }
        val agent = of(root, cwd)
        return listOfNotNull(
            agent?.let { SessionFilePaths.resolve(path, it)?.absolutePath },
            SessionFilePaths.resolve(path, root)?.absolutePath,
        ).filter(::isAbsolute).distinct()
    }

    /** Of the worktree copies of one file, the one in the agent's folder; null when it is in none of them. */
    fun preferred(copies: List<WorktreeLookup.Copy>, root: String?, cwd: String?): WorktreeLookup.Copy? {
        val agent = of(root, cwd) ?: return null
        return copies.firstOrNull { it.path.startsWith("$agent/") }
    }

    private fun isAbsolute(path: String) = path.startsWith("/") || (path.length > 2 && path[1] == ':' && path[2] == '/')
}
