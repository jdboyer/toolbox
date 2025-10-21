use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AudioDevice {
    name: String,
    id: String,
}

#[derive(Default)]
struct AudioState {
    primary_volume: Arc<Mutex<f32>>,
    secondary_volume: Arc<Mutex<f32>>,
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn get_audio_devices() -> Result<Vec<AudioDevice>, String> {
    let host = cpal::default_host();

    let mut devices = Vec::new();

    // Get input devices
    let input_devices = host.input_devices()
        .map_err(|e| format!("Failed to enumerate input devices: {}", e))?;

    for (index, device) in input_devices.enumerate() {
        if let Ok(name) = device.name() {
            devices.push(AudioDevice {
                name: name.clone(),
                id: format!("input_{}", index),
            });
        }
    }

    Ok(devices)
}

#[tauri::command]
fn start_monitoring(device_id: String, is_primary: bool, state: State<AudioState>) -> Result<(), String> {
    let host = cpal::default_host();

    // Parse device index from device_id
    let device_index: usize = device_id
        .strip_prefix("input_")
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "Invalid device ID".to_string())?;

    // Get the device
    let device = host.input_devices()
        .map_err(|e| format!("Failed to enumerate devices: {}", e))?
        .nth(device_index)
        .ok_or_else(|| "Device not found".to_string())?;

    let config = device.default_input_config()
        .map_err(|e| format!("Failed to get default input config: {}", e))?;

    let volume = if is_primary {
        Arc::clone(&state.primary_volume)
    } else {
        Arc::clone(&state.secondary_volume)
    };

    // Build the input stream
    let err_fn = |err| eprintln!("an error occurred on stream: {}", err);

    match config.sample_format() {
        cpal::SampleFormat::F32 => {
            let stream = device.build_input_stream(
                &config.into(),
                move |data: &[f32], _: &_| {
                    let rms = calculate_rms(data);
                    *volume.lock().unwrap() = rms;
                },
                err_fn,
                None,
            ).map_err(|e| format!("Failed to build input stream: {}", e))?;

            stream.play().map_err(|e| format!("Failed to play stream: {}", e))?;
            std::mem::forget(stream); // Keep stream alive
        }
        cpal::SampleFormat::I16 => {
            let stream = device.build_input_stream(
                &config.into(),
                move |data: &[i16], _: &_| {
                    let float_data: Vec<f32> = data.iter().map(|&s| s as f32 / i16::MAX as f32).collect();
                    let rms = calculate_rms(&float_data);
                    *volume.lock().unwrap() = rms;
                },
                err_fn,
                None,
            ).map_err(|e| format!("Failed to build input stream: {}", e))?;

            stream.play().map_err(|e| format!("Failed to play stream: {}", e))?;
            std::mem::forget(stream); // Keep stream alive
        }
        cpal::SampleFormat::U16 => {
            let stream = device.build_input_stream(
                &config.into(),
                move |data: &[u16], _: &_| {
                    let float_data: Vec<f32> = data.iter().map(|&s| (s as f32 / u16::MAX as f32) * 2.0 - 1.0).collect();
                    let rms = calculate_rms(&float_data);
                    *volume.lock().unwrap() = rms;
                },
                err_fn,
                None,
            ).map_err(|e| format!("Failed to build input stream: {}", e))?;

            stream.play().map_err(|e| format!("Failed to play stream: {}", e))?;
            std::mem::forget(stream); // Keep stream alive
        }
        _ => return Err("Unsupported sample format".to_string()),
    }

    Ok(())
}

#[tauri::command]
fn stop_monitoring(is_primary: bool, state: State<AudioState>) -> Result<(), String> {
    let volume = if is_primary {
        Arc::clone(&state.primary_volume)
    } else {
        Arc::clone(&state.secondary_volume)
    };

    *volume.lock().unwrap() = 0.0;
    Ok(())
}

#[tauri::command]
fn get_volume(is_primary: bool, state: State<AudioState>) -> Result<f32, String> {
    let volume = if is_primary {
        Arc::clone(&state.primary_volume)
    } else {
        Arc::clone(&state.secondary_volume)
    };

    let vol = *volume.lock().unwrap();
    // Convert to percentage (0-100) and apply some scaling
    let percentage = (vol * 100.0).min(100.0);
    Ok(percentage)
}

fn calculate_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }

    let sum_of_squares: f32 = samples.iter().map(|&s| s * s).sum();
    (sum_of_squares / samples.len() as f32).sqrt()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AudioState::default())
        .invoke_handler(tauri::generate_handler![
            get_audio_devices,
            start_monitoring,
            stop_monitoring,
            get_volume
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
