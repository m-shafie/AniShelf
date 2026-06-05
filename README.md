# AniShelf

Anime library manager with wireless SMB2/3 transfer to Android.

Built with Tauri (Rust) for Windows and Kotlin/Jetpack Compose for Android.

## Features

### Desktop App (Tauri)
- Browse and manage your anime collection locally
- Wireless file transfer to Android devices via SMB2/3 protocol
- Fast and lightweight native application

### Android Companion App
- SMB server running on your Android device
- Real-time transfer log with progress tracking
- Shared folder management (internal storage, SD card)
- WebView-based UI with dark theme
- Built on Kotlin + Jetpack Compose with native C++ SMB implementation

## Getting Started

### Desktop

```bash
npm install
npm run tauri dev
```

### Android

Open `android/` in Android Studio, sync Gradle, and run on a device.

## Build

### Desktop
```bash
npm run tauri build
```

### Android
```bash
cd android
./gradlew assembleRelease
```

## Tech Stack

| Component | Technology |
|-----------|------------|
| Desktop Frontend | Vanilla HTML/CSS/JS |
| Desktop Backend | Rust (Tauri v1.6) |
| Android UI | Kotlin, Jetpack Compose |
| Android DI | Hilt |
| SMB Protocol | Native C++ (JNI) |
| Transfer Protocol | SMB2/3 (desktop → Android) |

## License

Desktop: MIT · Android: Apache 2.0 (see `android/LICENSE`)
