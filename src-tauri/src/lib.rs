use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

static SYMBOL_STATES: LazyLock<Mutex<HashMap<String, SymbolState>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static LIVE_SUBSCRIPTIONS: LazyLock<Mutex<HashMap<StreamKey, usize>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static SYMBOL_STREAMS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, Copy)]
struct SymbolState {
    last_price: f64,
    last_time: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct StreamKey {
    symbol: String,
    timeframe: Timeframe,
}

#[derive(Debug, Clone, Copy, Default)]
struct ActiveTimeframes {
    s15: bool,
    m1: bool,
    m3: bool,
}

impl ActiveTimeframes {
    fn is_empty(self) -> bool {
        !self.s15 && !self.m1 && !self.m3
    }

    fn includes(self, timeframe: Timeframe) -> bool {
        match timeframe {
            Timeframe::S15 => self.s15,
            Timeframe::M1 => self.m1,
            Timeframe::M3 => self.m3,
        }
    }
}

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
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
    fn from_current(timeframe: Timeframe, current: Candle) -> Self {
        Self {
            timeframe,
            start_time: current.time,
            current,
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

fn is_supported_symbol(symbol: &str) -> bool {
    supported_symbols().iter().any(|item| item.id == symbol)
}

fn base_price_for_symbol(symbol: &str) -> f64 {
    match symbol {
        "nq" => 18_000.0,
        "es" => 5_000.0,
        _ => 1_000.0,
    }
}

fn symbol_seed(symbol: &str) -> u64 {
    symbol.bytes().fold(0_u64, |acc, byte| {
        acc.wrapping_mul(31).wrapping_add(byte as u64)
    })
}

fn deterministic_hash(symbol: &str, timeframe: Timeframe, time: u64, salt: u64) -> u64 {
    let mut value = symbol_seed(symbol)
        ^ timeframe.duration().wrapping_mul(1_000_003)
        ^ time.wrapping_mul(0x9E37_79B9_7F4A_7C15)
        ^ salt.wrapping_mul(0xC2B2_AE3D_27D4_EB4F);

    value ^= value >> 33;
    value = value.wrapping_mul(0xff51_afd7_ed55_8ccd);
    value ^= value >> 33;
    value = value.wrapping_mul(0xc4ce_b9fe_1a85_ec53);
    value ^= value >> 33;
    value
}

fn deterministic_signed(symbol: &str, timeframe: Timeframe, time: u64, salt: u64) -> f64 {
    let hash = deterministic_hash(symbol, timeframe, time, salt);
    (hash as f64 / u64::MAX as f64) * 2.0 - 1.0
}

fn store_symbol_state(symbol: &str, time: u64, price: f64) {
    if let Ok(mut states) = SYMBOL_STATES.lock() {
        let should_update = states
            .get(symbol)
            .map(|state| time >= state.last_time)
            .unwrap_or(true);

        if should_update {
            states.insert(
                symbol.to_string(),
                SymbolState {
                    last_price: price,
                    last_time: time,
                },
            );
        }
    }
}

fn read_symbol_state(symbol: &str) -> Option<SymbolState> {
    SYMBOL_STATES
        .lock()
        .ok()
        .and_then(|states| states.get(symbol).copied())
}

fn current_timestamp_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn base_tick_volatility(symbol: &str) -> f64 {
    match symbol {
        "nq" => 0.55,
        "es" => 0.18,
        _ => 0.08,
    }
}

fn timeframe_noise_scale(timeframe: Timeframe) -> f64 {
    match timeframe {
        Timeframe::S15 => 1.0,
        Timeframe::M1 => 1.9,
        Timeframe::M3 => 3.2,
    }
}

fn market_anchor_price(symbol: &str, time_secs: u64) -> f64 {
    let base = base_price_for_symbol(symbol);
    let offset = (symbol_seed(symbol) % 3_600) as f64;
    let t = time_secs as f64 + offset;
    let slow_trend = (t / 5_400.0).sin() * base * 0.0011;
    let medium_cycle = (t / 1_200.0).cos() * base * 0.00065;
    let longer_bias = (t / 21_600.0).sin() * base * 0.0018;

    base + slow_trend + medium_cycle + longer_bias
}

fn evolve_live_price(symbol: &str, time_millis: u64, previous_price: f64) -> f64 {
    let time_secs = time_millis / 1_000;
    let anchor = market_anchor_price(symbol, time_secs);
    let volatility = base_tick_volatility(symbol);
    let pull = (anchor - previous_price) * 0.08;
    let micro = deterministic_signed(symbol, Timeframe::S15, time_millis / 250, 91)
        * volatility
        * 0.65;
    let momentum = deterministic_signed(symbol, Timeframe::S15, time_millis / 500, 92)
        * volatility
        * 0.25;

    (previous_price + pull + micro + momentum).max(1.0)
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

fn active_timeframes_for_symbol(symbol: &str) -> ActiveTimeframes {
    let mut active = ActiveTimeframes::default();

    if let Ok(subscriptions) = LIVE_SUBSCRIPTIONS.lock() {
        for (key, count) in subscriptions.iter() {
            if *count == 0 || key.symbol != symbol {
                continue;
            }

            match key.timeframe {
                Timeframe::S15 => active.s15 = true,
                Timeframe::M1 => active.m1 = true,
                Timeframe::M3 => active.m3 = true,
            }
        }
    }

    active
}

fn current_candle_snapshot(symbol: &str, timeframe: Timeframe) -> Candle {
    let now = align_timestamp(current_timestamp(), timeframe);

    generate_historical_candles(symbol, timeframe, Some(now), Some(now), Some(1))
        .into_iter()
        .next()
        .unwrap_or_else(|| Candle {
            symbol: symbol.to_string(),
            time: now,
            open: base_price_for_symbol(symbol),
            high: base_price_for_symbol(symbol),
            low: base_price_for_symbol(symbol),
            close: base_price_for_symbol(symbol),
        })
}

fn start_symbol_stream(app: AppHandle, symbol: String, should_run: Arc<AtomicBool>) {
    let stream_symbol = symbol.clone();

    thread::spawn(move || {
        let initial_15s = current_candle_snapshot(&stream_symbol, Timeframe::S15);
        let initial_price = read_symbol_state(&stream_symbol)
            .filter(|state| state.last_time + Timeframe::S15.duration() * 2 >= current_timestamp())
            .map(|state| state.last_price)
            .unwrap_or(initial_15s.close);
        let mut price = initial_price;
        let mut builders = vec![
            CandleBuilder::from_current(
                Timeframe::S15,
                Candle {
                    close: initial_price,
                    high: initial_15s.high.max(initial_price),
                    low: initial_15s.low.min(initial_price),
                    open: initial_15s.open,
                    ..initial_15s
                },
            ),
            CandleBuilder::from_current(
                Timeframe::M1,
                current_candle_snapshot(&stream_symbol, Timeframe::M1),
            ),
            CandleBuilder::from_current(
                Timeframe::M3,
                current_candle_snapshot(&stream_symbol, Timeframe::M3),
            ),
        ];

        while should_run.load(Ordering::Relaxed) {
            let active_timeframes = active_timeframes_for_symbol(&stream_symbol);
            if active_timeframes.is_empty() {
                break;
            }

            let now = current_timestamp_millis();
            price = evolve_live_price(&stream_symbol, now, price);
            store_symbol_state(&stream_symbol, now / 1_000, price);

            for builder in &mut builders {
                let is_active = active_timeframes.includes(builder.timeframe);

                if let Some(closed) = builder.update(price) {
                    store_symbol_state(&stream_symbol, closed.time, closed.close);
                    if is_active {
                        let _ = emit_candle(&app, &stream_symbol, builder.timeframe, &closed);
                    }
                }

                if is_active {
                    let _ = emit_candle(&app, &stream_symbol, builder.timeframe, &builder.current);
                }
            }

            thread::sleep(std::time::Duration::from_millis(100));
        }

        if let Ok(mut symbol_streams) = SYMBOL_STREAMS.lock() {
            let should_remove = symbol_streams
                .get(&stream_symbol)
                .map(|current| Arc::ptr_eq(current, &should_run))
                .unwrap_or(false);

            if should_remove {
                symbol_streams.remove(&stream_symbol);
            }
        }
    });
}

fn generate_synthetic_candle(
    symbol: &str,
    timeframe: Timeframe,
    time: u64,
    previous_close: f64,
) -> Candle {
    let anchor = market_anchor_price(symbol, time);
    let volatility = base_tick_volatility(symbol) * timeframe_noise_scale(timeframe) * 4.0;
    let pull = (anchor - previous_close) * 0.24;
    let impulse = deterministic_signed(symbol, timeframe, time, 1) * volatility;
    let mean_reversion = deterministic_signed(symbol, timeframe, time, 2) * volatility * 0.35;
    let secondary = deterministic_signed(symbol, timeframe, time, 3) * volatility * 0.18;
    let open = previous_close;
    let close = (previous_close + pull + impulse + mean_reversion + secondary).max(1.0);
    let upper_wick =
        deterministic_signed(symbol, timeframe, time, 4).abs() * volatility * 0.7 + 0.15;
    let lower_wick =
        deterministic_signed(symbol, timeframe, time, 5).abs() * volatility * 0.7 + 0.15;
    let high = open.max(close) + upper_wick;
    let low = open.min(close) - lower_wick;

    Candle {
        symbol: symbol.to_string(),
        time,
        open,
        high,
        low,
        close,
    }
}

fn generate_historical_candles(
    symbol: &str,
    timeframe: Timeframe,
    from: Option<u64>,
    to: Option<u64>,
    limit: Option<usize>,
) -> Vec<Candle> {
    let step = timeframe.duration();
    let now = align_timestamp(current_timestamp(), timeframe);
    let default_limit = 300usize;
    let max_limit = 5_000usize;
    let requested_limit = limit.unwrap_or(default_limit).clamp(1, max_limit);
    let effective_to = align_timestamp(to.unwrap_or(now), timeframe);
    let effective_from = match from {
        Some(value) => align_timestamp(value, timeframe),
        None => effective_to.saturating_sub((requested_limit as u64).saturating_sub(1) * step),
    };

    if effective_from > effective_to {
        return Vec::new();
    }

    let total_candles_in_range = ((effective_to - effective_from) / step) as usize + 1;
    let actual_count = total_candles_in_range.min(requested_limit);
    let first_time =
        effective_to.saturating_sub((actual_count as u64).saturating_sub(1).saturating_mul(step));
    let warmup_steps = 50usize;
    let warmup_start = first_time.saturating_sub((warmup_steps as u64).saturating_mul(step));
    let mut price = base_price_for_symbol(symbol);
    let mut warmup_time = warmup_start;
    let mut candles = Vec::with_capacity(actual_count);

    for _ in 0..warmup_steps {
        let warmup = generate_synthetic_candle(symbol, timeframe, warmup_time, price);
        price = warmup.close;
        warmup_time = warmup_time.saturating_add(step);
    }

    for index in 0..actual_count {
        let time = first_time + (index as u64 * step);
        let candle = generate_synthetic_candle(symbol, timeframe, time, price);
        price = candle.close;
        candles.push(candle);
    }

    if let Some(last_candle) = candles.last() {
        store_symbol_state(symbol, last_candle.time, last_candle.close);
    }

    candles
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
    if let (Some(start), Some(end)) = (from, to) {
        if start > end {
            return Err("Invalid range: from must be <= to".to_string());
        }
    }

    if !is_supported_symbol(&symbol) {
        return Err(format!("Unsupported symbol: {symbol}"));
    }

    let timeframe = Timeframe::parse(&timeframe)
        .ok_or_else(|| format!("Unsupported timeframe: {timeframe}"))?;

    Ok(generate_historical_candles(
        &symbol, timeframe, from, to, limit,
    ))
}

#[tauri::command]
fn subscribe_live(app: AppHandle, symbol: String, timeframe: String) -> Result<(), String> {
    if !is_supported_symbol(&symbol) {
        return Err(format!("Unsupported symbol: {symbol}"));
    }

    let timeframe =
        Timeframe::parse(&timeframe).ok_or_else(|| format!("Unsupported timeframe: {timeframe}"))?;
    let key = StreamKey {
        symbol: symbol.clone(),
        timeframe,
    };

    {
        let mut subscriptions = LIVE_SUBSCRIPTIONS
            .lock()
            .map_err(|_| "live subscription registry lock failed".to_string())?;
        let entry = subscriptions.entry(key).or_insert(0);
        *entry += 1;
    }

    let should_start = {
        let mut symbol_streams = SYMBOL_STREAMS
            .lock()
            .map_err(|_| "symbol stream registry lock failed".to_string())?;

        if symbol_streams.contains_key(&symbol) {
            None
        } else {
            let should_run = Arc::new(AtomicBool::new(true));
            symbol_streams.insert(symbol.clone(), should_run.clone());
            Some(should_run)
        }
    };

    if let Some(should_run) = should_start {
        start_symbol_stream(app, symbol, should_run);
    }

    Ok(())
}

#[tauri::command]
fn unsubscribe_live(symbol: String, timeframe: String) -> Result<(), String> {
    if !is_supported_symbol(&symbol) {
        return Err(format!("Unsupported symbol: {symbol}"));
    }

    let timeframe =
        Timeframe::parse(&timeframe).ok_or_else(|| format!("Unsupported timeframe: {timeframe}"))?;
    let key = StreamKey {
        symbol: symbol.clone(),
        timeframe,
    };

    let should_stop_symbol = {
        let mut subscriptions = LIVE_SUBSCRIPTIONS
            .lock()
            .map_err(|_| "live subscription registry lock failed".to_string())?;

        match subscriptions.get_mut(&key) {
            Some(count) if *count > 1 => {
                *count -= 1;
                false
            }
            Some(_) => {
                subscriptions.remove(&key);
                !subscriptions.keys().any(|stream_key| stream_key.symbol == symbol)
            }
            None => false,
        }
    };

    if should_stop_symbol {
        let should_run = {
            let mut symbol_streams = SYMBOL_STREAMS
                .lock()
                .map_err(|_| "symbol stream registry lock failed".to_string())?;
            symbol_streams.remove(&symbol)
        };

        if let Some(should_run) = should_run {
            should_run.store(false, Ordering::Relaxed);
        }
    }

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
