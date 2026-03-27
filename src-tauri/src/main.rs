use std::thread;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;
use rand::Rng;
use serde::Serialize;

static STREAMS_STARTED: AtomicBool = AtomicBool::new(false);

// ==================== CANDLE ====================

#[derive(Serialize, Clone)]
struct Candle {
    symbol: String,
    time: u64,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
}

// ==================== TIME ====================

fn current_timestamp() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

// ==================== TIMEFRAME ====================

#[derive(Clone, Copy)]
enum Timeframe {
    S15,
    M1,
    M3,
}

impl Timeframe {
    fn duration(&self) -> u64 {
        match self {
            Timeframe::S15 => 15,
            Timeframe::M1 => 60,
            Timeframe::M3 => 180,
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            Timeframe::S15 => "15s",
            Timeframe::M1 => "1m",
            Timeframe::M3 => "3m",
        }
    }
}

// ==================== BUILDER ====================

struct CandleBuilder {
    timeframe: Timeframe,
    start_time: u64,
    current: Candle,
}

impl CandleBuilder {
    fn new(symbol: String, timeframe: Timeframe, price: f64) -> Self {
        let now = current_timestamp();
        let aligned = now - (now % timeframe.duration());

        Self {
            timeframe,
            start_time: aligned,
            current: Candle {
                symbol,
                time: aligned,
                open: price,
                high: price,
                low: price,
                close: price,
            },
        }
    }

    fn update(&mut self, price: f64) -> Option<Candle> {
        let now = current_timestamp();

        // same candle
        if now < self.start_time + self.timeframe.duration() {
            self.current.close = price;
            self.current.high = self.current.high.max(price);
            self.current.low = self.current.low.min(price);
            return None;
        }

        // close candle
        let finished = self.current.clone();

        // start new aligned candle
        let aligned = now - (now % self.timeframe.duration());

        self.start_time = aligned;
        self.current = Candle {
            symbol: finished.symbol.clone(),
            time: aligned,
            open: price,
            high: price,
            low: price,
            close: price,
        };

        Some(finished)
    }
}

// ==================== STREAM ENGINE ====================

fn start_symbol_stream(app: tauri::AppHandle, symbol: &str, base_price: f64) {
    let symbol = symbol.to_string();

    thread::spawn(move || {
        let mut price = base_price;
        let mut rng = rand::thread_rng();

        let timeframes = vec![
            Timeframe::S15,
            Timeframe::M1,
            Timeframe::M3,
        ];

        let mut builders: Vec<CandleBuilder> = timeframes
            .iter()
            .map(|tf| CandleBuilder::new(symbol.clone(), *tf, price))
            .collect();

        loop {
            let change: f64 = rng.gen_range(-2.0..2.0);
            price += change;

            for builder in builders.iter_mut() {

                // 🔥 UPDATE CURRENT
                builder.current.close = price;
                builder.current.high = builder.current.high.max(price);
                builder.current.low = builder.current.low.min(price);

                // 🔥 LIVE EVENT
                app.emit(
                    &format!("candle_live_{}_{}", builder.timeframe.as_str(), symbol),
                    builder.current.clone(),
                ).unwrap();

                // 🔥 CLOSE EVENT
                if let Some(closed) = builder.update(price) {
                    app.emit(
                        &format!("candle_new_{}_{}", builder.timeframe.as_str(), symbol),
                        closed,
                    ).unwrap();
                }
            }

            thread::sleep(std::time::Duration::from_millis(100));
        }
    });
}

// ==================== COMMAND ====================

#[tauri::command]
fn start_all_streams(app: tauri::AppHandle) {
    if STREAMS_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    start_symbol_stream(app.clone(), "nq", 18000.0);
    start_symbol_stream(app.clone(), "es", 5000.0);
}

// ==================== MAIN ====================

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![start_all_streams])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}