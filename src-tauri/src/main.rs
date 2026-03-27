use std::thread;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;
use rand::Rng;
use serde::Serialize;

static STREAMS_STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Clone)]
struct Candle {
    symbol: String,
    time: u64,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
}

fn current_timestamp() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn start_symbol_stream(app: tauri::AppHandle, symbol: &str, base_price: f64) {
    let symbol = symbol.to_string();
    thread::spawn(move || {
        let mut price = base_price;
        let mut rng = rand::thread_rng();
        let mut current_candle = Candle {
            symbol: symbol.clone(),
            time: current_timestamp(),
            open: price,
            high: price,
            low: price,
            close: price,
        };
        let mut last_time = current_timestamp();

        loop {
            let change: f64 = rng.gen_range(-2.0..2.0);
            price += change;
            let now = current_timestamp();

            current_candle.close = price;
            current_candle.high = current_candle.high.max(price);
            current_candle.low = current_candle.low.min(price);

            app.emit(&format!("candle_live_{}", symbol), current_candle.clone()).unwrap();

            if now - last_time >= 5 {
                app.emit(&format!("candle_new_{}", symbol), current_candle.clone()).unwrap();
                current_candle = Candle {
                    symbol: symbol.clone(),
                    time: now,
                    open: price,
                    high: price,
                    low: price,
                    close: price,
                };
                last_time = now;
            }

            thread::sleep(std::time::Duration::from_millis(100));
        }
    });
}

#[tauri::command]
fn start_all_streams(app: tauri::AppHandle) {
    if STREAMS_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    start_symbol_stream(app.clone(), "nq", 18000.0);
    start_symbol_stream(app.clone(), "es", 5000.0);
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![start_all_streams])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}