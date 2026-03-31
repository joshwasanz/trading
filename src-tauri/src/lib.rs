use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::env;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{connect, Message, WebSocket};

static SYMBOL_STATES: LazyLock<Mutex<HashMap<String, SymbolState>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static LIVE_SUBSCRIPTIONS: LazyLock<Mutex<HashMap<StreamKey, usize>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static SYNTHETIC_SYMBOL_STREAMS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static MASSIVE_LIVE_WORKERS: LazyLock<Mutex<HashMap<AssetClass, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static MASSIVE_FIRST_LIVE_MESSAGES: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));
static MASSIVE_FIRST_EMITS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

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

#[derive(Debug, Clone, Serialize)]
struct ProviderCapabilities {
    #[serde(rename = "providerMode")]
    provider_mode: String,
    #[serde(rename = "supportedSymbols")]
    supported_symbols: Vec<SupportedSymbol>,
    #[serde(rename = "supportedTimeframes")]
    supported_timeframes: Vec<String>,
    #[serde(rename = "liveSupported")]
    live_supported: bool,
    notice: Option<String>,
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

    fn all() -> [Self; 3] {
        [Self::S15, Self::M1, Self::M3]
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DataProviderMode {
    Synthetic,
    TwelveData,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum AssetClass {
    Forex,
    Index,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MassiveAccessProfile {
    Basic,
    Full,
}

fn asset_class_name(asset_class: AssetClass) -> &'static str {
    match asset_class {
        AssetClass::Forex => "forex",
        AssetClass::Index => "index",
    }
}

#[derive(Debug, Clone, Copy)]
struct InstrumentDefinition {
    internal_id: &'static str,
    label: &'static str,
    #[allow(dead_code)]
    asset_class: AssetClass,
    provider_ticker_env: &'static str,
    default_provider_ticker: &'static str,
    enabled: bool,
}

const MARKET_INSTRUMENTS: [InstrumentDefinition; 9] = [
    InstrumentDefinition {
        internal_id: "eurusd",
        label: "EUR/USD",
        asset_class: AssetClass::Forex,
        provider_ticker_env: "TWELVE_DATA_SYMBOL_EURUSD",
        default_provider_ticker: "EUR/USD",
        enabled: true,
    },
    InstrumentDefinition {
        internal_id: "usdjpy",
        label: "USD/JPY",
        asset_class: AssetClass::Forex,
        provider_ticker_env: "TWELVE_DATA_SYMBOL_USDJPY",
        default_provider_ticker: "USD/JPY",
        enabled: true,
    },
    InstrumentDefinition {
        internal_id: "spx",
        label: "S&P 500",
        asset_class: AssetClass::Index,
        provider_ticker_env: "TWELVE_DATA_SYMBOL_SPX",
        default_provider_ticker: "SPX",
        enabled: true,
    },
    InstrumentDefinition {
        internal_id: "ndx",
        label: "Nasdaq-100",
        asset_class: AssetClass::Index,
        provider_ticker_env: "TWELVE_DATA_SYMBOL_NDX",
        default_provider_ticker: "NDX",
        enabled: true,
    },
    InstrumentDefinition {
        internal_id: "gbpusd",
        label: "GBP/USD",
        asset_class: AssetClass::Forex,
        provider_ticker_env: "TWELVE_DATA_SYMBOL_GBPUSD",
        default_provider_ticker: "GBP/USD",
        enabled: false,
    },
    InstrumentDefinition {
        internal_id: "usdchf",
        label: "USD/CHF",
        asset_class: AssetClass::Forex,
        provider_ticker_env: "TWELVE_DATA_SYMBOL_USDCHF",
        default_provider_ticker: "USD/CHF",
        enabled: false,
    },
    InstrumentDefinition {
        internal_id: "audusd",
        label: "AUD/USD",
        asset_class: AssetClass::Forex,
        provider_ticker_env: "TWELVE_DATA_SYMBOL_AUDUSD",
        default_provider_ticker: "AUD/USD",
        enabled: false,
    },
    InstrumentDefinition {
        internal_id: "usdcad",
        label: "USD/CAD",
        asset_class: AssetClass::Forex,
        provider_ticker_env: "TWELVE_DATA_SYMBOL_USDCAD",
        default_provider_ticker: "USD/CAD",
        enabled: false,
    },
    InstrumentDefinition {
        internal_id: "dji",
        label: "Dow Jones",
        asset_class: AssetClass::Index,
        provider_ticker_env: "TWELVE_DATA_SYMBOL_DJI",
        default_provider_ticker: "DJI",
        enabled: false,
    },
];

#[derive(Debug, Clone, Copy)]
struct MassiveHistoricalPlan {
    multiplier: usize,
    timespan: &'static str,
    raw_step_seconds: u64,
}

#[derive(Debug, Deserialize, Default)]
struct TwelveDataHistoricalResponse {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    code: Option<u16>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    values: Option<Vec<TwelveDataHistoricalValue>>,
}

#[derive(Debug, Deserialize)]
struct TwelveDataHistoricalValue {
    datetime: String,
    open: String,
    high: String,
    low: String,
    close: String,
}

#[derive(Debug, Deserialize, Default)]
struct MassiveHistoricalResponse {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    results: Option<Vec<MassiveAggregate>>,
}

#[derive(Debug, Deserialize)]
struct MassiveAggregate {
    #[serde(rename = "t")]
    timestamp_ms: u64,
    #[serde(rename = "o")]
    open: f64,
    #[serde(rename = "h")]
    high: f64,
    #[serde(rename = "l")]
    low: f64,
    #[serde(rename = "c")]
    close: f64,
}

#[derive(Debug, Deserialize)]
struct MassiveWebSocketMessage {
    #[serde(default)]
    ev: String,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    sym: Option<String>,
    #[serde(default, rename = "p")]
    pair: Option<String>,
    #[serde(default, rename = "o")]
    open: Option<f64>,
    #[serde(default, rename = "h")]
    high: Option<f64>,
    #[serde(default, rename = "l")]
    low: Option<f64>,
    #[serde(default, rename = "c")]
    close: Option<f64>,
    #[serde(default, rename = "s")]
    start_ms: Option<u64>,
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

    fn from_source(timeframe: Timeframe, source: &Candle) -> Self {
        let aligned = align_timestamp(source.time, timeframe);
        Self::from_current(
            timeframe,
            Candle {
                symbol: source.symbol.clone(),
                time: aligned,
                open: source.open,
                high: source.high,
                low: source.low,
                close: source.close,
            },
        )
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

    fn update_from_source(&mut self, source: &Candle) -> Option<Candle> {
        let aligned = align_timestamp(source.time, self.timeframe);

        if aligned == self.start_time {
            self.current.high = self.current.high.max(source.high);
            self.current.low = self.current.low.min(source.low);
            self.current.close = source.close;
            return None;
        }

        if aligned < self.start_time {
            return None;
        }

        let finished = self.current.clone();
        self.start_time = aligned;
        self.current = Candle {
            symbol: source.symbol.clone(),
            time: aligned,
            open: source.open,
            high: source.high,
            low: source.low,
            close: source.close,
        };

        Some(finished)
    }
}

fn configured_data_provider() -> DataProviderMode {
    match env::var("DATA_PROVIDER")
        .unwrap_or_else(|_| "synthetic".to_string())
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "twelve_data" | "twelvedata" | "twelve-data" => DataProviderMode::TwelveData,
        _ => DataProviderMode::Synthetic,
    }
}

fn twelve_data_api_key() -> Result<String, String> {
    let key = env::var("TWELVE_DATA_API_KEY")
        .map_err(|_| "TWELVE_DATA_API_KEY is not set".to_string())?;

    if key.trim().is_empty() {
        return Err("TWELVE_DATA_API_KEY is empty".to_string());
    }

    Ok(key)
}

fn twelve_data_rest_base_url() -> String {
    env::var("TWELVE_DATA_REST_BASE_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "https://api.twelvedata.com".to_string())
}

fn log_first_massive_live_message(
    provider_identifier: &str,
    internal_symbol: &str,
    asset_class: AssetClass,
    event_type: &str,
) {
    let key = format!("{}::{internal_symbol}", asset_class_name(asset_class));

    if let Ok(mut seen) = MASSIVE_FIRST_LIVE_MESSAGES.lock() {
        if seen.insert(key) {
            println!(
                "[massive] first live message asset_class={} provider_symbol={} internal_symbol={} event={}",
                asset_class_name(asset_class),
                provider_identifier,
                internal_symbol,
                event_type
            );
        }
    }
}

fn log_first_massive_emit(symbol: &str, timeframe: Timeframe, candle: &Candle) {
    let key = format!("{symbol}::{}", timeframe.as_str());

    if let Ok(mut seen) = MASSIVE_FIRST_EMITS.lock() {
        if seen.insert(key) {
            println!(
                "[massive] emitting first candle event=candle://{}/{} time={} close={}",
                symbol,
                timeframe.as_str(),
                candle.time,
                candle.close
            );
        }
    }
}

fn asset_class_for_symbol(symbol: &str) -> Result<AssetClass, String> {
    instrument_definition(symbol)
        .map(|instrument| instrument.asset_class)
        .ok_or_else(|| format!("Unsupported symbol: {symbol}"))
}

fn massive_ws_url(asset_class: AssetClass) -> Result<String, String> {
    let asset_specific_env = match asset_class {
        AssetClass::Forex => "MASSIVE_WS_URL_FOREX",
        AssetClass::Index => "MASSIVE_WS_URL_INDEX",
    };

    env::var(asset_specific_env)
        .ok()
        .or_else(|| env::var("MASSIVE_WS_URL").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| match asset_class {
            AssetClass::Forex => Some("wss://delayed.massive.com/forex".to_string()),
            AssetClass::Index => Some("wss://delayed.massive.com/indices".to_string()),
        })
        .ok_or_else(|| format!("{asset_specific_env} is not set"))
}

fn live_channel_prefix(asset_class: AssetClass) -> &'static str {
    match asset_class {
        AssetClass::Forex => "CAS",
        AssetClass::Index => "A",
    }
}

fn is_supported_live_event(asset_class: AssetClass, event_type: &str) -> bool {
    match asset_class {
        AssetClass::Forex => matches!(event_type, "CAS" | "CA"),
        AssetClass::Index => matches!(event_type, "A" | "IA" | "IAS"),
    }
}

fn normalize_live_identifier(value: &str, asset_class: AssetClass) -> String {
    let uppercase = value.trim().to_ascii_uppercase();

    match asset_class {
        AssetClass::Forex => uppercase
            .strip_prefix("C:")
            .unwrap_or(uppercase.as_str())
            .replace('/', ""),
        AssetClass::Index => uppercase
            .strip_prefix("I:")
            .unwrap_or(uppercase.as_str())
            .to_string(),
    }
}

fn live_subscription_target_for_symbol(symbol: &str) -> Result<String, String> {
    let asset_class = asset_class_for_symbol(symbol)?;
    let provider_ticker = provider_ticker_for_symbol(symbol)?;

    match asset_class {
        AssetClass::Forex => {
            let compact = normalize_live_identifier(&provider_ticker, asset_class);
            if compact.len() != 6 {
                return Err(format!(
                    "Invalid forex ticker mapping for {symbol}: {provider_ticker}"
                ));
            }

            Ok(format!("{}/{}", &compact[0..3], &compact[3..6]))
        }
        AssetClass::Index => Ok(provider_ticker),
    }
}

fn instrument_definition(symbol: &str) -> Option<&'static InstrumentDefinition> {
    MARKET_INSTRUMENTS
        .iter()
        .find(|instrument| instrument.internal_id == symbol)
}

fn provider_ticker_for_symbol(symbol: &str) -> Result<String, String> {
    let instrument =
        instrument_definition(symbol).ok_or_else(|| format!("Unsupported symbol: {symbol}"))?;
    let provider_ticker = env::var(instrument.provider_ticker_env)
        .ok()
        .map(|value| value.trim().to_ascii_uppercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| instrument.default_provider_ticker.to_string());

    Ok(provider_ticker)
}

fn internal_symbol_for_live_identifier(
    provider_identifier: &str,
    asset_class: AssetClass,
) -> Option<String> {
    let normalized = normalize_live_identifier(provider_identifier, asset_class);

    MARKET_INSTRUMENTS.iter().find_map(|instrument| {
        if instrument.asset_class != asset_class {
            return None;
        }

        let historical = provider_ticker_for_symbol(instrument.internal_id).ok()?;
        let live = live_subscription_target_for_symbol(instrument.internal_id).ok()?;
        let matches_historical = normalize_live_identifier(&historical, asset_class) == normalized;
        let matches_live = normalize_live_identifier(&live, asset_class) == normalized;

        (matches_historical || matches_live).then_some(instrument.internal_id.to_string())
    })
}

fn massive_historical_plan(timeframe: Timeframe) -> MassiveHistoricalPlan {
    match timeframe {
        Timeframe::S15 => MassiveHistoricalPlan {
            multiplier: 1,
            timespan: "second",
            raw_step_seconds: 1,
        },
        Timeframe::M1 | Timeframe::M3 => MassiveHistoricalPlan {
            multiplier: 1,
            timespan: "minute",
            raw_step_seconds: 60,
        },
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
    MARKET_INSTRUMENTS
        .iter()
        .filter(|instrument| instrument.enabled)
        .map(|instrument| SupportedSymbol {
            id: instrument.internal_id.to_string(),
            label: instrument.label.to_string(),
        })
        .collect()
}

fn is_supported_symbol(symbol: &str) -> bool {
    instrument_definition(symbol)
        .map(|instrument| instrument.enabled)
        .unwrap_or(false)
}

fn provider_capabilities() -> ProviderCapabilities {
    let provider_mode = match configured_data_provider() {
        DataProviderMode::Synthetic => "synthetic",
        DataProviderMode::TwelveData => "twelve_data",
    }
    .to_string();

    ProviderCapabilities {
        provider_mode,
        supported_symbols: supported_symbols(),
        supported_timeframes: Timeframe::all()
            .iter()
            .map(|timeframe| timeframe.as_str().to_string())
            .collect(),
        live_supported: true,
        notice: match configured_data_provider() {
            DataProviderMode::TwelveData => Some(
                "Twelve Data validation mode: historical candles use Twelve Data where supported; live updates remain synthetic in this pass."
                    .to_string(),
            ),
            DataProviderMode::Synthetic => None,
        },
    }
}

fn massive_api_key() -> Result<String, String> {
    twelve_data_api_key()
}

fn base_price_for_symbol(symbol: &str) -> f64 {
    match symbol {
        "eurusd" => 1.08,
        "gbpusd" => 1.27,
        "usdjpy" => 149.0,
        "usdchf" => 0.91,
        "audusd" => 0.66,
        "usdcad" => 1.35,
        "spx" => 5_200.0,
        "ndx" => 18_100.0,
        "dji" => 39_000.0,
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
        "eurusd" => 0.0007,
        "gbpusd" => 0.0008,
        "usdjpy" => 0.06,
        "usdchf" => 0.0007,
        "audusd" => 0.0007,
        "usdcad" => 0.0008,
        "spx" => 0.9,
        "ndx" => 1.8,
        "dji" => 2.5,
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
    let micro =
        deterministic_signed(symbol, Timeframe::S15, time_millis / 250, 91) * volatility * 0.65;
    let momentum =
        deterministic_signed(symbol, Timeframe::S15, time_millis / 500, 92) * volatility * 0.25;

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
    app.emit(&event_name, payload)
        .map_err(|error| error.to_string())
}

fn generate_synthetic_historical_result(
    symbol: &str,
    timeframe: Timeframe,
    from: Option<u64>,
    to: Option<u64>,
    limit: Option<usize>,
) -> Vec<Candle> {
    generate_synthetic_historical_candles(symbol, timeframe, from, to, limit)
}

fn should_try_twelve_data_historical(symbol: &str, timeframe: Timeframe) -> bool {
    if matches!(timeframe, Timeframe::S15) {
        return false;
    }

    matches!(symbol, "eurusd" | "usdjpy" | "spx" | "ndx")
}

fn try_twelve_data_historical(
    symbol: &str,
    timeframe: Timeframe,
    from: Option<u64>,
    to: Option<u64>,
    limit: Option<usize>,
) -> Result<Vec<Candle>, String> {
    println!(
        "[twelve_data] using REST symbol={} timeframe={}",
        symbol,
        timeframe.as_str()
    );

    let candles = fetch_twelve_data_historical(symbol, timeframe, from, to, limit)?;
    println!(
        "[twelve_data] success symbol={} timeframe={} candles={}",
        symbol,
        timeframe.as_str(),
        candles.len()
    );

    Ok(candles)
}

fn subscribe_synthetic_live(
    app: AppHandle,
    symbol: String,
    timeframe: Timeframe,
    key: StreamKey,
) -> Result<(), String> {
    println!(
        "[data] subscribe_live symbol={} timeframe={} provider=synthetic",
        symbol,
        timeframe.as_str()
    );

    {
        let mut subscriptions = LIVE_SUBSCRIPTIONS
            .lock()
            .map_err(|_| "live subscription registry lock failed".to_string())?;
        let entry = subscriptions.entry(key).or_insert(0);
        *entry += 1;
    }

    let should_start = {
        let mut symbol_streams = SYNTHETIC_SYMBOL_STREAMS
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
        start_synthetic_symbol_stream(app, symbol, should_run);
    }

    Ok(())
}

fn unsubscribe_synthetic_live(
    symbol: String,
    timeframe: Timeframe,
    key: StreamKey,
) -> Result<(), String> {
    println!(
        "[data] unsubscribe_live symbol={} timeframe={} provider=synthetic",
        symbol,
        timeframe.as_str()
    );

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
                !subscriptions
                    .keys()
                    .any(|stream_key| stream_key.symbol == symbol)
            }
            None => false,
        }
    };

    if should_stop_symbol {
        let should_run = {
            let mut symbol_streams = SYNTHETIC_SYMBOL_STREAMS
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

fn has_live_subscriptions_for_asset_class(asset_class: AssetClass) -> bool {
    LIVE_SUBSCRIPTIONS
        .lock()
        .ok()
        .map(|subscriptions| {
            subscriptions.iter().any(|(key, count)| {
                *count > 0
                    && instrument_definition(&key.symbol)
                        .map(|instrument| instrument.asset_class == asset_class)
                        .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn current_candle_snapshot(symbol: &str, timeframe: Timeframe) -> Candle {
    let now = align_timestamp(current_timestamp(), timeframe);

    generate_synthetic_historical_candles(symbol, timeframe, Some(now), Some(now), Some(1))
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

fn start_synthetic_symbol_stream(app: AppHandle, symbol: String, should_run: Arc<AtomicBool>) {
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

            thread::sleep(Duration::from_millis(100));
        }

        if let Ok(mut symbol_streams) = SYNTHETIC_SYMBOL_STREAMS.lock() {
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

fn generate_synthetic_historical_candles(
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

fn aggregate_candles(candles: Vec<Candle>, timeframe: Timeframe) -> Vec<Candle> {
    let mut aggregated: Vec<Candle> = Vec::new();
    let mut current: Option<Candle> = None;

    for candle in candles {
        let bucket = align_timestamp(candle.time, timeframe);

        match current.as_mut() {
            Some(existing) if existing.time == bucket => {
                existing.high = existing.high.max(candle.high);
                existing.low = existing.low.min(candle.low);
                existing.close = candle.close;
            }
            Some(_) => {
                if let Some(finished) = current.take() {
                    aggregated.push(finished);
                }

                current = Some(Candle {
                    symbol: candle.symbol.clone(),
                    time: bucket,
                    open: candle.open,
                    high: candle.high,
                    low: candle.low,
                    close: candle.close,
                });
            }
            None => {
                current = Some(Candle {
                    symbol: candle.symbol.clone(),
                    time: bucket,
                    open: candle.open,
                    high: candle.high,
                    low: candle.low,
                    close: candle.close,
                });
            }
        }
    }

    if let Some(last) = current {
        aggregated.push(last);
    }

    aggregated
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let adjusted_year = year - i32::from(month <= 2);
    let era = if adjusted_year >= 0 {
        adjusted_year
    } else {
        adjusted_year - 399
    } / 400;
    let year_of_era = adjusted_year - era * 400;
    let month_prime = month as i32 + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day as i32 - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;

    (era * 146097 + day_of_era - 719468) as i64
}

fn civil_from_days(days_since_epoch: i64) -> (i32, u32, u32) {
    let adjusted_days = days_since_epoch + 719468;
    let era = if adjusted_days >= 0 {
        adjusted_days
    } else {
        adjusted_days - 146096
    } / 146097;
    let day_of_era = adjusted_days - era * 146097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    let adjusted_year = year + i64::from(month <= 2);

    (adjusted_year as i32, month as u32, day as u32)
}

fn format_timestamp_for_twelve_data(timestamp: u64) -> String {
    let days_since_epoch = (timestamp / 86_400) as i64;
    let seconds_of_day = timestamp % 86_400;
    let (year, month, day) = civil_from_days(days_since_epoch);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}")
}

fn parse_twelve_data_timestamp(value: &str) -> Result<u64, String> {
    let trimmed = value.trim().trim_end_matches('Z');
    let (date_part, time_part) = if let Some((date, time)) = trimmed.split_once('T') {
        (date, Some(time))
    } else if let Some((date, time)) = trimmed.split_once(' ') {
        (date, Some(time))
    } else {
        (trimmed, None)
    };

    let mut date_iter = date_part.split('-');
    let year = date_iter
        .next()
        .ok_or_else(|| format!("Invalid Twelve Data datetime: {value}"))?
        .parse::<i32>()
        .map_err(|_| format!("Invalid Twelve Data year: {value}"))?;
    let month = date_iter
        .next()
        .ok_or_else(|| format!("Invalid Twelve Data datetime: {value}"))?
        .parse::<u32>()
        .map_err(|_| format!("Invalid Twelve Data month: {value}"))?;
    let day = date_iter
        .next()
        .ok_or_else(|| format!("Invalid Twelve Data datetime: {value}"))?
        .parse::<u32>()
        .map_err(|_| format!("Invalid Twelve Data day: {value}"))?;

    let (hour, minute, second) = if let Some(time) = time_part {
        let normalized_time = time.split('.').next().unwrap_or(time);
        let mut time_iter = normalized_time.split(':');
        let hour = time_iter
            .next()
            .ok_or_else(|| format!("Invalid Twelve Data time: {value}"))?
            .parse::<u32>()
            .map_err(|_| format!("Invalid Twelve Data hour: {value}"))?;
        let minute = time_iter
            .next()
            .ok_or_else(|| format!("Invalid Twelve Data time: {value}"))?
            .parse::<u32>()
            .map_err(|_| format!("Invalid Twelve Data minute: {value}"))?;
        let second = time_iter
            .next()
            .unwrap_or("0")
            .parse::<u32>()
            .map_err(|_| format!("Invalid Twelve Data second: {value}"))?;

        (hour, minute, second)
    } else {
        (0, 0, 0)
    };

    if year < 1970 {
        return Err(format!(
            "Unsupported Twelve Data datetime before epoch: {value}"
        ));
    }

    let days_since_epoch = days_from_civil(year, month, day);
    if days_since_epoch < 0 {
        return Err(format!("Invalid Twelve Data datetime: {value}"));
    }

    Ok(days_since_epoch as u64 * 86_400 + hour as u64 * 3_600 + minute as u64 * 60 + second as u64)
}

fn twelve_data_source_interval(timeframe: Timeframe) -> Option<(&'static str, u64)> {
    match timeframe {
        Timeframe::S15 => None,
        Timeframe::M1 | Timeframe::M3 => Some(("1min", 60)),
    }
}

fn fetch_twelve_data_historical(
    symbol: &str,
    timeframe: Timeframe,
    from: Option<u64>,
    to: Option<u64>,
    limit: Option<usize>,
) -> Result<Vec<Candle>, String> {
    let api_key = twelve_data_api_key()?;
    let provider_ticker = provider_ticker_for_symbol(symbol)?;
    println!(
        "[twelve_data] get_historical symbol={} timeframe={} provider_symbol={}",
        symbol,
        timeframe.as_str(),
        provider_ticker
    );
    let (interval, raw_step_seconds) = twelve_data_source_interval(timeframe)
        .ok_or_else(|| format!("Twelve Data does not support {}", timeframe.as_str()))?;
    let now = align_timestamp(current_timestamp(), timeframe);
    let default_limit = 300usize;
    let max_limit = 5_000usize;
    let requested_limit = limit.unwrap_or(default_limit).clamp(1, max_limit);
    let effective_to = align_timestamp(to.unwrap_or(now), timeframe);
    let effective_from = match from {
        Some(value) => align_timestamp(value, timeframe),
        None => effective_to
            .saturating_sub((requested_limit as u64).saturating_sub(1) * timeframe.duration()),
    };

    if effective_from > effective_to {
        return Ok(Vec::new());
    }

    let factor = (timeframe.duration() / raw_step_seconds) as usize;
    let raw_to = if factor == 1 {
        effective_to
    } else {
        effective_to.saturating_add(timeframe.duration() - raw_step_seconds)
    };
    let raw_limit = (((raw_to.saturating_sub(effective_from)) / raw_step_seconds) as usize + 1)
        .max(requested_limit.saturating_mul(factor))
        .clamp(1, max_limit);
    let request_url = format!("{}/time_series", twelve_data_rest_base_url());

    let client = Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("Failed to build Twelve Data HTTP client: {error}"))?;

    let query = vec![
        ("symbol", provider_ticker.clone()),
        ("interval", interval.to_string()),
        ("apikey", api_key),
        ("timezone", "UTC".to_string()),
        ("order", "ASC".to_string()),
        ("format", "JSON".to_string()),
        ("outputsize", raw_limit.to_string()),
        (
            "start_date",
            format_timestamp_for_twelve_data(effective_from),
        ),
        ("end_date", format_timestamp_for_twelve_data(raw_to)),
    ];

    let response = client
        .get(request_url)
        .query(&query)
        .send()
        .map_err(|error| {
            eprintln!(
                "[twelve_data] historical error symbol={} timeframe={} error={}",
                symbol,
                timeframe.as_str(),
                error
            );
            format!("Twelve Data historical request failed: {error}")
        })?;

    let status = response.status();
    let body = response
        .text()
        .map_err(|error| format!("Twelve Data historical response read failed: {error}"))?;
    let parsed: TwelveDataHistoricalResponse = serde_json::from_str(&body)
        .map_err(|error| format!("Twelve Data historical response parse failed: {error}"))?;

    if !status.is_success() {
        let provider_message = parsed
            .message
            .clone()
            .unwrap_or_else(|| format!("Twelve Data historical request failed with HTTP {status}"));
        eprintln!(
            "[twelve_data] historical error symbol={} timeframe={} status={} message={}",
            symbol,
            timeframe.as_str(),
            status,
            provider_message
        );
        return Err(provider_message);
    }

    if let Some(status_text) = parsed.status.as_deref() {
        if !status_text.eq_ignore_ascii_case("ok") {
            let provider_message = parsed
                .message
                .clone()
                .unwrap_or_else(|| format!("Twelve Data returned status {status_text}"));
            eprintln!(
                "[twelve_data] historical error symbol={} timeframe={} provider_status={} code={:?} message={}",
                symbol,
                timeframe.as_str(),
                status_text,
                parsed.code,
                provider_message
            );
            return Err(provider_message);
        }
    }

    let raw_candles = parsed
        .values
        .unwrap_or_default()
        .into_iter()
        .map(|value| {
            Ok(Candle {
                symbol: symbol.to_string(),
                time: parse_twelve_data_timestamp(&value.datetime)?,
                open: value
                    .open
                    .parse::<f64>()
                    .map_err(|_| format!("Invalid Twelve Data open price for {symbol}"))?,
                high: value
                    .high
                    .parse::<f64>()
                    .map_err(|_| format!("Invalid Twelve Data high price for {symbol}"))?,
                low: value
                    .low
                    .parse::<f64>()
                    .map_err(|_| format!("Invalid Twelve Data low price for {symbol}"))?,
                close: value
                    .close
                    .parse::<f64>()
                    .map_err(|_| format!("Invalid Twelve Data close price for {symbol}"))?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    let mut candles = if factor == 1 {
        raw_candles
    } else {
        aggregate_candles(raw_candles, timeframe)
    };

    candles.sort_by_key(|candle| candle.time);
    candles.retain(|candle| candle.time >= effective_from && candle.time <= effective_to);

    if candles.len() > requested_limit {
        let split_index = candles.len() - requested_limit;
        candles = candles.split_off(split_index);
    }

    if let Some(last_candle) = candles.last() {
        store_symbol_state(symbol, last_candle.time, last_candle.close);
    }

    println!(
        "[twelve_data] historical response ok symbol={} timeframe={} count={}",
        symbol,
        timeframe.as_str(),
        candles.len()
    );

    Ok(candles)
}

fn active_provider_tickers(asset_class: AssetClass) -> Result<HashMap<String, String>, String> {
    let subscriptions = LIVE_SUBSCRIPTIONS
        .lock()
        .map_err(|_| "live subscription registry lock failed".to_string())?;
    let mut desired = HashMap::new();

    for (key, count) in subscriptions.iter() {
        if *count == 0 || asset_class_for_symbol(&key.symbol)? != asset_class {
            continue;
        }

        desired.insert(
            live_subscription_target_for_symbol(&key.symbol)?,
            key.symbol.clone(),
        );
    }

    Ok(desired)
}

fn prune_inactive_builders(
    builders: &mut HashMap<StreamKey, CandleBuilder>,
    asset_class: AssetClass,
) {
    let active_keys = LIVE_SUBSCRIPTIONS
        .lock()
        .ok()
        .map(|subscriptions| {
            subscriptions
                .iter()
                .filter_map(|(key, count)| {
                    (*count > 0
                        && instrument_definition(&key.symbol)
                            .map(|instrument| instrument.asset_class == asset_class)
                            .unwrap_or(false))
                    .then_some(key.clone())
                })
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();

    builders.retain(|key, _| active_keys.contains(key));
}

fn websocket_tickers_to_channels(asset_class: AssetClass, tickers: &[String]) -> Vec<String> {
    tickers
        .iter()
        .map(|ticker| format!("{}.{ticker}", live_channel_prefix(asset_class)))
        .collect::<Vec<_>>()
}

fn send_massive_ws_command(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    asset_class: AssetClass,
    action: &str,
    tickers: &[String],
) -> Result<(), String> {
    if tickers.is_empty() {
        return Ok(());
    }

    let payload = json!({
        "action": action,
        "params": websocket_tickers_to_channels(asset_class, tickers).join(","),
    })
    .to_string();

    println!(
        "[massive] websocket {} asset_class={} targets={}",
        action,
        asset_class_name(asset_class),
        tickers.join(",")
    );

    socket
        .send(Message::Text(payload.into()))
        .map_err(|error| format!("Massive WebSocket {action} failed: {error}"))
}

fn set_websocket_timeouts(socket: &mut WebSocket<MaybeTlsStream<TcpStream>>) {
    let timeout = Some(Duration::from_secs(1));

    match socket.get_mut() {
        MaybeTlsStream::Plain(stream) => {
            let _ = stream.set_read_timeout(timeout);
            let _ = stream.set_write_timeout(timeout);
        }
        MaybeTlsStream::Rustls(stream) => {
            let tcp = stream.get_mut();
            let _ = tcp.set_read_timeout(timeout);
            let _ = tcp.set_write_timeout(timeout);
        }
        _ => {}
    }
}

fn sync_massive_socket_subscriptions(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    asset_class: AssetClass,
    subscribed: &mut HashSet<String>,
    desired: &HashSet<String>,
) -> Result<(), String> {
    let to_subscribe = desired.difference(subscribed).cloned().collect::<Vec<_>>();
    let to_unsubscribe = subscribed.difference(desired).cloned().collect::<Vec<_>>();

    send_massive_ws_command(socket, asset_class, "unsubscribe", &to_unsubscribe)?;
    send_massive_ws_command(socket, asset_class, "subscribe", &to_subscribe)?;

    *subscribed = desired.clone();
    Ok(())
}

fn parse_massive_ws_messages(payload: &str) -> Result<Vec<MassiveWebSocketMessage>, String> {
    serde_json::from_str::<Vec<MassiveWebSocketMessage>>(payload)
        .or_else(|_| {
            serde_json::from_str::<MassiveWebSocketMessage>(payload).map(|message| vec![message])
        })
        .map_err(|error| format!("Massive WebSocket payload parse failed: {error}"))
}

fn handle_massive_status_message(
    asset_class: AssetClass,
    message: &MassiveWebSocketMessage,
) -> Option<Result<bool, String>> {
    let is_status_event = message.ev.eq_ignore_ascii_case("status")
        || message.status.is_some()
        || message.message.is_some();

    if !is_status_event {
        return None;
    }

    let status = message.status.as_deref().unwrap_or("-");
    let text = message.message.as_deref().unwrap_or("-");
    let combined = format!(
        "{} {}",
        status.to_ascii_lowercase(),
        text.to_ascii_lowercase()
    );

    if combined.contains("auth")
        && (combined.contains("success")
            || combined.contains("authenticated")
            || combined.contains("connected"))
    {
        println!(
            "[massive] websocket authenticated asset_class={} status={} message={}",
            asset_class_name(asset_class),
            status,
            text
        );
        return Some(Ok(true));
    }

    if combined.contains("auth")
        && (combined.contains("fail")
            || combined.contains("error")
            || combined.contains("denied")
            || combined.contains("unauthorized"))
    {
        eprintln!(
            "[massive] websocket auth failed asset_class={} status={} message={}",
            asset_class_name(asset_class),
            status,
            text
        );
        return Some(Err(format!(
            "Massive WebSocket auth failed for {}",
            asset_class_name(asset_class)
        )));
    }

    println!(
        "[massive] websocket status asset_class={} status={} message={}",
        asset_class_name(asset_class),
        status,
        text
    );
    Some(Ok(false))
}

fn wait_for_massive_auth_confirmation(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    asset_class: AssetClass,
) -> Result<bool, String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);

    while std::time::Instant::now() < deadline {
        match socket.read() {
            Ok(Message::Text(payload)) => {
                let text = payload.to_string();
                for message in parse_massive_ws_messages(&text)? {
                    if let Some(result) = handle_massive_status_message(asset_class, &message) {
                        return result;
                    }
                }
            }
            Ok(Message::Binary(payload)) => {
                if let Ok(text) = String::from_utf8(payload.to_vec()) {
                    for message in parse_massive_ws_messages(&text)? {
                        if let Some(result) = handle_massive_status_message(asset_class, &message) {
                            return result;
                        }
                    }
                }
            }
            Ok(Message::Ping(payload)) => {
                let _ = socket.send(Message::Pong(payload));
            }
            Ok(Message::Pong(_)) => {}
            Ok(Message::Close(_)) => {
                return Err(format!(
                    "Massive WebSocket closed before auth confirmation for {}",
                    asset_class_name(asset_class)
                ));
            }
            Ok(Message::Frame(_)) => {}
            Err(tungstenite::Error::Io(error))
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::TimedOut =>
            {
                continue;
            }
            Err(tungstenite::Error::ConnectionClosed) | Err(tungstenite::Error::AlreadyClosed) => {
                return Err(format!(
                    "Massive WebSocket closed before auth confirmation for {}",
                    asset_class_name(asset_class)
                ));
            }
            Err(error) => {
                return Err(format!("Massive WebSocket auth wait failed: {error}"));
            }
        }
    }

    eprintln!(
        "[massive] websocket auth confirmation timed out asset_class={}; continuing",
        asset_class_name(asset_class)
    );
    Ok(false)
}

fn massive_message_to_candle(message: &MassiveWebSocketMessage, symbol: &str) -> Option<Candle> {
    Some(Candle {
        symbol: symbol.to_string(),
        time: message.start_ms? / 1_000,
        open: message.open?,
        high: message.high?,
        low: message.low?,
        close: message.close?,
    })
}

fn process_massive_aggregate_message(
    app: &AppHandle,
    builders: &mut HashMap<StreamKey, CandleBuilder>,
    asset_class: AssetClass,
    message: &MassiveWebSocketMessage,
) {
    if !is_supported_live_event(asset_class, &message.ev) {
        return;
    }

    let provider_identifier = match message.sym.as_deref().or(message.pair.as_deref()) {
        Some(value) => value,
        None => return,
    };
    let internal_symbol =
        match internal_symbol_for_live_identifier(provider_identifier, asset_class) {
            Some(symbol) => symbol,
            None => return,
        };
    log_first_massive_live_message(
        provider_identifier,
        &internal_symbol,
        asset_class,
        &message.ev,
    );
    let source_candle = match massive_message_to_candle(message, &internal_symbol) {
        Some(candle) => candle,
        None => return,
    };
    let active = active_timeframes_for_symbol(&internal_symbol);

    if active.is_empty() {
        return;
    }

    for timeframe in Timeframe::all() {
        let key = StreamKey {
            symbol: internal_symbol.clone(),
            timeframe,
        };

        if !active.includes(timeframe) {
            builders.remove(&key);
            continue;
        }

        let builder = builders
            .entry(key)
            .or_insert_with(|| CandleBuilder::from_source(timeframe, &source_candle));

        if let Some(closed) = builder.update_from_source(&source_candle) {
            store_symbol_state(&internal_symbol, closed.time, closed.close);
            log_first_massive_emit(&internal_symbol, timeframe, &closed);
            let _ = emit_candle(app, &internal_symbol, timeframe, &closed);
        }

        log_first_massive_emit(&internal_symbol, timeframe, &builder.current);
        let _ = emit_candle(app, &internal_symbol, timeframe, &builder.current);
    }
}

fn handle_massive_ws_payload(
    app: &AppHandle,
    builders: &mut HashMap<StreamKey, CandleBuilder>,
    asset_class: AssetClass,
    payload: &str,
) -> Result<(), String> {
    for message in parse_massive_ws_messages(payload)? {
        if handle_massive_status_message(asset_class, &message).is_some() {
            continue;
        }
        process_massive_aggregate_message(app, builders, asset_class, &message);
    }

    Ok(())
}

fn clear_massive_live_worker(asset_class: AssetClass, should_run: &Arc<AtomicBool>) {
    if let Ok(mut workers) = MASSIVE_LIVE_WORKERS.lock() {
        let should_clear = workers
            .get(&asset_class)
            .map(|current| Arc::ptr_eq(current, should_run))
            .unwrap_or(false);
        if should_clear {
            workers.remove(&asset_class);
        }
    }
}

fn start_massive_live_worker(app: AppHandle, asset_class: AssetClass, should_run: Arc<AtomicBool>) {
    thread::spawn(move || {
        let api_key = match massive_api_key() {
            Ok(key) => key,
            Err(error) => {
                eprintln!("[Massive] {error}");
                clear_massive_live_worker(asset_class, &should_run);
                return;
            }
        };
        let ws_url = match massive_ws_url(asset_class) {
            Ok(url) => url,
            Err(error) => {
                eprintln!("[Massive] {error}");
                clear_massive_live_worker(asset_class, &should_run);
                return;
            }
        };
        let mut builders: HashMap<StreamKey, CandleBuilder> = HashMap::new();

        while should_run.load(Ordering::Relaxed) {
            if !has_live_subscriptions_for_asset_class(asset_class) {
                break;
            }

            println!(
                "[massive] websocket connecting asset_class={} url={}",
                asset_class_name(asset_class),
                ws_url
            );
            let connection = connect(ws_url.as_str());
            let (mut socket, _) = match connection {
                Ok(connection) => connection,
                Err(error) => {
                    eprintln!("[Massive] WebSocket connect failed: {error}");
                    thread::sleep(Duration::from_secs(2));
                    continue;
                }
            };

            println!(
                "[massive] websocket connected asset_class={}",
                asset_class_name(asset_class)
            );

            set_websocket_timeouts(&mut socket);

            let auth_payload = json!({
                "action": "auth",
                "params": api_key,
            })
            .to_string();

            if let Err(error) = socket.send(Message::Text(auth_payload.into())) {
                eprintln!("[Massive] WebSocket auth failed: {error}");
                thread::sleep(Duration::from_secs(2));
                continue;
            }

            match wait_for_massive_auth_confirmation(&mut socket, asset_class) {
                Ok(true) | Ok(false) => {}
                Err(error) => {
                    eprintln!("[massive] websocket auth failed: {error}");
                    thread::sleep(Duration::from_secs(2));
                    continue;
                }
            }

            let mut subscribed_tickers = HashSet::<String>::new();

            while should_run.load(Ordering::Relaxed) {
                prune_inactive_builders(&mut builders, asset_class);

                let desired_provider_map = match active_provider_tickers(asset_class) {
                    Ok(map) => map,
                    Err(error) => {
                        eprintln!("[Massive] Failed to resolve desired subscriptions: {error}");
                        break;
                    }
                };
                let desired_tickers = desired_provider_map.keys().cloned().collect::<HashSet<_>>();

                if desired_tickers.is_empty() {
                    let _ = socket.close(None);
                    break;
                }

                if let Err(error) = sync_massive_socket_subscriptions(
                    &mut socket,
                    asset_class,
                    &mut subscribed_tickers,
                    &desired_tickers,
                ) {
                    eprintln!("[Massive] Subscription sync failed: {error}");
                    break;
                }

                match socket.read() {
                    Ok(Message::Text(payload)) => {
                        let text = payload.to_string();
                        if let Err(error) =
                            handle_massive_ws_payload(&app, &mut builders, asset_class, &text)
                        {
                            eprintln!("[Massive] {error}");
                        }
                    }
                    Ok(Message::Binary(payload)) => {
                        if let Ok(text) = String::from_utf8(payload.to_vec()) {
                            if let Err(error) =
                                handle_massive_ws_payload(&app, &mut builders, asset_class, &text)
                            {
                                eprintln!("[Massive] {error}");
                            }
                        }
                    }
                    Ok(Message::Ping(payload)) => {
                        let _ = socket.send(Message::Pong(payload));
                    }
                    Ok(Message::Pong(_)) => {}
                    Ok(Message::Close(_)) => {
                        break;
                    }
                    Ok(Message::Frame(_)) => {}
                    Err(tungstenite::Error::Io(error))
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            || error.kind() == std::io::ErrorKind::TimedOut =>
                    {
                        continue;
                    }
                    Err(tungstenite::Error::ConnectionClosed)
                    | Err(tungstenite::Error::AlreadyClosed) => {
                        break;
                    }
                    Err(error) => {
                        eprintln!("[Massive] WebSocket read failed: {error}");
                        break;
                    }
                }
            }

            if should_run.load(Ordering::Relaxed)
                && has_live_subscriptions_for_asset_class(asset_class)
            {
                thread::sleep(Duration::from_secs(2));
            }
        }

        clear_massive_live_worker(asset_class, &should_run);
    });
}

#[tauri::command]
fn get_supported_symbols() -> Vec<SupportedSymbol> {
    supported_symbols()
}

#[tauri::command]
fn get_provider_capabilities() -> ProviderCapabilities {
    provider_capabilities()
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

    match configured_data_provider() {
        DataProviderMode::Synthetic => {
            println!(
                "[data] get_historical symbol={} timeframe={} provider=synthetic",
                symbol,
                timeframe.as_str()
            );
            Ok(generate_synthetic_historical_result(
                &symbol, timeframe, from, to, limit,
            ))
        }
        DataProviderMode::TwelveData => {
            if should_try_twelve_data_historical(&symbol, timeframe) {
                match try_twelve_data_historical(&symbol, timeframe, from, to, limit) {
                    Ok(candles) if !candles.is_empty() => Ok(candles),
                    Ok(_) => {
                        println!(
                            "[twelve_data] fallback to synthetic symbol={} timeframe={} reason=empty_response",
                            symbol,
                            timeframe.as_str()
                        );
                        Ok(generate_synthetic_historical_result(
                            &symbol, timeframe, from, to, limit,
                        ))
                    }
                    Err(error) => {
                        println!(
                            "[twelve_data] fallback to synthetic symbol={} timeframe={} reason={}",
                            symbol,
                            timeframe.as_str(),
                            error
                        );
                        Ok(generate_synthetic_historical_result(
                            &symbol, timeframe, from, to, limit,
                        ))
                    }
                }
            } else {
                println!(
                    "[twelve_data] fallback to synthetic symbol={} timeframe={} reason=rest_validation_not_enabled",
                    symbol,
                    timeframe.as_str()
                );
                Ok(generate_synthetic_historical_result(
                    &symbol, timeframe, from, to, limit,
                ))
            }
        }
    }
}

#[tauri::command]
fn subscribe_live(app: AppHandle, symbol: String, timeframe: String) -> Result<(), String> {
    if !is_supported_symbol(&symbol) {
        return Err(format!("Unsupported symbol: {symbol}"));
    }

    let timeframe = Timeframe::parse(&timeframe)
        .ok_or_else(|| format!("Unsupported timeframe: {timeframe}"))?;
    let key = StreamKey {
        symbol: symbol.clone(),
        timeframe,
    };

    match configured_data_provider() {
        DataProviderMode::Synthetic => subscribe_synthetic_live(app, symbol, timeframe, key),
        DataProviderMode::TwelveData => {
            println!(
                "[twelve_data] subscribe_live symbol={} timeframe={} source=synthetic_fallback",
                symbol,
                timeframe.as_str()
            );
            subscribe_synthetic_live(app, symbol, timeframe, key)
        }
    }
}

#[tauri::command]
fn unsubscribe_live(symbol: String, timeframe: String) -> Result<(), String> {
    if !is_supported_symbol(&symbol) {
        return Err(format!("Unsupported symbol: {symbol}"));
    }

    let timeframe = Timeframe::parse(&timeframe)
        .ok_or_else(|| format!("Unsupported timeframe: {timeframe}"))?;
    let key = StreamKey {
        symbol: symbol.clone(),
        timeframe,
    };

    match configured_data_provider() {
        DataProviderMode::Synthetic => unsubscribe_synthetic_live(symbol, timeframe, key),
        DataProviderMode::TwelveData => {
            println!(
                "[twelve_data] unsubscribe_live symbol={} timeframe={} source=synthetic_fallback",
                symbol,
                timeframe.as_str()
            );
            unsubscribe_synthetic_live(symbol, timeframe, key)
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    match configured_data_provider() {
        DataProviderMode::Synthetic => {
            println!("[data] startup provider=synthetic");
        }
        DataProviderMode::TwelveData => {
            println!(
                "[twelve_data] provider mode active historical_source=twelve_data_rest_with_synthetic_fallback live_source=synthetic"
            );
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_provider_capabilities,
            get_supported_symbols,
            get_historical,
            subscribe_live,
            unsubscribe_live
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
