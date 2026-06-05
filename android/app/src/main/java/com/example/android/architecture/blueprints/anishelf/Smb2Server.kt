package com.example.android.architecture.blueprints.anishelf

data class TransferInfo(
    val fileName: String,
    val totalBytes: Long,
    val status: Int
)

object Smb2Server {
    private var loaded = false

    private fun ensureLoaded() {
        if (!loaded) {
            System.loadLibrary("smb2_server_jni")
            loaded = true
        }
    }

    fun start(port: Int, shareName: String, sharePath: String): Int {
        ensureLoaded()
        return nativeStart(port, shareName, sharePath)
    }

    fun stop() {
        ensureLoaded()
        nativeStop()
    }

    val isRunning: Boolean
        get() {
            ensureLoaded()
            return nativeIsRunning()
        }

    val port: Int
        get() {
            ensureLoaded()
            return nativeGetPort()
        }

    val connectionCount: Int
        get() {
            ensureLoaded()
            return nativeGetConnectionCount()
        }

    val bytesWritten: Long
        get() {
            ensureLoaded()
            return nativeGetBytesWritten()
        }

    fun getTransfers(): List<TransferInfo> {
        ensureLoaded()
        val count = nativeGetTransferCount()
        return List(count) { i ->
            TransferInfo(
                fileName = nativeGetTransferFileName(i),
                totalBytes = nativeGetTransferBytes(i),
                status = nativeGetTransferStatus(i)
            )
        }
    }

    fun clearTransfers() {
        ensureLoaded()
        nativeClearTransfers()
    }

    private external fun nativeStart(port: Int, shareName: String, sharePath: String): Int
    private external fun nativeStop()
    private external fun nativeIsRunning(): Boolean
    private external fun nativeGetPort(): Int
    private external fun nativeGetConnectionCount(): Int
    private external fun nativeGetBytesWritten(): Long
    private external fun nativeGetTransferCount(): Int
    private external fun nativeGetTransferFileName(index: Int): String
    private external fun nativeGetTransferBytes(index: Int): Long
    private external fun nativeGetTransferStatus(index: Int): Int
    private external fun nativeClearTransfers()
}
