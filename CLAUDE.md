# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is a personal toolbox repository containing reusable components and templates. Currently contains a Tauri application template with audio monitoring capabilities.

## Project Structure

```
toolbox/
├── hello-tauri/tauri-template/    # Tauri + React + TypeScript template
│   ├── src/                        # React frontend (TypeScript + Vite)
│   │   ├── sampler/               # Audio sampler components
│   │   ├── sidebar/               # Sidebar UI components
│   │   ├── App.tsx                # Main app layout (Flex layout)
│   │   └── main.tsx               # Entry point with Mantine provider
│   ├── src-tauri/                  # Rust backend
│   │   ├── src/
│   │   │   ├── main.rs            # Application entry point
│   │   │   └── lib.rs             # Tauri commands and app setup
│   │   ├── tauri.conf.json        # Tauri configuration
│   │   └── Cargo.toml             # Rust dependencies
│   └── package.json               # Frontend dependencies
```

## Tauri Template Architecture

The Tauri template follows a hybrid architecture:

- **Frontend**: React 18 + TypeScript + Vite + Mantine UI
  - Entry point: `src/main.tsx` (wraps App in MantineProvider)
  - Main component: `src/App.tsx` (Flex layout with Sidebar and Sampler)
  - UI library: Mantine v7 with PostCSS preset for styling
  - Icons: Tabler Icons React
  - Uses Tauri API v2 for frontend-backend communication via `invoke()`
  - Installed plugins: `tauri-plugin-opener`, `tauri-plugin-dialog`

- **Backend**: Rust + Tauri v2 + Audio Processing
  - `lib.rs` contains the main application logic and Tauri command handlers
  - `main.rs` is a minimal entry point that calls `lib.rs::run()`
  - Commands are registered using `tauri::generate_handler![]` macro
  - Uses staticlib, cdylib, and rlib crate types for cross-platform compatibility
  - Audio capabilities:
    - `cpal` library for cross-platform audio device access
    - `AudioState` struct with shared state using `Arc<Mutex<f32>>`
    - Supports dual-channel monitoring (primary/secondary)
    - RMS volume calculation for real-time audio level monitoring
  - Async runtime: Tokio with multi-threaded runtime

- **Frontend-Backend Communication**:
  - Frontend invokes Rust functions using `invoke()` from `@tauri-apps/api/core`
  - Backend functions are decorated with `#[tauri::command]` macro
  - Current commands: `get_audio_devices`, `start_monitoring`, `stop_monitoring`, `get_volume`
  - State management via Tauri's `.manage()` for shared AudioState

## Development Commands

### Tauri Template (`hello-tauri/tauri-template`)

**Note**: This template uses Deno for frontend build tasks (configured in `tauri.conf.json`), not npm/yarn.

- **Development mode**: `cargo tauri dev` or `deno task tauri dev`
  - Runs frontend dev server at `http://localhost:1420`
  - Automatically executes `deno task dev` before launching
  - Hot-reload enabled for both frontend and backend changes

- **Build for production**: `cargo tauri build` or `deno task tauri build`
  - Executes `deno task build` to compile frontend
  - Compiles Rust backend and creates platform-specific binaries

- **Frontend only** (without Tauri):
  - `deno task dev` - Start Vite dev server
  - `deno task build` - Build frontend to `dist/`
  - `deno task preview` - Preview production build

- **Rust backend**:
  - `cargo build` - Build Rust code (from `src-tauri/` directory)
  - `cargo check` - Fast type checking
  - `cargo clippy` - Lint Rust code
  - `cargo test` - Run Rust tests

## Key Configuration Files

- **`tauri.conf.json`**: Defines app metadata, build commands, window settings, and bundle configuration
  - `beforeDevCommand`: Uses Deno task runner instead of npm
  - `beforeBuildCommand`: Uses Deno for production builds
  - Library name uses `_lib` suffix to avoid Windows naming conflicts with binary
  - Window label set to `"main"` for capability-based permissions
  - Plugin permissions defined under `app.security.capabilities`

- **`Cargo.toml`**: Rust dependencies and crate configuration
  - Multiple crate types (`staticlib`, `cdylib`, `rlib`) for platform compatibility
  - Uses Tauri v2 and serde for serialization

## Debugging Tauri Applications

- **Frontend Console**: Right-click in the app window → "Inspect" → "Console" tab (shows React/JS logs)
- **Backend Console**: Terminal where `cargo tauri dev` is running (shows Rust logs)
- DevTools automatically open in development mode for debugging frontend issues

## Adding New Tauri Plugins

Tauri v2 uses a capability-based permission system. To add a new plugin:

1. **Add dependencies**:
   - Add `tauri-plugin-<name>` to `src-tauri/Cargo.toml`
   - Add `@tauri-apps/plugin-<name>` to `package.json`
   - Run `deno install` to install frontend dependencies

2. **Register plugin** in `src-tauri/src/lib.rs`:
   ```rust
   tauri::Builder::default()
       .plugin(tauri_plugin_<name>::init())
       // ...
   ```

3. **Configure permissions** in `src-tauri/tauri.conf.json`:
   - Ensure the main window has a `label` (e.g., `"label": "main"`)
   - Add capabilities under `app.security.capabilities`:
   ```json
   "capabilities": [
     {
       "identifier": "main-capability",
       "description": "Capability for the main window",
       "windows": ["main"],
       "permissions": [
         "core:default",
         "plugin-name:allow-command"
       ]
     }
   ]
   ```

4. **Use in frontend**:
   ```typescript
   import { command } from "@tauri-apps/plugin-name";
   const result = await command();
   ```

**Example: Dialog Plugin**
- Dependencies: `tauri-plugin-dialog` + `@tauri-apps/plugin-dialog`
- Permissions: `dialog:allow-open`, `dialog:allow-save`
- Usage: `import { open } from "@tauri-apps/plugin-dialog"`

**Important**: Configuration changes require restarting the dev server.

## Adding New Tauri Commands

1. Define command function in `src-tauri/src/lib.rs` with `#[tauri::command]` attribute
2. Add function name to `tauri::generate_handler![]` macro in `lib.rs::run()`
3. If the command needs shared state, add it to the state struct and pass as `State<T>` parameter
4. Invoke from frontend using `invoke("command_name", { args })` from `@tauri-apps/api/core`

Example pattern for stateful commands:
```rust
#[tauri::command]
fn my_command(param: String, state: State<MyState>) -> Result<ReturnType, String> {
    // Implementation
}
```

## Audio Monitoring Architecture

The template includes a complete audio monitoring system:

- **Device Enumeration**: `get_audio_devices()` returns list of available input devices with unique IDs
- **Stream Management**: `start_monitoring()` creates audio input streams using cpal
  - Handles multiple sample formats (F32, I16, U16)
  - Streams are kept alive using `std::mem::forget()` to prevent premature drop
  - Volume data stored in shared `Arc<Mutex<f32>>` state
- **Volume Calculation**: RMS (Root Mean Square) algorithm for real-time audio level measurement
- **Dual Channel Support**: Independent primary/secondary volume monitoring
- **State Pattern**: `AudioState` struct managed by Tauri, accessible across all commands

Note: Audio streams are currently forgotten after start. Consider implementing proper stream lifecycle management for production use.

## Platform Considerations

- Windows builds use `windows_subsystem = "windows"` to prevent console window in release mode
- Cross-platform icons defined in `src-tauri/icons/` directory
- WebView2 is used on Windows (dependencies visible in build artifacts)
- Audio device access may require permissions on some platforms
