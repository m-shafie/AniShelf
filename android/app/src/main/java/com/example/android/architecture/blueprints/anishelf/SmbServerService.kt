package com.example.android.architecture.blueprints.anishelf

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Binder
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import timber.log.Timber

class SmbServerService : Service() {

    private val binder = SmbServerBinder()
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _isRunning = MutableStateFlow(false)
    val isRunning = _isRunning.asStateFlow()

    private val _port = MutableStateFlow(1445)
    val port = _port.asStateFlow()

    private val _connectionCount = MutableStateFlow(0)
    val connectionCount = _connectionCount.asStateFlow()

    private val _bytesWritten = MutableStateFlow(0L)
    val bytesWritten = _bytesWritten.asStateFlow()

    private var hadActiveTransfers = false
    private var showDoneText = false
    private var doneDebounceStartMs = 0L
    private var doneDebounceActive = false

    inner class SmbServerBinder : Binder() {
        fun getService(): SmbServerService = this@SmbServerService
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    fun startServer(port: Int, shares: List<Pair<String, String>>) {
        val share = shares.firstOrNull() ?: return
        if (_isRunning.value) return

        val (name, path) = share
        _port.value = port
        serviceScope.launch {
            try {
                val result = Smb2Server.start(port, name, path)
                if (result == 0) {
                    _isRunning.value = true
                    startForeground(1, buildNotification("Server running", "Ready to receive"))
                    Timber.d("libsmb2 SMB2 server started on port $port, share=$name path=$path")
                    pollStats()
                } else {
                    Timber.e("Failed to start libsmb2 server: errno=$result")
                    _isRunning.value = false
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to start SMB server")
                _isRunning.value = false
            }
        }
    }

    fun stopServer() {
        Smb2Server.stop()
        _isRunning.value = false
        _connectionCount.value = 0
        _bytesWritten.value = 0
        hadActiveTransfers = false
        showDoneText = false
        doneDebounceActive = false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        Timber.d("SMB2 Server stopped")
    }

    private suspend fun pollStats() {
        while (_isRunning.value) {
            _connectionCount.value = Smb2Server.connectionCount
            _bytesWritten.value = Smb2Server.bytesWritten

            val transfers = Smb2Server.getTransfers()
            val activeCount = transfers.count { it.status == 0 }

            if (activeCount > 0) {
                hadActiveTransfers = true
                showDoneText = false
                doneDebounceActive = false
                val current = transfers.first { it.status == 0 }
                val bytes = formatBytes(current.totalBytes)
                startForeground(1, buildNotification("Transferring", "${current.fileName} ($bytes)", isTransferring = true))
            } else if (hadActiveTransfers && transfers.isNotEmpty()) {
                if (!doneDebounceActive) {
                    doneDebounceStartMs = System.currentTimeMillis()
                    doneDebounceActive = true
                }
                val elapsed = System.currentTimeMillis() - doneDebounceStartMs
                if (elapsed >= 3000) {
                    showDoneText = true
                    hadActiveTransfers = false
                    doneDebounceActive = false
                    startForeground(1, buildNotification("All transfers complete", ""))
                } else {
                    startForeground(1, buildNotification("Server running", "Ready to receive"))
                }
            } else if (showDoneText) {
                startForeground(1, buildNotification("All transfers complete", ""))
            } else {
                startForeground(1, buildNotification("Server running", "Ready to receive"))
            }

            delay(1000)
        }
    }

    private fun buildNotification(title: String, body: String, isTransferring: Boolean = false): Notification {
        val icon = if (isTransferring) {
            android.R.drawable.stat_sys_download
        } else {
            android.R.drawable.ic_menu_share
        }
        return NotificationCompat.Builder(this, "smb_server_channel")
            .setContentTitle(title)
            .setContentText(body)
            .setSmallIcon(icon)
            .build()
    }

    private fun formatBytes(bytes: Long): String {
        return when {
            bytes < 1024 -> "$bytes B"
            bytes < 1024 * 1024 -> "${bytes / 1024} KB"
            bytes < 1024 * 1024 * 1024 -> String.format("%.1f MB", bytes / (1024.0 * 1024.0))
            else -> String.format("%.1f GB", bytes / (1024.0 * 1024.0 * 1024.0))
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                "smb_server_channel",
                "SMB2 Server",
                NotificationManager.IMPORTANCE_LOW
            )
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    override fun onDestroy() {
        stopServer()
        super.onDestroy()
    }
}
