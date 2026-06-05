package com.example.android.architecture.blueprints.anishelf

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color

// ─────────────────────────────────────────────────────────────────────────────
//  THEME VARIANTS
// ─────────────────────────────────────────────────────────────────────────────

enum class AniShelfThemeVariant { MOTOKO, MAKIMA, TOMOKO }

// ─────────────────────────────────────────────────────────────────────────────
//  GLOBAL THEME STATE  — observed by the whole UI
// ─────────────────────────────────────────────────────────────────────────────

object AniShelfThemeState {
    var current by mutableStateOf(AniShelfThemeVariant.MOTOKO)
        private set

    fun next() {
        current = when (current) {
            AniShelfThemeVariant.MOTOKO -> AniShelfThemeVariant.MAKIMA
            AniShelfThemeVariant.MAKIMA -> AniShelfThemeVariant.TOMOKO
            AniShelfThemeVariant.TOMOKO -> AniShelfThemeVariant.MOTOKO
        }
    }

    fun restore(variant: AniShelfThemeVariant) {
        current = variant
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  PER-THEME PALETTES  (matching the Windows app's CSS themes)
// ─────────────────────────────────────────────────────────────────────────────

// Motoko's Shell — deep violet/indigo + gold
private object MotokoColors {
    val Background    = Color(0xFF0A0515)
    val Surface       = Color(0xFF120A24)
    val Card          = Color(0xFF150D2A)
    val Accent        = Color(0xFF8B5CF6)
    val AccentBright  = Color(0xFFA78BFA)
    val Gold          = Color(0xFFFBBF24)
    val Success       = Color(0xFF34D399)
    val Danger        = Color(0xFFEF4444)
    val TextPrimary   = Color(0xFFF0EDF8)
    val TextSecondary = Color(0xFF9D8FC0)
}

// Makima's Control — charcoal black + crimson red
private object MakimaColors {
    val Background    = Color(0xFF080808)
    val Surface       = Color(0xFF121010)
    val Card          = Color(0xFF141212)
    val Accent        = Color(0xFFDC2626)
    val AccentBright  = Color(0xFFEF4444)
    val Gold          = Color(0xFFFBBF24)
    val Success       = Color(0xFF34D399)
    val Danger        = Color(0xFFEF4444)
    val TextPrimary   = Color(0xFFF0E8E8)
    val TextSecondary = Color(0xFFB08888)
}

// Tomoko's Sunshine — warm cream/beige + coral pink
private object TomokoColors {
    val Background    = Color(0xFFF5EDE4)
    val Surface       = Color(0xFFEDDDD2)
    val Card          = Color(0xFFF5EDE2)
    val Accent        = Color(0xFFD63A8A)
    val AccentBright  = Color(0xFFE8589F)
    val Gold          = Color(0xFFF59E0B)
    val Success       = Color(0xFF1E8F60)
    val Danger        = Color(0xFFC0392B)
    val TextPrimary   = Color(0xFF1A120C)
    val TextSecondary = Color(0xFF4A3828)
}

// ─────────────────────────────────────────────────────────────────────────────
//  SEMANTIC COLOR ACCESSORS  — always read from the active theme
// ─────────────────────────────────────────────────────────────────────────────

val AniShelfBackground: Color
    get() = when (AniShelfThemeState.current) {
        AniShelfThemeVariant.MOTOKO -> MotokoColors.Background
        AniShelfThemeVariant.MAKIMA -> MakimaColors.Background
        AniShelfThemeVariant.TOMOKO -> TomokoColors.Background
    }

val AniShelfSurface: Color
    get() = when (AniShelfThemeState.current) {
        AniShelfThemeVariant.MOTOKO -> MotokoColors.Surface
        AniShelfThemeVariant.MAKIMA -> MakimaColors.Surface
        AniShelfThemeVariant.TOMOKO -> TomokoColors.Surface
    }

val AniShelfCard: Color
    get() = when (AniShelfThemeState.current) {
        AniShelfThemeVariant.MOTOKO -> MotokoColors.Card
        AniShelfThemeVariant.MAKIMA -> MakimaColors.Card
        AniShelfThemeVariant.TOMOKO -> TomokoColors.Card
    }

val AniShelfAccent: Color
    get() = when (AniShelfThemeState.current) {
        AniShelfThemeVariant.MOTOKO -> MotokoColors.Accent
        AniShelfThemeVariant.MAKIMA -> MakimaColors.Accent
        AniShelfThemeVariant.TOMOKO -> TomokoColors.Accent
    }

val AniShelfAccentBright: Color
    get() = when (AniShelfThemeState.current) {
        AniShelfThemeVariant.MOTOKO -> MotokoColors.AccentBright
        AniShelfThemeVariant.MAKIMA -> MakimaColors.AccentBright
        AniShelfThemeVariant.TOMOKO -> TomokoColors.AccentBright
    }

val AniShelfGold: Color
    get() = when (AniShelfThemeState.current) {
        AniShelfThemeVariant.MOTOKO -> MotokoColors.Gold
        AniShelfThemeVariant.MAKIMA -> MakimaColors.Gold
        AniShelfThemeVariant.TOMOKO -> TomokoColors.Gold
    }

val AniShelfSuccess: Color
    get() = when (AniShelfThemeState.current) {
        AniShelfThemeVariant.MOTOKO -> MotokoColors.Success
        AniShelfThemeVariant.MAKIMA -> MakimaColors.Success
        AniShelfThemeVariant.TOMOKO -> TomokoColors.Success
    }

val AniShelfDanger: Color
    get() = when (AniShelfThemeState.current) {
        AniShelfThemeVariant.MOTOKO -> MotokoColors.Danger
        AniShelfThemeVariant.MAKIMA -> MakimaColors.Danger
        AniShelfThemeVariant.TOMOKO -> TomokoColors.Danger
    }

val AniShelfTextPrimary: Color
    get() = when (AniShelfThemeState.current) {
        AniShelfThemeVariant.MOTOKO -> MotokoColors.TextPrimary
        AniShelfThemeVariant.MAKIMA -> MakimaColors.TextPrimary
        AniShelfThemeVariant.TOMOKO -> TomokoColors.TextPrimary
    }

val AniShelfTextSecondary: Color
    get() = when (AniShelfThemeState.current) {
        AniShelfThemeVariant.MOTOKO -> MotokoColors.TextSecondary
        AniShelfThemeVariant.MAKIMA -> MakimaColors.TextSecondary
        AniShelfThemeVariant.TOMOKO -> TomokoColors.TextSecondary
    }

// ─────────────────────────────────────────────────────────────────────────────
//  MATERIAL THEME WRAPPER
// ─────────────────────────────────────────────────────────────────────────────

@Composable
fun AniShelfTheme(content: @Composable () -> Unit) {
    val variant = AniShelfThemeState.current

    val colorScheme = when (variant) {
        AniShelfThemeVariant.TOMOKO -> lightColorScheme(
            primary    = TomokoColors.Accent,
            onPrimary  = Color.White,
            secondary  = TomokoColors.Gold,
            onSecondary = Color.Black,
            surface    = TomokoColors.Surface,
            onSurface  = TomokoColors.TextPrimary,
            background = TomokoColors.Background,
            onBackground = TomokoColors.TextPrimary,
            error      = TomokoColors.Danger,
            onError    = Color.White
        )
        AniShelfThemeVariant.MAKIMA -> darkColorScheme(
            primary    = MakimaColors.Accent,
            onPrimary  = Color.White,
            secondary  = MakimaColors.Gold,
            onSecondary = Color.Black,
            surface    = MakimaColors.Surface,
            onSurface  = MakimaColors.TextPrimary,
            background = MakimaColors.Background,
            onBackground = MakimaColors.TextPrimary,
            error      = MakimaColors.Danger,
            onError    = Color.White
        )
        AniShelfThemeVariant.MOTOKO -> darkColorScheme(
            primary    = MotokoColors.Accent,
            onPrimary  = Color.White,
            secondary  = MotokoColors.Gold,
            onSecondary = Color.Black,
            surface    = MotokoColors.Surface,
            onSurface  = MotokoColors.TextPrimary,
            background = MotokoColors.Background,
            onBackground = MotokoColors.TextPrimary,
            error      = MotokoColors.Danger,
            onError    = Color.White
        )
    }

    MaterialTheme(
        colorScheme = colorScheme,
        content = content
    )
}