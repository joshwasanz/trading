use rand::Rng;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use tauri::{AppHandle, Emitter};

static STREAMS_STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize)]
struct Candle {
    symbol: String,
    time: u64,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
}

#[derive(Debug, Clone, Serialize)]
struct LiveCandleEvent {
    symbol: String,
    timeframe: String,
    time: u64,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
}

#[derive(Debug, Clone, Serialize)]
struct SupportedSymbol {
    id: String,
    label: String,
}

#[derive(Debug, Clone, Copy)]
enum Timeframe {
    S15,
    M1,
    M3,
}

impl Timeframe {
    fn duration(self) -> u64 {
        match self {
            Self::S15 => 15,
            Self::M1 => 60,
            Self::M3 => 180,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::S15 => "15s",
            Self::M1 => "1m",
            Self::M3 => "3m",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "15s" => Some(Self::S15),
            "1m" => Some(Self::M1),
            "3m" => Some(Self::M3),
            _ => None,
        }
    }
}

struct CandleBuilder {
    timeframe: Timeframe,
    start_time: u64,
    current: Candle,
}

impl CandleBuilder {
    fn new(symbol: String, timeframe: Timeframe, price: f64) -> Self {
        let now = current_timestamp();
        let aligned = align_timestamp(now, timeframe);

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

        if now < self.start_time + self.timeframe.duration() {
            self.current.close = price;
            self.current.high = self.current.high.max(price);
            self.current.low = self.current.low.min(price);
            return None;
        }

        let finished = self.current.clone();
        let aligned = align_timestamp(now, self.timeframe);

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

fn current_timestamp() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn align_timestamp(timestamp: u64, timeframe: Timeframe) -> u64 {
    timestamp - (timestamp % timeframe.duration())
}

fn supported_symbols() -> Vec<SupportedSymbol> {
    vec![
        SupportedSymbol {
            id: "nq".to_string(),
            label: "NASDAQ".to_string(),
        },
        SupportedSymbol {
            id: "es".to_string(),
            label: "S&P 500".to_string(),
        },
    ]
}

fn base_price_for_symbol(symbol: &str) -> f64 {
    match symbol {
        "nq" => 18_000.0,
        "es" => 5_000.0,
        _ => 1_000.0,
    }
}

fn emit_candle(
    app: &AppHandle,
    symbol: &str,
    timeframe: Timeframe,
    candle: &Candle,
) -> Result<(), String> {
    let payload = LiveCandleEvent {
        symbol: candle.symbol.clone(),
        timeframe: timeframe.as_str().to_string(),
        time: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
    };

    let event_name = format!("candle://{symbol}/{}", timeframe.as_str());
    app.emit(&event_name, payload).map_err(|error| error.to_string())
}

fn start_symbol_stream(app: AppHandle, symbol: &str, base_price: f64) {
    let symbol = symbol.to_string();

    thread::spawn(move || {
        let mut price = base_price;
        let mut rng = rand::thread_rng();
        let mut builders = vec![
            CandleBuilder::new(symbol.clone(), Timeframe::S15, price),
            CandleBuilder::new(symbol.clone(), Timeframe::M1, price),
            CandleBuilder::new(symbol.clone(), Timeframe::M3, price),
        ];

        loop {
            let change: f64 = rng.gen_range(-2.0..2.0);
            price += change;

            for builder in &mut builders {
                if let Some(closed) = builder.update(price) {
                    let _ = emit_candle(&app, &symbol, builder.timeframe, &closed);
                }

                let _ = emit_candle(&app, &symbol, builder.timeframe, &builder.current);
            }

            thread::sleep(std::time::Duration::from_millis(100));
        }
    });
}

fn ensure_streams_started(app: AppHandle) {
    if STREAMS_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    for symbol in supported_symbols() {
        start_symbol_stream(app.clone(), &symbol.id, base_price_for_symbol(&symbol.id));
    }
}

fn generate_historical_candles(
    symbol: &str,
    timeframe: Timeframe,
    from: Option<u64>,
    to: Option<u64>,
    limit: Option<usize>,
) -> Vec<Candle> {
    let mut rng = rand::thread_rng();
    let end_time = align_timestamp(to.unwrap_or_else(current_timestamp), timeframe);
    let derived_limit = from
        .map(|start| {
            let aligned_start = align_timestamp(start, timeframe);
            let span = end_time.saturating_sub(aligned_start);
            ((span / timeframe.duration()) as usize).saturating_add(1)
        })
        .unwrap_or(300);
    let candle_count = limit.unwrap_or(derived_limit).clamp(1, 2_000);
    let first_time = end_time.saturating_sub(
        ((candle_count.saturating_sub(1)) as u64).saturating_mul(timeframe.duration()),
    );
    let mut price = base_price_for_symbol(symbol);
    let mut candles = Vec::with_capacity(candle_count);

    for index in 0..candle_count {
        let time = first_time + (index as u64 * timeframe.duration());
        let open = price;
        let close = open + rng.gen_range(-8.0..8.0);
        let high = open.max(close) + rng.gen_range(0.25..3.5);
        let low = open.min(close) - rng.gen_range(0.25..3.5);
        price = close;

        candles.push(Candle {
            symbol: symbol.to_string(),
            time,
            open,
            high,
            low,
            close,
        });
    }

    candles
        .into_iter()
        .filter(|candle| from.map(|start| candle.time >= start).unwrap_or(true))
        .filter(|candle| to.map(|end| candle.time <= end).unwrap_or(true))
        .collect()
}

#[tauri::command]
fn get_supported_symbols() -> Vec<SupportedSymbol> {
    supported_symbols()
}

#[tauri::command]
fn get_historical(
    symbol: String,
    timeframe: String,
    from: Option<u64>,
    to: Option<u64>,
    limit: Option<usize>,
) -> Result<Vec<Candle>, String> {
    let timeframe = Timeframe::parse(&timeframe)
        .ok_or_else(|| format!("Unsupported timeframe: {timeframe}"))?;

    Ok(generate_historical_candles(
        &symbol, timeframe, from, to, limit,
    ))
}

#[tauri::command]
fn subscribe_live(app: AppHandle, symbol: String, timeframe: String) -> Result<(), String> {
    let symbol_supported = supported_symbols().iter().any(|item| item.id == symbol);
    if !symbol_supported {
        return Err(format!("Unsupported symbol: {symbol}"));
    }

    Timeframe::parse(&timeframe).ok_or_else(|| format!("Unsupported timeframe: {timeframe}"))?;
    ensure_streams_started(app);
    Ok(())
}

#[tauri::command]
fn unsubscribe_live(symbol: String, timeframe: String) -> Result<(), String> {
    let _ = (symbol, timeframe);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_supported_symbols,
            get_historical,
            subscribe_live,
            unsubscribe_live
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
