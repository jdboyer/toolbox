# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is a personal toolbox repository containing reusable components and templates. Currently contains a Tauri application template.

## Project Structure

```
toolbox/
├── hello-tauri/tauri-template/    # Tauri + React + TypeScript template
│   ├── src/                        # React frontend (TypeScript + Vite)
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

- **Frontend**: React 18 + TypeScript + Vite
  - Entry point: `src/main.tsx`
  - Main component: `src/App.tsx`
  - Uses Tauri API v2 for frontend-backend communication

- **Backend**: Rust + Tauri v2
  - `lib.rs` contains the main application logic and Tauri command handlers
  - `main.rs` is a minimal entry point that calls `lib.rs::run()`
  - Commands are registered using `tauri::generate_handler![]` macro
  - Uses staticlib, cdylib, and rlib crate types for cross-platform compatibility

- **Frontend-Backend Communication**:
  - Frontend invokes Rust functions using `invoke()` from `@tauri-apps/api/core`
  - Backend functions are decorated with `#[tauri::command]` macro
  - Example: `greet` command demonstrates bi-directional communication

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

- **`Cargo.toml`**: Rust dependencies and crate configuration
  - Multiple crate types (`staticlib`, `cdylib`, `rlib`) for platform compatibility
  - Uses Tauri v2 and serde for serialization

## Adding New Tauri Commands

1. Define command function in `src-tauri/src/lib.rs` with `#[tauri::command]` attribute
2. Add function name to `tauri::generate_handler![]` macro in `lib.rs::run()`
3. Invoke from frontend using `invoke("command_name", { args })`

## Platform Considerations

- Windows builds use `windows_subsystem = "windows"` to prevent console window in release mode
- Cross-platform icons defined in `src-tauri/icons/` directory
- WebView2 is used on Windows (dependencies visible in build artifacts)
