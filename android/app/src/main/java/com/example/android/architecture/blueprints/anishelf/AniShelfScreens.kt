package com.example.android.architecture.blueprints.anishelf

import android.net.Uri
import android.provider.DocumentsContract
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.launch

// ─────────────────────────────────────────────────────────────────────────────
//  IMAGE PLACEMENT GUIDE
//
//  Copy your PNGs into:  app/src/main/res/drawable/
//  Rename exactly as:
//    motoko-kusanagi-ghost-in-the-shell.png  →  char_motoko.png
//    makima.png                              →  char_makima.png
//    tomoko.png                              →  char_tomoko.png
// ─────────────────────────────────────────────────────────────────────────────

// Which drawable to show for each theme
private fun charDrawable(variant: AniShelfThemeVariant): Int = when (variant) {
    AniShelfThemeVariant.MOTOKO -> R.drawable.char_motoko
    AniShelfThemeVariant.MAKIMA -> R.drawable.char_makima
    AniShelfThemeVariant.TOMOKO -> R.drawable.char_tomoko
}

@Composable
fun AniShelfMainScreen(
    viewModel: AniShelfViewModel = viewModel()
) {
    val pagerState = rememberPagerState(pageCount = { 2 })
    val snackbarMessage by viewModel.snackbarMessage.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(AniShelfThemeState.current) {
        viewModel.saveTheme(AniShelfThemeState.current.name)
    }

    LaunchedEffect(snackbarMessage) {
        snackbarMessage?.let { msg ->
            snackbarHostState.showSnackbar(msg, duration = SnackbarDuration.Short)
            viewModel.clearSnackbar()
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = { TopBar() },
        bottomBar = {
            BottomBar(pagerState.currentPage) { page ->
                scope.launch {
                    pagerState.animateScrollToPage(
                        page, animationSpec = tween(300, easing = FastOutSlowInEasing)
                    )
                }
            }
        },
        containerColor = AniShelfBackground
    ) { padding ->
        HorizontalPager(
            state = pagerState,
            modifier = Modifier.padding(padding).fillMaxSize()
        ) { page ->
            when (page) {
                0 -> ServerScreen(viewModel)
                1 -> LogsScreen(viewModel)
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  FLOWER BUTTON  — tap to spin, then smoothly switch to next theme
// ─────────────────────────────────────────────────────────────────────────────
@Composable
fun FlowerThemeButton(modifier: Modifier = Modifier) {
    var targetRotation by remember { mutableStateOf(0f) }
    var clickCount     by remember { mutableStateOf(0) }

    val rotation by animateFloatAsState(
        targetValue = targetRotation,
        animationSpec = spring(
            dampingRatio = Spring.DampingRatioMediumBouncy,
            stiffness    = Spring.StiffnessLow
        ),
        label = "flowerRotation"
    )

    val ringColor by animateColorAsState(
        targetValue = AniShelfAccentBright,
        animationSpec = tween(600, easing = FastOutSlowInEasing),
        label = "ringColor"
    )
    val dotColor by animateColorAsState(
        targetValue = AniShelfAccent,
        animationSpec = tween(600, easing = FastOutSlowInEasing),
        label = "dotColor"
    )

    LaunchedEffect(clickCount) {
        if (clickCount > 0) {
            kotlinx.coroutines.delay(280)
            AniShelfThemeState.next()
        }
    }

    val interactionSource = remember { MutableInteractionSource() }

    Box(
        modifier = modifier
            .size(38.dp)
            .clickable(interactionSource = interactionSource, indication = null) {
                targetRotation += 360f
                clickCount++
            },
        contentAlignment = Alignment.Center
    ) {
        Box(
            modifier = Modifier
                .size(28.dp)
                .rotate(rotation)
                .drawBehind {
                    val r = size.minDimension / 2f
                    drawCircle(
                        color = ringColor.copy(alpha = 0.6f),
                        radius = r,
                        style = androidx.compose.ui.graphics.drawscope.Stroke(width = 1.8.dp.toPx())
                    )
                    drawCircle(
                        color = dotColor,
                        radius = r * 0.28f
                    )
                }
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  TOP BAR
// ─────────────────────────────────────────────────────────────────────────────
@Composable
fun TopBar() {
    val theme = AniShelfThemeState.current

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(AniShelfSurface)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 48.dp, start = 18.dp, end = 18.dp, bottom = 12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            // Logo
            Row(verticalAlignment = Alignment.CenterVertically) {
                Spacer(modifier = Modifier.width(2.dp))
                Column {
                    Row(verticalAlignment = Alignment.Bottom) {
                        Text("Ani",   color = AniShelfAccentBright, fontWeight = FontWeight.ExtraBold, fontSize = 17.sp)
                        Text("Shelf", color = AniShelfTextPrimary,  fontWeight = FontWeight.ExtraBold, fontSize = 17.sp)
                    }
                    Text(
                        text = when (theme) {
                            AniShelfThemeVariant.MOTOKO -> "Motoko's Shell"
                            AniShelfThemeVariant.MAKIMA -> "Makima's Control"
                            AniShelfThemeVariant.TOMOKO -> "Tomoko's Sunshine"
                        },
                        color = AniShelfTextSecondary,
                        fontSize = 10.sp,
                        letterSpacing = 0.4.sp
                    )
                }
            }

            // Flower theme switcher — top right
            FlowerThemeButton()
        }

        // Accent underline
        Box(
            modifier = Modifier
                .align(Alignment.BottomStart)
                .fillMaxWidth()
                .height(1.dp)
                .background(
                    Brush.horizontalGradient(
                        listOf(
                            AniShelfAccent.copy(alpha = 0.5f),
                            AniShelfAccent.copy(alpha = 0.1f),
                            Color.Transparent
                        )
                    )
                )
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  BOTTOM BAR — full-width half split, no bubble
// ─────────────────────────────────────────────────────────────────────────────
@Composable
fun BottomBar(currentPage: Int, onTabSelected: (Int) -> Unit) {
    Box(modifier = Modifier.fillMaxWidth().background(AniShelfSurface).navigationBarsPadding()) {
        Box(
            modifier = Modifier
                .align(Alignment.TopStart)
                .fillMaxWidth()
                .height(1.dp)
                .background(AniShelfAccent.copy(alpha = 0.12f))
        )
        Row(modifier = Modifier.fillMaxWidth()) {
            TabHalf(
                icon      = Icons.Default.Storage,
                label     = "Server",
                selected  = currentPage == 0,
                onClick   = { onTabSelected(0) },
                modifier  = Modifier.weight(1f)
            )
            Box(
                modifier = Modifier
                    .width(1.dp)
                    .height(56.dp)
                    .align(Alignment.CenterVertically)
                    .background(AniShelfAccent.copy(alpha = 0.10f))
            )
            TabHalf(
                icon     = Icons.Default.History,
                label    = "Transfers",
                selected = currentPage == 1,
                onClick  = { onTabSelected(1) },
                modifier = Modifier.weight(1f)
            )
        }
    }
}

@Composable
private fun TabHalf(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier
) {
    val bg    by animateColorAsState(
        if (selected) AniShelfAccent.copy(alpha = 0.10f) else Color.Transparent,
        tween(250), label = "tabBg"
    )
    val tint  by animateColorAsState(
        if (selected) AniShelfAccentBright else AniShelfTextSecondary,
        tween(250), label = "tabTint"
    )

    Box(
        modifier = modifier
            .background(bg)
            .clickable { onClick() }
            .padding(vertical = 10.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(icon, contentDescription = label, tint = tint, modifier = Modifier.size(22.dp))
            Spacer(modifier = Modifier.height(3.dp))
            Text(
                text       = label,
                color      = tint,
                fontSize   = 11.sp,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal
            )
            Spacer(modifier = Modifier.height(4.dp))
            Box(
                modifier = Modifier
                    .width(22.dp)
                    .height(2.dp)
                    .clip(RoundedCornerShape(1.dp))
                    .background(if (selected) AniShelfAccentBright else Color.Transparent)
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SERVER SCREEN — non-scrollable, compact
// ─────────────────────────────────────────────────────────────────────────────
@Composable
fun ServerScreen(viewModel: AniShelfViewModel) {
    val status         by viewModel.serverStatus.collectAsState()
    val ipAddress      by viewModel.ipAddress.collectAsState()
    val port           by viewModel.port.collectAsState()
    val uptime         by viewModel.uptime.collectAsState()
    val bytesSent      by viewModel.bytesSent.collectAsState()
    val selectedFolder by viewModel.selectedFolder.collectAsState()
    val connections    by viewModel.connectionsCount.collectAsState()
    val isOnline       by viewModel.isOnline.collectAsState()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        ServerInfoCard(ipAddress, status, uptime, bytesSent, connections)
        SharedFoldersCard(selectedFolder) { viewModel.setSelectedFolder(it) }
        Card(
            colors = CardDefaults.cardColors(containerColor = AniShelfCard),
            shape  = RoundedCornerShape(14.dp),
            modifier = Modifier.fillMaxWidth().weight(1f)
        ) {
            Column(Modifier.fillMaxSize()) {
                Spacer(Modifier.weight(1f))
                ServerToggleCardContent(status, isOnline) { viewModel.toggleServer() }
                Spacer(Modifier.weight(1f))
                HorizontalDivider(color = AniShelfAccent.copy(alpha = 0.07f), thickness = 1.dp)
                SmbPathRow(ipAddress, port)
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SERVER TOGGLE — single circle, alpha-only pulse via drawBehind
// ─────────────────────────────────────────────────────────────────────────────
@Composable
fun ServerToggleCardContent(status: ServerStatus, isOnline: Boolean, onToggle: () -> Unit) {
    val offline = !isOnline && status == ServerStatus.STOPPED

    val statusColor by animateColorAsState(
        targetValue = when {
            offline          -> AniShelfTextSecondary.copy(alpha = 0.5f)
            status == ServerStatus.RUNNING  -> AniShelfSuccess
            status == ServerStatus.STARTING -> AniShelfGold
            else             -> AniShelfTextSecondary
        },
        animationSpec = tween(400),
        label = "statusColor"
    )

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 8.dp, bottom = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Box(
            modifier = Modifier
                .size(110.dp)
                .clip(CircleShape)
                .background(statusColor.copy(alpha = 0.08f))
                .clickable { onToggle() },
            contentAlignment = Alignment.Center
        ) {
            Icon(
                imageVector = if (offline) Icons.Default.WifiOff else Icons.Default.Dns,
                contentDescription = "Toggle server",
                modifier = Modifier.size(40.dp),
                tint = statusColor
            )
        }

        Spacer(modifier = Modifier.height(14.dp))
        Text(
            text = when {
                offline          -> "No Connection"
                status == ServerStatus.RUNNING  -> "Server Running"
                status == ServerStatus.STARTING -> "Starting…"
                else             -> "Server Stopped"
            },
            color = statusColor, fontSize = 16.sp, fontWeight = FontWeight.Bold
        )
        Spacer(modifier = Modifier.height(3.dp))
        Text(
            text = when {
                offline          -> "Enable WiFi to start"
                status == ServerStatus.RUNNING  -> "Tap to stop"
                status == ServerStatus.STARTING -> "Please wait…"
                else             -> "Tap to start SMB"
            },
            color = AniShelfTextSecondary.copy(alpha = if (offline) 0.4f else 1f), fontSize = 13.sp
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SMB PATH ROW
// ─────────────────────────────────────────────────────────────────────────────
@Composable
fun SmbPathRow(ip: String, port: Int) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(AniShelfBackground.copy(alpha = 0.3f))
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(Icons.Default.Link, null, tint = AniShelfAccentBright.copy(alpha = 0.5f), modifier = Modifier.size(12.dp))
        Spacer(modifier = Modifier.width(7.dp))
        Text("smb://$ip:$port/anime", color = AniShelfTextSecondary, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SERVER INFO CARD
// ─────────────────────────────────────────────────────────────────────────────
@Composable
fun ServerInfoCard(ip: String, status: ServerStatus, uptime: String, sent: Long, connections: Int) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors   = CardDefaults.cardColors(containerColor = AniShelfCard),
        shape    = RoundedCornerShape(14.dp)
    ) {
        Column(modifier = Modifier.padding(14.dp)) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text("SERVER INFO", color = AniShelfTextSecondary.copy(alpha = 0.5f), fontSize = 9.5.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.2.sp)
                Box(modifier = Modifier.clip(RoundedCornerShape(20.dp)).background(AniShelfAccent.copy(alpha = 0.12f)).padding(horizontal = 8.dp, vertical = 3.dp)) {
                    Text("$connections connected", color = AniShelfAccentBright, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
                }
            }
            Spacer(modifier = Modifier.height(10.dp))
            Row(modifier = Modifier.fillMaxWidth()) {
                InfoTile(Modifier.weight(1f), "IP ADDRESS", ip, AniShelfAccentBright)
                InfoTile(Modifier.weight(1f), "STATUS", status.name, if (status == ServerStatus.RUNNING) AniShelfSuccess else AniShelfTextSecondary)
            }
            Spacer(modifier = Modifier.height(8.dp))
            Row(modifier = Modifier.fillMaxWidth()) {
                InfoTile(Modifier.weight(1f), "UPTIME", uptime, AniShelfTextPrimary)
                InfoTile(Modifier.weight(1f), "SENT", formatBytes(sent), AniShelfSuccess)
            }
        }
    }
}

fun formatBytes(bytes: Long): String {
    if (bytes < 1024) return "$bytes B"
    val exp = (Math.log(bytes.toDouble()) / Math.log(1024.0)).toInt()
    val pre = "KMGTPE"[exp - 1]
    return String.format("%.1f %sB", bytes / Math.pow(1024.0, exp.toDouble()), pre)
}

@Composable
fun InfoTile(modifier: Modifier, label: String, value: String, valueColor: Color) {
    Column(modifier = modifier.padding(horizontal = 2.dp)) {
        Text(label, color = AniShelfTextSecondary.copy(alpha = 0.5f), fontSize = 9.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.8.sp)
        Spacer(modifier = Modifier.height(2.dp))
        Text(value, color = valueColor, fontSize = 13.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SHARED FOLDER CARD
// ─────────────────────────────────────────────────────────────────────────────
private fun getPathFromSafUri(uri: Uri): String {
    val docId = DocumentsContract.getTreeDocumentId(uri)
    val split = docId.split(":")
    if (split[0] == "primary") {
        val sub = if (split.size >= 2) split[1] else ""
        return "/storage/emulated/0/$sub"
    }
    return docId
}

@Composable
fun SharedFoldersCard(selectedFolder: SharedFolder?, onSelectFolder: (String) -> Unit) {
    val folderLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri: Uri? ->
        if (uri != null) onSelectFolder(getPathFromSafUri(uri))
    }

    Card(modifier = Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = AniShelfCard), shape = RoundedCornerShape(14.dp)) {
        Column(modifier = Modifier.padding(14.dp)) {
            Text("SHARED FOLDER", color = AniShelfTextSecondary.copy(alpha = 0.5f), fontSize = 9.5.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.2.sp)
            Spacer(modifier = Modifier.height(10.dp))
            if (selectedFolder != null) {
                Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Box(modifier = Modifier.size(36.dp).clip(RoundedCornerShape(9.dp)).background(AniShelfAccent.copy(alpha = 0.12f)), contentAlignment = Alignment.Center) {
                        Icon(Icons.Default.Folder, null, tint = AniShelfAccentBright, modifier = Modifier.size(18.dp))
                    }
                    Spacer(modifier = Modifier.width(10.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(selectedFolder.name, color = AniShelfTextPrimary, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                        Text(selectedFolder.path, color = AniShelfTextSecondary, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
                    }
                    Spacer(modifier = Modifier.width(8.dp))
                    Box(modifier = Modifier.clip(RoundedCornerShape(7.dp)).background(AniShelfAccent.copy(alpha = 0.12f)).clickable { folderLauncher.launch(null) }.padding(horizontal = 10.dp, vertical = 7.dp)) {
                        Text("Change", color = AniShelfAccentBright, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
            } else {
                Text("No folder selected", color = AniShelfTextSecondary, fontSize = 12.sp)
                Spacer(modifier = Modifier.height(10.dp))
                Box(modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(9.dp)).background(AniShelfAccent.copy(alpha = 0.10f)).clickable { folderLauncher.launch(null) }.padding(vertical = 12.dp), contentAlignment = Alignment.Center) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.FolderOpen, null, tint = AniShelfAccentBright, modifier = Modifier.size(16.dp))
                        Spacer(modifier = Modifier.width(7.dp))
                        Text("Add Folder", color = AniShelfAccentBright, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  LOGS SCREEN
// ─────────────────────────────────────────────────────────────────────────────
@Composable
fun LogsScreen(viewModel: AniShelfViewModel) {
    val logs by viewModel.transferLogs.collectAsState()
    val theme = AniShelfThemeState.current

    Box(modifier = Modifier.fillMaxSize()) {
        Image(
            painter = painterResource(id = charDrawable(theme)),
            contentDescription = null,
            modifier = Modifier
                .fillMaxSize(0.9f)
                .align(Alignment.BottomCenter)
                .alpha(0.25f),
            contentScale = ContentScale.Fit
        )

        Column(modifier = Modifier.fillMaxSize().padding(horizontal = 14.dp, vertical = 12.dp)) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Column {
                    Text("Transfers", color = AniShelfTextPrimary, fontSize = 19.sp, fontWeight = FontWeight.Bold)
                    Text("SMB transfer history & live activity", color = AniShelfTextSecondary, fontSize = 11.sp)
                }
                if (logs.isNotEmpty()) {
                    Box(modifier = Modifier.clip(RoundedCornerShape(7.dp)).clickable { viewModel.clearLogs() }.padding(horizontal = 10.dp, vertical = 6.dp)) {
                        Text("Clear all", color = AniShelfTextSecondary, fontSize = 12.sp)
                    }
                }
            }
            Spacer(modifier = Modifier.height(14.dp))
            if (logs.isEmpty()) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Box(modifier = Modifier.size(52.dp).clip(CircleShape).background(AniShelfCard), contentAlignment = Alignment.Center) {
                            Icon(Icons.Default.History, null, tint = AniShelfTextSecondary.copy(alpha = 0.35f), modifier = Modifier.size(24.dp))
                        }
                        Spacer(modifier = Modifier.height(10.dp))
                        Text("No transfers yet", color = AniShelfTextSecondary, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                        Spacer(modifier = Modifier.height(3.dp))
                        Text("Files copied from the PC will appear here", color = AniShelfTextSecondary.copy(alpha = 0.45f), fontSize = 11.sp)
                    }
                }
            } else {
                LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(logs) { log -> TransferLogItem(log) }
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  TRANSFER LOG ITEM
// ─────────────────────────────────────────────────────────────────────────────
@Composable
fun TransferLogItem(log: TransferLog) {
    val statusColor = when (log.status) {
        "success" -> AniShelfSuccess
        "error"   -> AniShelfDanger
        else      -> AniShelfAccentBright
    }
    Card(modifier = Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = AniShelfCard), shape = RoundedCornerShape(12.dp)) {
        Row(modifier = Modifier.padding(13.dp), verticalAlignment = Alignment.Top) {
            Box(modifier = Modifier.size(34.dp).clip(RoundedCornerShape(8.dp)).background(statusColor.copy(alpha = 0.11f)), contentAlignment = Alignment.Center) {
                Icon(
                    imageVector = when (log.status) { "success" -> Icons.Default.Check; "error" -> Icons.Default.Close; else -> Icons.Default.Refresh },
                    contentDescription = null, tint = statusColor, modifier = Modifier.size(16.dp)
                )
            }
            Spacer(modifier = Modifier.width(11.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(log.fileName, color = AniShelfTextPrimary, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                Spacer(modifier = Modifier.height(3.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (log.clientIp.isNotEmpty()) {
                        Text(log.clientIp, color = AniShelfAccentBright.copy(alpha = 0.7f), fontSize = 10.sp, fontFamily = FontFamily.Monospace)
                        Spacer(modifier = Modifier.width(5.dp))
                        Box(modifier = Modifier.size(3.dp).clip(CircleShape).background(AniShelfTextSecondary.copy(alpha = 0.35f)))
                        Spacer(modifier = Modifier.width(5.dp))
                    }
                    Text(formatBytes(log.size), color = AniShelfTextSecondary, fontSize = 10.sp)
                }
                if (log.status != "error") {
                    Spacer(modifier = Modifier.height(8.dp))
                    if (log.status == "active") {
                        LinearProgressIndicator(modifier = Modifier.fillMaxWidth().height(3.dp).clip(RoundedCornerShape(2.dp)), color = AniShelfAccentBright, trackColor = AniShelfBackground)
                    } else {
                        LinearProgressIndicator(progress = { 1f }, modifier = Modifier.fillMaxWidth().height(3.dp).clip(RoundedCornerShape(2.dp)), color = AniShelfSuccess.copy(alpha = 0.65f), trackColor = AniShelfBackground)
                    }
                }
            }
        }
    }
}
