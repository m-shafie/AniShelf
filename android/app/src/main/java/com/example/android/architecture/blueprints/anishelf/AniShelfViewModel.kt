package com.example.android.architecture.blueprints.anishelf

import android.app.Application
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.SharedPreferences
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.IBinder
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.net.NetworkInterface
import java.util.Collections
import javax.inject.Inject

enum class ServerStatus {
    STOPPED, STARTING, RUNNING
}

data class SharedFolder(
    val name: String,
    val path: String,
    val isEnabled: Boolean = true
)

data class TransferLog(
    val id: Long,
    val fileName: String,
    val clientIp: String,
    val size: Long,
    val progress: Float,
    val status: String,
    val time: Long = System.currentTimeMillis(),
    val errorMsg: String? = null
)

@HiltViewModel
class AniShelfViewModel @Inject constructor(
    application: Application
) : AndroidViewModel(application) {

    private val _serverStatus = MutableStateFlow(ServerStatus.STOPPED)
    val serverStatus: StateFlow<ServerStatus> = _serverStatus.asStateFlow()

    private val _ipAddress = MutableStateFlow("—")
    val ipAddress: StateFlow<String> = _ipAddress.asStateFlow()

    private val _port = MutableStateFlow(1445)
    val port: StateFlow<Int> = _port.asStateFlow()

    private val _uptime = MutableStateFlow("—")
    val uptime: StateFlow<String> = _uptime.asStateFlow()

    private val _bytesSent = MutableStateFlow(0L)
    val bytesSent: StateFlow<Long> = _bytesSent.asStateFlow()

    private val _connectionsCount = MutableStateFlow(0)
    val connectionsCount: StateFlow<Int> = _connectionsCount.asStateFlow()

    private val _selectedFolder = MutableStateFlow<SharedFolder?>(null)
    val selectedFolder: StateFlow<SharedFolder?> = _selectedFolder.asStateFlow()

    private val _snackbarMessage = MutableStateFlow<String?>(null)
    val snackbarMessage: StateFlow<String?> = _snackbarMessage.asStateFlow()

    private val _transferLogs = MutableStateFlow(emptyList<TransferLog>())
    val transferLogs: StateFlow<List<TransferLog>> = _transferLogs.asStateFlow()

    private val _isOnline = MutableStateFlow(true)
    val isOnline: StateFlow<Boolean> = _isOnline.asStateFlow()

    private var uptimeJob: Job? = null
    private var statsJob: Job? = null
    private var startTime: Long = 0

    private var transferCounter = 0L
    private var boundService: SmbServerService? = null
    private val prefs: SharedPreferences = application.getSharedPreferences("anishelf", Context.MODE_PRIVATE)
    private val connectivityManager = application.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            _isOnline.value = true
        }
        override fun onLost(network: Network) {
            val active = connectivityManager.activeNetwork ?: return
            val caps = connectivityManager.getNetworkCapabilities(active) ?: return
            val hasInternet = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            _isOnline.value = hasInternet
        }
    }

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val binder = service as SmbServerService.SmbServerBinder
            boundService = binder.getService()
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            boundService = null
        }
    }

    init {
        val savedPath = prefs.getString("folder_path", null)
        val savedName = prefs.getString("folder_name", null)
        if (savedPath != null && savedName != null) {
            _selectedFolder.value = SharedFolder(savedName, savedPath)
        }

        val savedTheme = prefs.getString("theme", null)
        if (savedTheme != null) {
            try {
                AniShelfThemeState.restore(AniShelfThemeVariant.valueOf(savedTheme))
            } catch (_: IllegalArgumentException) {}
        }

        updateIpAddress()

        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        connectivityManager.registerNetworkCallback(request, networkCallback)
        _isOnline.value = checkConnectivity()

        val ctx = getApplication<Application>()
        val intent = Intent(ctx, SmbServerService::class.java)
        ctx.bindService(intent, connection, Context.BIND_AUTO_CREATE)
    }

    override fun onCleared() {
        super.onCleared()
        try {
            connectivityManager.unregisterNetworkCallback(networkCallback)
        } catch (_: Exception) {}
        try {
            getApplication<Application>().unbindService(connection)
        } catch (_: Exception) {}
    }

    private fun checkConnectivity(): Boolean {
        val active = connectivityManager.activeNetwork ?: return false
        val caps = connectivityManager.getNetworkCapabilities(active) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    fun toggleServer() {
        when (_serverStatus.value) {
            ServerStatus.STOPPED -> {
                if (!_isOnline.value) {
                    _snackbarMessage.value = "No network connection available"
                    return
                }
                val folder = _selectedFolder.value
                if (folder == null) {
                    _snackbarMessage.value = "Select a shared folder first"
                    return
                }
                _serverStatus.value = ServerStatus.STARTING
                viewModelScope.launch {
                    delay(500)
                    boundService?.startServer(_port.value, listOf(folder.name to folder.path))
                    startTime = System.currentTimeMillis()
                    updateIpAddress()
                    waitForRunning()
                }
            }
            ServerStatus.RUNNING -> {
                boundService?.stopServer()
                _serverStatus.value = ServerStatus.STOPPED
                uptimeJob?.cancel()
                statsJob?.cancel()
                _uptime.value = "—"
                _connectionsCount.value = 0
                _bytesSent.value = 0
            }
            else -> {}
        }
    }

    private suspend fun waitForRunning() {
        var attempts = 0
        while (attempts < 20) {
            delay(250)
            if (boundService?.isRunning?.value == true) {
                _serverStatus.value = ServerStatus.RUNNING
                startUptimeTimer()
                startStatsPolling()
                return
            }
            attempts++
        }
        _serverStatus.value = ServerStatus.STOPPED
    }

    private fun startStatsPolling() {
        statsJob = viewModelScope.launch {
            while (true) {
                delay(1000)
                val service = boundService ?: continue
                _connectionsCount.value = service.connectionCount.value
                _bytesSent.value = service.bytesWritten.value

                val transfers = Smb2Server.getTransfers()
                val logs = transfers.map { info ->
                    val statusStr = when (info.status) {
                        1 -> "success"
                        2 -> "error"
                        else -> "active"
                    }
                    transferCounter++
                    TransferLog(
                        id = transferCounter,
                        fileName = info.fileName,
                        clientIp = "",
                        size = info.totalBytes,
                        progress = if (info.status == 1) 1f else 0f,
                        status = statusStr,
                        time = System.currentTimeMillis()
                    )
                }
                _transferLogs.value = logs
            }
        }
    }

    private fun startUptimeTimer() {
        uptimeJob = viewModelScope.launch {
            while (true) {
                val seconds = (System.currentTimeMillis() - startTime) / 1000
                val h = seconds / 3600
                val m = (seconds % 3600) / 60
                val s = seconds % 60
                _uptime.value = java.util.Locale.getDefault().let { locale ->
                    String.format(locale, "%02d:%02d:%02d", h, m, s)
                }
                delay(1000)
            }
        }
    }

    private fun updateIpAddress() {
        viewModelScope.launch {
            try {
                val interfaces = Collections.list(NetworkInterface.getNetworkInterfaces())
                for (intf in interfaces) {
                    val addrs = Collections.list(intf.inetAddresses)
                    for (addr in addrs) {
                        if (!addr.isLoopbackAddress) {
                            val sAddr = addr.hostAddress ?: continue
                            if (sAddr.indexOf(':') < 0) {
                                _ipAddress.value = sAddr
                                return@launch
                            }
                        }
                    }
                }
            } catch (_: Exception) {
                _ipAddress.value = "—"
            }
        }
    }

    fun setSelectedFolder(path: String) {
        val name = path.substringAfterLast('/')
        _selectedFolder.value = SharedFolder(name, path, true)
        prefs.edit().putString("folder_path", path).putString("folder_name", name).apply()
    }

    fun saveTheme(name: String) {
        prefs.edit().putString("theme", name).apply()
    }

    fun clearSnackbar() {
        _snackbarMessage.value = null
    }

    fun clearLogs() {
        Smb2Server.clearTransfers()
        _transferLogs.value = emptyList()
    }
}
