package com.slopus.happy.ui.home

import com.slopus.happy.chat.ChatNormalizer
import com.slopus.happy.data.HappyStore
import com.slopus.happy.model.SessionPreview
import com.slopus.happy.model.previewOf

/**
 * Each session's [SessionPreview], from its newest [limit] stored messages.
 * A session is read again only when its stored run has grown (its
 * `messages_seq` moved); one with nothing stored is left out, so its row
 * keeps its folder. Not thread-safe: one caller, off the main thread.
 */
class SessionPreviews(
    private val store: HappyStore,
    private val limit: Int = 20,
    /** Tests count the sessions read. */
    private val onRead: (String) -> Unit = {},
) {
    private class Entry(val seq: Long, val preview: SessionPreview)

    private val cache = HashMap<String, Entry>()

    fun previews(ids: Collection<String>): Map<String, SessionPreview> {
        val seqs = store.messagesSeqs(ids)
        cache.keys.retainAll(seqs.keys)
        val out = HashMap<String, SessionPreview>(seqs.size)
        for ((id, seq) in seqs) {
            if (seq <= 0) continue
            val entry = cache[id]?.takeIf { it.seq == seq } ?: run {
                onRead(id)
                val newestFirst = store.messages(id, limit).asReversed().mapNotNull(ChatNormalizer::normalize)
                Entry(seq, previewOf(newestFirst)).also { cache[id] = it }
            }
            out[id] = entry.preview
        }
        return out
    }
}
