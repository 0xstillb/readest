package com.readest.native_bridge

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.provider.Settings
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import kotlinx.coroutines.delay

/** iReader SmartOS Custom screensaver. Only files created by Readest are replaced. */
internal object IReaderSleepCover {
    private val directory = File("/data/zhangyue/logo/custom")
    private const val PREFIX = "readest_ireader_cover_"
    private const val SELECTED = "custom_wallpaper_selected_path"
    private const val MODE = "wallpaper_lock_screen_info"

    fun available(): Boolean = directory.isDirectory && directory.canWrite()

    private fun write(bitmap: Bitmap, file: File) {
        FileOutputStream(file).use { output ->
            check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) { "Could not encode cover" }
            output.fd.sync()
        }
        file.setReadable(true, false)
    }

    private fun notifySystem(context: Context) {
        val intent = Intent("com.szzy.ireader.ink.wallpaper.ACTION_LOCK_SCREEN_WALLPAPER_CHANGED")
        intent.setPackage("com.szzy.ireader.systemui")
        intent.putExtra("extra_wallpaper_type", "CUSTOM")
        intent.putExtra("extra_order_type", "FIXED")
        context.sendBroadcast(intent)
    }

    suspend fun prepare(context: Context, bitmap: Bitmap): String {
        val resolver = context.contentResolver
        val selectedPath = Settings.System.getString(resolver, SELECTED)
        val mode = Settings.System.getString(resolver, MODE)
        val old = selectedPath?.takeIf { it.isNotEmpty() }?.let(::File)
        val isManaged = old != null && old.name.startsWith(PREFIX) &&
            old.canonicalFile.parentFile == directory.canonicalFile && old.isFile

        if (mode != "3,2" || !isManaged) {
            // The user chooses this image once in the device's Custom screensaver.
            write(bitmap, File(directory, "${PREFIX}setup.png"))
            return "setup"
        }

        val previous = requireNotNull(old)
        val backup = File.createTempFile("readest-cover-backup-", ".png", context.cacheDir)
        val next = File(directory, "$PREFIX${UUID.randomUUID()}.png")
        var removedPrevious = false
        try {
            previous.copyTo(backup, overwrite = true)
            write(bitmap, next)
            // SmartOS chooses the newest image if the selected file is absent.
            val newest = directory.listFiles()?.filter { it != next }?.maxOfOrNull { it.lastModified() } ?: 0L
            check(newest < Long.MAX_VALUE) { "Invalid image timestamp" }
            check(next.setLastModified(maxOf(System.currentTimeMillis(), newest + 1))) { "Cannot order cover" }
            check(Settings.System.getString(resolver, MODE) == "3,2" &&
                Settings.System.getString(resolver, SELECTED) == previous.absolutePath) {
                "Screensaver selection changed"
            }
            check(previous.delete()) { "Cannot replace the previous Readest cover" }
            removedPrevious = true
            notifySystem(context)
            repeat(15) {
                delay(200)
                if (Settings.System.getString(resolver, SELECTED) == next.absolutePath) return "ready"
            }
            error("iReader did not select the new cover")
        } catch (error: Exception) {
            val current = Settings.System.getString(resolver, SELECTED)
            if (removedPrevious && (current == previous.absolutePath || current.isNullOrEmpty())) {
                backup.copyTo(previous, overwrite = true)
                previous.setReadable(true, false)
                notifySystem(context)
            }
            if (current != next.absolutePath) next.delete()
            throw error
        } finally {
            backup.delete()
        }
    }
}
