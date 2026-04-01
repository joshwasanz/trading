use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::env;
use std::f64::consts::TAU;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{connect, Message, WebSocket};

static SYMBOL_STATES: LazyLock<Mutex<HashMap<String, SymbolState>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static LIVE_SUBSCRIPTIONS: LazyLock<Mutex<HashMap<StreamKey, usize>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static SYNTHETIC_SYMBOL_STREAMS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static TWELVE_DATA_POLL_STREAMS: LazyLock<Mutex<HashMap<StreamKey, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static MASSIVE_LIVE_WORKERS: LazyLock<Mutex<HashMap<AssetClass, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static MASSIVE_FIRST_LIVE_MESSAGES: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));
static MASSIVE_FIRST_EMITS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));
static VERBOSE_LIVE_DEBUG: LazyLock<bool> = LazyLock::new(|| {
    env::var("VERBOSE_LIVE_DEBUG")
        .map(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false)
});
static SYNTHETIC_MODE_CONFIG: LazyLock<SyntheticMode> = LazyLock::new(|| {
    let raw = env::var("SYNTHETIC_MODE")
        .or_else(|_| env::var("DATA_PROVIDER"))
        .unwrap_or_else(|_| "synthetic_dev".to_string())
        .trim()
        .to_ascii_lowercase();

    match raw.as_str() {
        "synthetic_chaos" | "synthetic-chaos" | "chaos" => SyntheticMode::Chaos,
        _ => SyntheticMode::Dev,
    }
});

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
    #[serde(rename = "validationMode")]
    validation_mode: bool,
    #[serde(rename = "strictRealtime")]
    strict_realtime: bool,
    #[serde(rename = "liveSource")]
    live_source: Option<String>,
    #[serde(rename = "pollIntervalMs")]
    poll_interval_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
struct ProviderStatusEvent {
    kind: String,
    source: String,
    symbol: Option<String>,
    timeframe: Option<String>,
    message: String,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SyntheticMode {
    Dev,
    Chaos,
}

#[derive(Debug, Clone, Copy)]
struct SyntheticProfile {
    base_price: f64,
    drift_per_bar: f64,
    volatility: f64,
    wick_factor: f64,
    mean_reversion: f64,
    burst_scale: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SyntheticRegime {
    GrindUp,
    GrindDown,
    Range,
    BreakoutUp,
    BreakoutDown,
    Pullback,
}

#[derive(Debug, Clone, Copy)]
struct SyntheticRegimeState {
    regime: SyntheticRegime,
    regime_id: u64,
    phase: f64,
    drift_bias: f64,
    volatility_multiplier: f64,
    noise_multiplier: f64,
    wick_multiplier: f64,
    mean_reversion_multiplier: f64,
    direction: f64,
    swing_period_bars: f64,
    swing_amplitude_multiplier: f64,
    swing_phase_offset: f64,
    burst_multiplier: f64,
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
        "synthetic"
        | "synthetic_dev"
        | "synthetic-dev"
        | "synthetic_chaos"
        | "synthetic-chaos" => DataProviderMode::Synthetic,
        _ => DataProviderMode::Synthetic,
    }
}

fn configured_synthetic_mode() -> SyntheticMode {
    *SYNTHETIC_MODE_CONFIG
}

fn synthetic_mode_label() -> &'static str {
    match configured_synthetic_mode() {
        SyntheticMode::Dev => "synthetic_dev",
        SyntheticMode::Chaos => "synthetic_chaos",
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

fn env_flag(name: &str) -> bool {
    env::var(name)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn strict_realtime_enabled() -> bool {
    env_flag("STRICT_REALTIME")
}

fn free_tier_validation_mode_enabled() -> bool {
    env_flag("VITE_FREE_TIER_VALIDATION_MODE") || env_flag("FREE_TIER_VALIDATION_MODE")
}

fn free_tier_validation_allowed_symbols() -> &'static [&'static str] {
    &["eurusd", "usdjpy"]
}

fn free_tier_validation_symbol_allowed(symbol: &str) -> bool {
    free_tier_validation_allowed_symbols().contains(&symbol)
}

fn free_tier_validation_rejection(symbol: &str, timeframe: Timeframe) -> Option<String> {
    if !free_tier_validation_mode_enabled() {
        return None;
    }

    if !free_tier_validation_symbol_allowed(symbol) {
        return Some(format!(
            "Validation mode only supports EURUSD and USDJPY. Blocked {}.",
            symbol.to_ascii_uppercase()
        ));
    }

    if !matches!(timeframe, Timeframe::M1 | Timeframe::M3) {
        return Some(format!(
            "Validation mode only supports 1m and 3m for {}.",
            symbol.to_ascii_uppercase()
        ));
    }

    None
}

fn twelve_data_live_poll_interval() -> Duration {
    let interval_ms = env::var("TWELVE_DATA_LIVE_POLL_INTERVAL_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|value| value.clamp(1_000, 60_000))
        .unwrap_or(5_000);

    Duration::from_millis(interval_ms)
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

fn twelve_data_validation_timeframes_for_asset_class(
    asset_class: AssetClass,
) -> &'static [Timeframe] {
    match asset_class {
        AssetClass::Forex => &[Timeframe::M1, Timeframe::M3],
        AssetClass::Index => &[Timeframe::M1],
    }
}

fn twelve_data_validation_rejection(symbol: &str, timeframe: Timeframe) -> Option<String> {
    let instrument = instrument_definition(symbol)?;
    let allowed = twelve_data_validation_timeframes_for_asset_class(instrument.asset_class);

    if allowed.contains(&timeframe) {
        return None;
    }

    Some(match instrument.asset_class {
        AssetClass::Forex => format!(
            "Forex timeframe {} is disabled for Twelve Data validation. Use 1m or 3m.",
            timeframe.as_str()
        ),
        AssetClass::Index => format!(
            "Index timeframe {} is disabled for Twelve Data validation. Use 1m.",
            timeframe.as_str()
        ),
    })
}

fn twelve_data_supported_timeframes() -> Vec<Timeframe> {
    vec![Timeframe::M1, Timeframe::M3]
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
        .filter(|instrument| {
            !free_tier_validation_mode_enabled()
                || free_tier_validation_symbol_allowed(instrument.internal_id)
        })
        .map(|instrument| SupportedSymbol {
            id: instrument.internal_id.to_string(),
            label: instrument.label.to_string(),
        })
        .collect()
}

fn is_supported_symbol(symbol: &str) -> bool {
    instrument_definition(symbol)
        .map(|instrument| instrument.enabled)
        .map(|enabled| {
            enabled
                && (!free_tier_validation_mode_enabled()
                    || free_tier_validation_symbol_allowed(symbol))
        })
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
        supported_timeframes: match configured_data_provider() {
            DataProviderMode::Synthetic => Timeframe::all()
                .iter()
                .map(|timeframe| timeframe.as_str().to_string())
                .collect(),
            DataProviderMode::TwelveData => twelve_data_supported_timeframes()
                .iter()
                .map(|timeframe| timeframe.as_str().to_string())
                .collect(),
        },
        live_supported: true,
        notice: match configured_data_provider() {
            DataProviderMode::TwelveData => Some(if free_tier_validation_mode_enabled() {
                format!(
                    "Free-tier validation mode is active. Only one live forex chart is allowed at a time using EURUSD/USDJPY on 1m or 3m. STRICT_REALTIME={} disables fallback.",
                    strict_realtime_enabled()
                )
            } else if strict_realtime_enabled() {
                "Twelve Data mode: historical candles use REST where supported. Validation supports forex 1m/3m and index 1m. Unsupported combinations fail because STRICT_REALTIME=true."
                    .to_string()
            } else {
                "Twelve Data mode: historical candles use REST where supported. Validation supports forex 1m/3m and index 1m. Unsupported combinations fall back to synthetic unless STRICT_REALTIME=true."
                    .to_string()
            }),
            DataProviderMode::Synthetic => None,
        },
        validation_mode: free_tier_validation_mode_enabled(),
        strict_realtime: strict_realtime_enabled(),
        live_source: Some(match configured_data_provider() {
            DataProviderMode::Synthetic => synthetic_mode_label().to_string(),
            DataProviderMode::TwelveData => "real_poll".to_string(),
        }),
        poll_interval_ms: Some(twelve_data_live_poll_interval().as_millis() as u64),
    }
}

fn frontend_debug_log_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|path| path.join("live-debug.log"))
        .unwrap_or_else(|| std::path::PathBuf::from("live-debug.log"))
}

fn append_frontend_debug_log_line(line: &str) {
    println!("{line}");

    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(frontend_debug_log_path())
    {
        let _ = writeln!(file, "{line}");
    }
}

fn clear_frontend_debug_log_file() {
    let _ = fs::write(frontend_debug_log_path(), "");
}

fn runtime_debug_log(scope: &str, payload: impl AsRef<str>) {
    append_frontend_debug_log_line(&format!("[runtime:{scope}] {}", payload.as_ref()));
}

fn verbose_live_debug_enabled() -> bool {
    *VERBOSE_LIVE_DEBUG
}

fn emit_provider_status<R: Runtime>(
    app: &AppHandle<R>,
    kind: &str,
    source: &str,
    symbol: Option<&str>,
    timeframe: Option<Timeframe>,
    message: &str,
) -> Result<(), String> {
    app.emit(
        "provider://status",
        ProviderStatusEvent {
            kind: kind.to_string(),
            source: source.to_string(),
            symbol: symbol.map(|value| value.to_string()),
            timeframe: timeframe.map(|value| value.as_str().to_string()),
            message: message.to_string(),
        },
    )
    .map_err(|error| error.to_string())
}

fn massive_api_key() -> Result<String, String> {
    twelve_data_api_key()
}

fn base_synthetic_profile(symbol: &str) -> SyntheticProfile {
    match symbol {
        "ndx" => SyntheticProfile {
            base_price: 18_000.0,
            drift_per_bar: 1.8,
            volatility: 14.0,
            wick_factor: 0.45,
            mean_reversion: 0.08,
            burst_scale: 0.90,
        },
        "spx" => SyntheticProfile {
            base_price: 5_000.0,
            drift_per_bar: 0.45,
            volatility: 4.2,
            wick_factor: 0.42,
            mean_reversion: 0.08,
            burst_scale: 0.72,
        },
        "eurusd" => SyntheticProfile {
            base_price: 1.1600,
            drift_per_bar: 0.00003,
            volatility: 0.00055,
            wick_factor: 0.55,
            mean_reversion: 0.12,
            burst_scale: 0.75,
        },
        "usdjpy" => SyntheticProfile {
            base_price: 155.0,
            drift_per_bar: 0.01,
            volatility: 0.08,
            wick_factor: 0.50,
            mean_reversion: 0.10,
            burst_scale: 0.82,
        },
        "gbpusd" => SyntheticProfile {
            base_price: 1.2800,
            drift_per_bar: 0.00004,
            volatility: 0.00075,
            wick_factor: 0.60,
            mean_reversion: 0.12,
            burst_scale: 0.90,
        },
        "dji" => SyntheticProfile {
            base_price: 39_000.0,
            drift_per_bar: 3.5,
            volatility: 24.0,
            wick_factor: 0.45,
            mean_reversion: 0.07,
            burst_scale: 0.95,
        },
        "usdchf" => SyntheticProfile {
            base_price: 0.9100,
            drift_per_bar: 0.00002,
            volatility: 0.00045,
            wick_factor: 0.52,
            mean_reversion: 0.12,
            burst_scale: 0.70,
        },
        "audusd" => SyntheticProfile {
            base_price: 0.6600,
            drift_per_bar: 0.00003,
            volatility: 0.00050,
            wick_factor: 0.52,
            mean_reversion: 0.12,
            burst_scale: 0.72,
        },
        "usdcad" => SyntheticProfile {
            base_price: 1.3500,
            drift_per_bar: 0.00003,
            volatility: 0.00065,
            wick_factor: 0.54,
            mean_reversion: 0.11,
            burst_scale: 0.76,
        },
        _ => SyntheticProfile {
            base_price: 100.0,
            drift_per_bar: 0.05,
            volatility: 0.8,
            wick_factor: 0.50,
            mean_reversion: 0.10,
            burst_scale: 0.70,
        },
    }
}

fn synthetic_profile(symbol: &str) -> SyntheticProfile {
    let base = base_synthetic_profile(symbol);

    match configured_synthetic_mode() {
        SyntheticMode::Dev => base,
        SyntheticMode::Chaos => SyntheticProfile {
            base_price: base.base_price,
            drift_per_bar: base.drift_per_bar * 0.95,
            volatility: base.volatility * 1.65,
            wick_factor: (base.wick_factor * 1.15).min(0.9),
            mean_reversion: base.mean_reversion * 0.85,
            burst_scale: base.burst_scale * 1.45,
        },
    }
}

fn base_price_for_symbol(symbol: &str) -> f64 {
    synthetic_profile(symbol).base_price
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
    synthetic_profile(symbol).volatility
}

fn timeframe_noise_scale(timeframe: Timeframe) -> f64 {
    match timeframe {
        Timeframe::S15 => 0.55,
        Timeframe::M1 => 0.9,
        Timeframe::M3 => 1.25,
    }
}

fn synthetic_session_activity(timestamp_secs: u64) -> f64 {
    let hour = (timestamp_secs / 3_600) % 24;

    match hour {
        7..=10 => 1.10,
        13..=16 => 1.18,
        0..=3 => 0.72,
        _ => 0.90,
    }
}

fn synthetic_noise_scale(symbol: &str) -> f64 {
    match symbol {
        "ndx" => 0.28,
        "spx" => 0.18,
        "eurusd" => 0.11,
        "usdjpy" => 0.15,
        "gbpusd" => 0.14,
        "dji" => 0.32,
        _ => 0.18,
    }
}

fn synthetic_swing_amplitude(symbol: &str) -> f64 {
    match symbol {
        "ndx" => 6.0,
        "spx" => 1.6,
        "eurusd" => 0.00016,
        "usdjpy" => 0.022,
        "gbpusd" => 0.00020,
        "dji" => 10.0,
        _ => 0.35,
    }
}

fn synthetic_swing_period_bars(symbol: &str, timeframe: Timeframe) -> f64 {
    let base_period = match symbol {
        "ndx" => 44.0,
        "spx" => 58.0,
        "eurusd" => 76.0,
        "usdjpy" => 60.0,
        "gbpusd" => 68.0,
        "dji" => 40.0,
        _ => 52.0,
    };

    base_period
        * match timeframe {
            Timeframe::S15 => 0.85,
            Timeframe::M1 => 1.0,
            Timeframe::M3 => 1.40,
        }
}

fn synthetic_session_directional_bias(
    symbol: &str,
    timeframe: Timeframe,
    timestamp_secs: u64,
    profile: SyntheticProfile,
) -> f64 {
    let hour = (timestamp_secs / 3_600) % 24;
    let bias_scale = match hour {
        7..=10 => 0.08,
        13..=16 => 0.12,
        0..=3 => 0.02,
        _ => 0.03,
    };

    deterministic_signed(symbol, timeframe, timestamp_secs / 3_600, 41)
        * profile.volatility
        * bias_scale
}

fn synthetic_regime_state(
    symbol: &str,
    timeframe: Timeframe,
    timestamp_secs: u64,
    _profile: SyntheticProfile,
) -> SyntheticRegimeState {
    let aligned_time = align_timestamp(timestamp_secs, timeframe);
    let bar_index = aligned_time / timeframe.duration();
    let cycle_span = 228_u64;
    let cycle_id = bar_index / cycle_span;
    let cycle_offset = bar_index % cycle_span;
    let first_regime_len = 48 + (deterministic_hash(symbol, timeframe, cycle_id, 131) % 49);
    let remaining_after_first = cycle_span.saturating_sub(first_regime_len);
    let second_max = remaining_after_first.saturating_sub(44).min(84);
    let second_span = second_max.saturating_sub(40) + 1;
    let second_regime_len = 40 + (deterministic_hash(symbol, timeframe, cycle_id, 132) % second_span.max(1));
    let third_regime_len = cycle_span
        .saturating_sub(first_regime_len)
        .saturating_sub(second_regime_len)
        .max(40);
    let (cycle_slot, regime_id, local_offset, regime_len) = if cycle_offset < first_regime_len {
        (0_u64, cycle_id * 3, cycle_offset, first_regime_len)
    } else {
        let second_boundary = first_regime_len + second_regime_len;
        if cycle_offset < second_boundary {
            (
                1_u64,
                cycle_id * 3 + 1,
                cycle_offset - first_regime_len,
                second_regime_len.max(1),
            )
        } else {
            (
                2_u64,
                cycle_id * 3 + 2,
                cycle_offset - second_boundary,
                third_regime_len.max(1),
            )
        }
    };
    let phase = if regime_len <= 1 {
        0.0
    } else {
        local_offset as f64 / (regime_len - 1) as f64
    };
    let cycle_trend_sign = if deterministic_signed(symbol, timeframe, cycle_id, 133) >= 0.0 {
        1.0
    } else {
        -1.0
    };
    let selector = deterministic_hash(symbol, timeframe, regime_id, 134) % 4;
    let strength = 0.55 + deterministic_signed(symbol, timeframe, regime_id, 135).abs() * 0.60;
    let swing_period_bars = synthetic_swing_period_bars(symbol, timeframe)
        * (0.90 + deterministic_signed(symbol, timeframe, regime_id, 136).abs() * 0.65)
        * match cycle_slot {
            0 => 1.0,
            1 => 0.82,
            _ => 1.18,
        };
    let swing_amplitude_multiplier = (0.18
        + deterministic_signed(symbol, timeframe, regime_id, 137).abs() * 0.28)
        * match cycle_slot {
            1 => 0.75,
            _ => 1.0,
        };
    let swing_phase_offset =
        deterministic_hash(symbol, timeframe, regime_id, 138) as f64 / u64::MAX as f64 * TAU;
    let burst_multiplier = 0.75 + deterministic_signed(symbol, timeframe, regime_id, 139).abs() * 0.40;

    let (regime, drift_bias, volatility_multiplier, noise_multiplier, wick_multiplier, mean_reversion_multiplier, direction) =
        match cycle_slot {
            0 => match selector {
                0 => (
                    if cycle_trend_sign > 0.0 {
                        SyntheticRegime::GrindUp
                    } else {
                        SyntheticRegime::GrindDown
                    },
                    cycle_trend_sign * 0.58 * strength,
                    0.88,
                    0.60,
                    0.66,
                    0.60,
                    cycle_trend_sign,
                ),
                1 => (
                    SyntheticRegime::Range,
                    cycle_trend_sign * 0.10 * strength,
                    0.58,
                    0.44,
                    0.52,
                    1.24,
                    cycle_trend_sign,
                ),
                _ => (
                    if cycle_trend_sign > 0.0 {
                        SyntheticRegime::BreakoutUp
                    } else {
                        SyntheticRegime::BreakoutDown
                    },
                    cycle_trend_sign * 0.88 * strength,
                    1.02,
                    0.50,
                    0.60,
                    0.34,
                    cycle_trend_sign,
                ),
            },
            1 => match selector {
                0 | 1 => (
                    SyntheticRegime::Pullback,
                    -cycle_trend_sign * 0.34 * strength,
                    0.74,
                    0.34,
                    0.48,
                    0.86,
                    -cycle_trend_sign,
                ),
                2 => (
                    SyntheticRegime::Range,
                    0.0,
                    0.56,
                    0.38,
                    0.48,
                    1.34,
                    cycle_trend_sign,
                ),
                _ => (
                    if cycle_trend_sign > 0.0 {
                        SyntheticRegime::GrindDown
                    } else {
                        SyntheticRegime::GrindUp
                    },
                    -cycle_trend_sign * 0.24 * strength,
                    0.72,
                    0.36,
                    0.50,
                    0.98,
                    -cycle_trend_sign,
                ),
            },
            _ => match selector {
                0 => (
                    if cycle_trend_sign > 0.0 {
                        SyntheticRegime::GrindUp
                    } else {
                        SyntheticRegime::GrindDown
                    },
                    cycle_trend_sign * 0.62 * strength,
                    0.86,
                    0.52,
                    0.58,
                    0.62,
                    cycle_trend_sign,
                ),
                1 | 2 => (
                    if cycle_trend_sign > 0.0 {
                        SyntheticRegime::BreakoutUp
                    } else {
                        SyntheticRegime::BreakoutDown
                    },
                    cycle_trend_sign * 0.96 * strength,
                    1.10,
                    0.48,
                    0.56,
                    0.28,
                    cycle_trend_sign,
                ),
                _ => (
                    SyntheticRegime::Range,
                    cycle_trend_sign * 0.06 * strength,
                    0.54,
                    0.36,
                    0.46,
                    1.28,
                    cycle_trend_sign,
                ),
            },
        };

    SyntheticRegimeState {
        regime,
        regime_id,
        phase,
        drift_bias,
        volatility_multiplier,
        noise_multiplier,
        wick_multiplier,
        mean_reversion_multiplier,
        direction,
        swing_period_bars,
        swing_amplitude_multiplier,
        swing_phase_offset,
        burst_multiplier,
    }
}

fn synthetic_swing_drift(period_bars: f64, bar_index: u64, amplitude: f64, phase_offset: f64) -> f64 {
    let period = period_bars.max(18.0);
    let current_x = (bar_index as f64 / period) * TAU + phase_offset;
    let previous_x = (bar_index.saturating_sub(1) as f64 / period) * TAU + phase_offset;
    let current = current_x.sin() + (current_x * 0.61 + phase_offset * 0.35).sin() * 0.18;
    let previous = previous_x.sin() + (previous_x * 0.61 + phase_offset * 0.35).sin() * 0.18;

    amplitude * (current - previous)
}

fn synthetic_momentum_burst(
    symbol: &str,
    timeframe: Timeframe,
    timestamp_secs: u64,
    profile: SyntheticProfile,
    regime_state: SyntheticRegimeState,
) -> f64 {
    let aligned_time = align_timestamp(timestamp_secs, timeframe);
    let bar_index = aligned_time / timeframe.duration();
    let burst_window = match configured_synthetic_mode() {
        SyntheticMode::Dev => 28_u64,
        SyntheticMode::Chaos => 20_u64,
    };
    let burst_id = bar_index / burst_window;
    let trigger = deterministic_signed(symbol, timeframe, burst_id, 151);
    let threshold = match configured_synthetic_mode() {
        SyntheticMode::Dev => 0.968,
        SyntheticMode::Chaos => 0.90,
    };

    let regime_allows_burst = matches!(
        regime_state.regime,
        SyntheticRegime::BreakoutUp
            | SyntheticRegime::BreakoutDown
            | SyntheticRegime::GrindUp
            | SyntheticRegime::GrindDown
    );
    if !regime_allows_burst || trigger.abs() < threshold {
        return 0.0;
    }

    let burst_length = 4 + (deterministic_hash(symbol, timeframe, burst_id, 152) % 9);
    let burst_phase = bar_index % burst_window;
    if burst_phase >= burst_length {
        return 0.0;
    }

    let phase = if burst_length <= 1 {
        0.0
    } else {
        burst_phase as f64 / (burst_length - 1) as f64
    };
    let envelope = if phase <= 0.25 {
        0.80 + phase * 0.90
    } else if phase <= 0.70 {
        1.02 - (phase - 0.25) * 0.28
    } else {
        0.90 - (phase - 0.70) * 1.25
    };

    regime_state.direction
        * profile.volatility
        * profile.burst_scale
        * regime_state.burst_multiplier
        * 0.70
        * envelope.max(0.0)
}

fn synthetic_wick_event_scale(symbol: &str, timeframe: Timeframe, timestamp_secs: u64) -> f64 {
    let aligned_time = align_timestamp(timestamp_secs, timeframe);
    let bar_index = aligned_time / timeframe.duration();
    let spike = deterministic_signed(symbol, timeframe, bar_index / 12, 161).abs();

    if spike > 0.975 {
        1.35
    } else if spike > 0.94 {
        1.12
    } else {
        1.0
    }
}

fn synthetic_live_tick_interval_ms() -> u64 {
    match configured_synthetic_mode() {
        SyntheticMode::Dev => 250,
        SyntheticMode::Chaos => 120,
    }
}

fn market_anchor_price(symbol: &str, time_secs: u64) -> f64 {
    let base = base_price_for_symbol(symbol);
    let offset = (symbol_seed(symbol) % 3_600) as f64;
    let t = time_secs as f64 + offset;
    let slow_trend = (t / 10_800.0).sin() * base * 0.0011;
    let medium_cycle = (t / 3_600.0).cos() * base * 0.00055;
    let longer_bias = (t / 28_800.0).sin() * base * 0.00175;

    base + slow_trend + medium_cycle + longer_bias
}

fn evolve_live_price(symbol: &str, time_millis: u64, previous_price: f64) -> f64 {
    let time_secs = time_millis / 1_000;
    let profile = synthetic_profile(symbol);
    let regime_state = synthetic_regime_state(symbol, Timeframe::S15, time_secs, profile);
    let anchor = market_anchor_price(symbol, time_secs);
    let activity = synthetic_session_activity(time_secs);
    let bar_index = align_timestamp(time_secs, Timeframe::S15) / Timeframe::S15.duration();
    let regime_envelope = match regime_state.regime {
        SyntheticRegime::BreakoutUp | SyntheticRegime::BreakoutDown => {
            0.85 + (1.0 - (regime_state.phase - 0.28).abs() * 1.65).max(0.0) * 0.7
        }
        SyntheticRegime::Pullback => 0.95 - regime_state.phase * 0.35,
        SyntheticRegime::Range => 0.35 + ((regime_state.phase * TAU).sin().abs() * 0.12),
        _ => 0.72 + ((regime_state.phase * TAU).sin().abs() * 0.22),
    };
    let pull = (anchor - previous_price)
        * (profile.mean_reversion * regime_state.mean_reversion_multiplier * 0.025);
    let bar_swing = synthetic_swing_drift(
        regime_state.swing_period_bars * 0.65,
        bar_index,
        synthetic_swing_amplitude(symbol) * regime_state.swing_amplitude_multiplier * 0.08,
        regime_state.swing_phase_offset,
    );
    let structural_bias = deterministic_signed(symbol, Timeframe::S15, bar_index / 10, 171)
        * profile.volatility
        * 0.010
        * regime_state.noise_multiplier;
    let drift = profile.drift_per_bar * regime_state.drift_bias * regime_envelope * 0.015
        + synthetic_session_directional_bias(symbol, Timeframe::S15, time_secs, profile) * 0.04
        + synthetic_momentum_burst(symbol, Timeframe::S15, time_secs, profile, regime_state) * 0.05
        + bar_swing * 0.08
        + structural_bias;
    let micro = deterministic_signed(symbol, Timeframe::S15, time_millis / 250, 91)
        * profile.volatility
        * synthetic_noise_scale(symbol)
        * regime_state.noise_multiplier
        * 0.008
        * activity;
    let momentum = deterministic_signed(symbol, Timeframe::S15, time_millis / 500, 92)
        * profile.volatility
        * synthetic_noise_scale(symbol)
        * regime_state.noise_multiplier
        * 0.003
        * activity;

    (previous_price + drift + pull + micro + momentum).max(0.00001)
}

fn emit_candle<R: Runtime>(
    app: &AppHandle<R>,
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
    twelve_data_validation_rejection(symbol, timeframe).is_none()
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
    app: AppHandle<impl Runtime>,
    symbol: String,
    timeframe: Timeframe,
    key: StreamKey,
) -> Result<(), String> {
    enforce_single_live_subscription_for_validation_mode(&key);

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

fn has_live_subscription(key: &StreamKey) -> bool {
    LIVE_SUBSCRIPTIONS
        .lock()
        .ok()
        .and_then(|subscriptions| subscriptions.get(key).copied())
        .map(|count| count > 0)
        .unwrap_or(false)
}

fn should_try_twelve_data_live(symbol: &str, timeframe: Timeframe) -> bool {
    should_try_twelve_data_historical(symbol, timeframe)
}

fn is_same_candle(left: &Candle, right: &Candle) -> bool {
    left.time == right.time
        && left.open == right.open
        && left.high == right.high
        && left.low == right.low
        && left.close == right.close
}

fn emit_twelve_data_live_candles<R: Runtime>(
    app: &AppHandle<R>,
    symbol: &str,
    timeframe: Timeframe,
    candles: &[Candle],
    last_seen: &mut HashMap<u64, Candle>,
) {
    let active_times = candles
        .iter()
        .map(|candle| candle.time)
        .collect::<HashSet<_>>();
    last_seen.retain(|time, _| active_times.contains(time));

    for candle in candles {
        let should_emit = last_seen
            .get(&candle.time)
            .map(|previous| !is_same_candle(previous, candle))
            .unwrap_or(true);

        if should_emit {
            store_symbol_state(symbol, candle.time, candle.close);
            if verbose_live_debug_enabled() {
                runtime_debug_log(
                    "live_emit",
                    format!(
                        "provider=twelve_data symbol={} timeframe={} time={} close={}",
                        symbol,
                        timeframe.as_str(),
                        candle.time,
                        candle.close
                    ),
                );
            }
            let _ = emit_candle(app, symbol, timeframe, candle);
        }

        last_seen.insert(candle.time, candle.clone());
    }
}

fn clear_twelve_data_poll_stream(key: &StreamKey, should_run: &Arc<AtomicBool>) {
    if let Ok(mut streams) = TWELVE_DATA_POLL_STREAMS.lock() {
        let should_clear = streams
            .get(key)
            .map(|current| Arc::ptr_eq(current, should_run))
            .unwrap_or(false);

        if should_clear {
            streams.remove(key);
        }
    }
}

fn enforce_single_live_subscription_for_validation_mode(active_key: &StreamKey) {
    if !free_tier_validation_mode_enabled() {
        return;
    }

    let removed_keys = {
        let mut subscriptions = match LIVE_SUBSCRIPTIONS.lock() {
            Ok(subscriptions) => subscriptions,
            Err(_) => return,
        };
        let removed = subscriptions
            .keys()
            .filter(|key| *key != active_key)
            .cloned()
            .collect::<Vec<_>>();

        for key in &removed {
            subscriptions.remove(key);
        }

        removed
    };

    if removed_keys.is_empty() {
        return;
    }

    let mut synthetic_symbols_to_check = HashSet::<String>::new();

    for key in &removed_keys {
        if let Ok(mut streams) = TWELVE_DATA_POLL_STREAMS.lock() {
            if let Some(should_run) = streams.remove(key) {
                should_run.store(false, Ordering::Relaxed);
                println!(
                    "[validation] unsubscribed prior live poll symbol={} timeframe={} reason=single_subscription_rule",
                    key.symbol,
                    key.timeframe.as_str()
                );
                continue;
            }
        }

        synthetic_symbols_to_check.insert(key.symbol.clone());
    }

    for symbol in synthetic_symbols_to_check {
        let has_remaining_subscription = LIVE_SUBSCRIPTIONS
            .lock()
            .ok()
            .map(|subscriptions| {
                subscriptions
                    .iter()
                    .any(|(key, count)| key.symbol == symbol && *count > 0)
            })
            .unwrap_or(false);

        if has_remaining_subscription {
            continue;
        }

        if let Ok(mut streams) = SYNTHETIC_SYMBOL_STREAMS.lock() {
            if let Some(should_run) = streams.remove(&symbol) {
                should_run.store(false, Ordering::Relaxed);
                println!(
                    "[validation] unsubscribed prior live poll symbol={} timeframe=* reason=single_subscription_rule",
                    symbol
                );
            }
        }
    }
}

fn start_twelve_data_poll_stream<R: Runtime>(
    app: AppHandle<R>,
    symbol: String,
    timeframe: Timeframe,
    key: StreamKey,
    should_run: Arc<AtomicBool>,
    initial_candles: Vec<Candle>,
) {
    thread::spawn(move || {
        let poll_interval = twelve_data_live_poll_interval();
        let mut last_seen = HashMap::<u64, Candle>::new();
        let mut pending_initial = Some(initial_candles);
        let mut had_poll_error = false;

        println!(
            "[twelve_data] live poll started symbol={} timeframe={} source=real_poll interval_ms={}",
            symbol,
            timeframe.as_str(),
            poll_interval.as_millis()
        );

        while should_run.load(Ordering::Relaxed) {
            if !has_live_subscription(&key) {
                break;
            }

            let result = match pending_initial.take() {
                Some(candles) => Ok(candles),
                None => fetch_twelve_data_historical(&symbol, timeframe, None, None, Some(2)),
            };

            let sleep_for = match result {
                Ok(candles) => {
                    emit_twelve_data_live_candles(
                        &app,
                        &symbol,
                        timeframe,
                        &candles,
                        &mut last_seen,
                    );
                    if had_poll_error {
                        let _ = emit_provider_status(
                            &app,
                            "info",
                            "live_poll",
                            Some(&symbol),
                            Some(timeframe),
                            "Live poll recovered.",
                        );
                        had_poll_error = false;
                    }
                    poll_interval
                }
                Err(error) => {
                    eprintln!(
                        "[twelve_data] live poll error symbol={} timeframe={} source=real_poll error={}",
                        symbol,
                        timeframe.as_str(),
                        error
                    );
                    let _ = emit_provider_status(
                        &app,
                        "error",
                        "live_poll",
                        Some(&symbol),
                        Some(timeframe),
                        &error,
                    );
                    had_poll_error = true;
                    Duration::from_secs(10)
                }
            };

            if should_run.load(Ordering::Relaxed) && has_live_subscription(&key) {
                thread::sleep(sleep_for);
            }
        }

        clear_twelve_data_poll_stream(&key, &should_run);
    });
}

fn fallback_or_error_for_twelve_data_live(
    app: AppHandle<impl Runtime>,
    symbol: String,
    timeframe: Timeframe,
    key: StreamKey,
    reason: &str,
) -> Result<(), String> {
    if free_tier_validation_mode_enabled() || strict_realtime_enabled() {
        eprintln!(
            "[twelve_data] subscribe_live symbol={} timeframe={} source=disabled strict_realtime={} validation_mode={} reason={}",
            symbol,
            timeframe.as_str(),
            strict_realtime_enabled(),
            free_tier_validation_mode_enabled(),
            reason
        );
        return Err(format!(
            "Twelve Data live subscription unavailable for {}/{}: {reason}",
            symbol,
            timeframe.as_str()
        ));
    }

    println!(
        "[twelve_data] subscribe_live symbol={} timeframe={} source=synthetic_fallback strict_realtime=false reason={}",
        symbol,
        timeframe.as_str(),
        reason
    );
    subscribe_synthetic_live(app, symbol, timeframe, key)
}

fn subscribe_twelve_data_live(
    app: AppHandle<impl Runtime>,
    symbol: String,
    timeframe: Timeframe,
    key: StreamKey,
) -> Result<(), String> {
    enforce_single_live_subscription_for_validation_mode(&key);

    let poll_already_running = TWELVE_DATA_POLL_STREAMS
        .lock()
        .map_err(|_| "twelve data live registry lock failed".to_string())?
        .contains_key(&key);

    if poll_already_running {
        println!(
            "[twelve_data] subscribe_live symbol={} timeframe={} source=real_poll",
            symbol,
            timeframe.as_str()
        );
        let mut subscriptions = LIVE_SUBSCRIPTIONS
            .lock()
            .map_err(|_| "live subscription registry lock failed".to_string())?;
        let entry = subscriptions.entry(key).or_insert(0);
        *entry += 1;
        return Ok(());
    }

    if !should_try_twelve_data_live(&symbol, timeframe) {
        return fallback_or_error_for_twelve_data_live(
            app,
            symbol,
            timeframe,
            key,
            "rest_poll_not_supported",
        );
    }

    let initial_candles =
        match fetch_twelve_data_historical(&symbol, timeframe, None, None, Some(2)) {
            Ok(candles) if !candles.is_empty() => candles,
            Ok(_) => {
                return fallback_or_error_for_twelve_data_live(
                    app,
                    symbol,
                    timeframe,
                    key,
                    "empty_response",
                )
            }
            Err(error) => {
                return fallback_or_error_for_twelve_data_live(app, symbol, timeframe, key, &error)
            }
        };

    println!(
        "[twelve_data] subscribe_live symbol={} timeframe={} source=real_poll",
        symbol,
        timeframe.as_str()
    );
    if verbose_live_debug_enabled() {
        runtime_debug_log(
            "live_subscribe",
            format!(
                "provider=twelve_data source=real_poll symbol={} timeframe={}",
                symbol,
                timeframe.as_str()
            ),
        );
    }

    {
        let mut subscriptions = LIVE_SUBSCRIPTIONS
            .lock()
            .map_err(|_| "live subscription registry lock failed".to_string())?;
        let entry = subscriptions.entry(key.clone()).or_insert(0);
        *entry += 1;
    }

    let should_start = {
        let mut streams = TWELVE_DATA_POLL_STREAMS
            .lock()
            .map_err(|_| "twelve data live registry lock failed".to_string())?;

        if streams.contains_key(&key) {
            None
        } else {
            let should_run = Arc::new(AtomicBool::new(true));
            streams.insert(key.clone(), should_run.clone());
            Some(should_run)
        }
    };

    if let Some(should_run) = should_start {
        start_twelve_data_poll_stream(app, symbol, timeframe, key, should_run, initial_candles);
    }

    Ok(())
}

fn unsubscribe_twelve_data_live(
    symbol: String,
    timeframe: Timeframe,
    key: StreamKey,
) -> Result<(), String> {
    println!(
        "[twelve_data] unsubscribe_live symbol={} timeframe={} source=real_poll",
        symbol,
        timeframe.as_str()
    );

    let should_stop = {
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
                true
            }
            None => false,
        }
    };

    if should_stop {
        let should_run = {
            let mut streams = TWELVE_DATA_POLL_STREAMS
                .lock()
                .map_err(|_| "twelve data live registry lock failed".to_string())?;
            streams.remove(&key)
        };

        if let Some(should_run) = should_run {
            should_run.store(false, Ordering::Relaxed);
        }
    }

    Ok(())
}

fn is_twelve_data_poll_stream(key: &StreamKey) -> bool {
    TWELVE_DATA_POLL_STREAMS
        .lock()
        .ok()
        .map(|streams| streams.contains_key(key))
        .unwrap_or(false)
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

fn start_synthetic_symbol_stream<R: Runtime>(
    app: AppHandle<R>,
    symbol: String,
    should_run: Arc<AtomicBool>,
) {
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

            thread::sleep(Duration::from_millis(synthetic_live_tick_interval_ms()));
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
    let profile = synthetic_profile(symbol);
    let regime_state = synthetic_regime_state(symbol, timeframe, time, profile);
    let bar_index = align_timestamp(time, timeframe) / timeframe.duration();
    let anchor = market_anchor_price(symbol, time);
    let activity = synthetic_session_activity(time);
    let volatility = base_tick_volatility(symbol)
        * timeframe_noise_scale(timeframe)
        * activity
        * regime_state.volatility_multiplier;
    let regime_envelope = match regime_state.regime {
        SyntheticRegime::BreakoutUp | SyntheticRegime::BreakoutDown => {
            1.02 + (1.0 - (regime_state.phase - 0.18).abs() * 2.1).max(0.0) * 0.34
        }
        SyntheticRegime::Pullback => 0.66 - regime_state.phase * 0.16,
        SyntheticRegime::Range => 0.14 + deterministic_signed(symbol, timeframe, regime_state.regime_id, 173).abs() * 0.10,
        SyntheticRegime::GrindUp => 0.78 + regime_state.phase * 0.18,
        SyntheticRegime::GrindDown => 0.86 + (1.0 - regime_state.phase) * 0.22,
    };
    let baseline_drift = profile.drift_per_bar * regime_state.drift_bias * regime_envelope;
    let session_bias = synthetic_session_directional_bias(symbol, timeframe, time, profile);
    let momentum_burst = synthetic_momentum_burst(symbol, timeframe, time, profile, regime_state);
    let swing_component = synthetic_swing_drift(
        regime_state.swing_period_bars,
        bar_index,
        synthetic_swing_amplitude(symbol)
            * regime_state.swing_amplitude_multiplier
            * regime_state.volatility_multiplier,
        regime_state.swing_phase_offset,
    );
    let pullback =
        (anchor - previous_close) * profile.mean_reversion * regime_state.mean_reversion_multiplier;
    let structural_noise = deterministic_signed(symbol, timeframe, bar_index / 8, 174)
        * volatility
        * 0.09
        * regime_state.noise_multiplier;
    let controlled_noise = deterministic_signed(symbol, timeframe, time, 1)
        * volatility
        * synthetic_noise_scale(symbol)
        * regime_state.noise_multiplier
        * 0.75;
    let secondary_noise = deterministic_signed(symbol, timeframe, time, 2)
        * volatility
        * 0.07
        * regime_state.noise_multiplier;
    let open = previous_close.max(0.00001);
    let close = (open
        + baseline_drift
        + swing_component
        + session_bias
        + momentum_burst
        + pullback
        + structural_noise
        + controlled_noise
        + secondary_noise)
        .max(0.00001);
    let wick_scale = volatility
        * profile.wick_factor
        * regime_state.wick_multiplier
        * synthetic_wick_event_scale(symbol, timeframe, time)
        * 0.48;
    let min_wick = (profile.base_price * 0.00002).max(profile.volatility * 0.04);
    let upper_wick =
        min_wick + deterministic_signed(symbol, timeframe, time, 4).abs() * wick_scale;
    let lower_wick =
        min_wick + deterministic_signed(symbol, timeframe, time, 5).abs() * wick_scale;
    let high = open.max(close) + upper_wick;
    let low = (open.min(close) - lower_wick).max(0.00001);

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
    let warmup_steps = 120usize;
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
    let factor = (timeframe.duration() / raw_step_seconds) as usize;
    let use_provider_latest_window = from.is_none() && to.is_none();
    let requested_window = if use_provider_latest_window {
        None
    } else {
        let effective_to = align_timestamp(to.unwrap_or(now), timeframe);
        let effective_from = match from {
            Some(value) => align_timestamp(value, timeframe),
            None => effective_to
                .saturating_sub((requested_limit as u64).saturating_sub(1) * timeframe.duration()),
        };

        if effective_from > effective_to {
            return Ok(Vec::new());
        }

        let raw_to = if factor == 1 {
            effective_to
        } else {
            effective_to.saturating_add(timeframe.duration() - raw_step_seconds)
        };

        Some((effective_from, effective_to, raw_to))
    };
    let raw_limit = requested_window
        .map(|(effective_from, _, raw_to)| {
            (((raw_to.saturating_sub(effective_from)) / raw_step_seconds) as usize + 1)
                .max(requested_limit.saturating_mul(factor))
        })
        .unwrap_or_else(|| requested_limit.saturating_mul(factor))
        .clamp(1, max_limit);
    let request_url = format!("{}/time_series", twelve_data_rest_base_url());

    let client = Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("Failed to build Twelve Data HTTP client: {error}"))?;

    let mut query = vec![
        ("symbol", provider_ticker.clone()),
        ("interval", interval.to_string()),
        ("apikey", api_key),
        ("timezone", "UTC".to_string()),
        ("order", "ASC".to_string()),
        ("format", "JSON".to_string()),
        ("outputsize", raw_limit.to_string()),
    ];

    if let Some((effective_from, _, raw_to)) = requested_window {
        query.push((
            "start_date",
            format_timestamp_for_twelve_data(effective_from),
        ));
        query.push(("end_date", format_timestamp_for_twelve_data(raw_to)));
    }

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

    if let Some((effective_from, effective_to, _)) = requested_window {
        candles.retain(|candle| candle.time >= effective_from && candle.time <= effective_to);
    }

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
fn frontend_debug_log(scope: String, payload: String) {
    append_frontend_debug_log_line(&format!("[frontend:{scope}] {payload}"));
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

    let timeframe = Timeframe::parse(&timeframe)
        .ok_or_else(|| format!("Unsupported timeframe: {timeframe}"))?;

    if let Some(reason) = free_tier_validation_rejection(&symbol, timeframe) {
        eprintln!(
            "[validation] blocked get_historical symbol={} timeframe={} reason={}",
            symbol,
            timeframe.as_str(),
            reason
        );
        return Err(reason);
    }

    if !is_supported_symbol(&symbol) {
        return Err(format!("Unsupported symbol: {symbol}"));
    }

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
            if let Some(reason) = twelve_data_validation_rejection(&symbol, timeframe) {
                if free_tier_validation_mode_enabled() || strict_realtime_enabled() {
                    eprintln!(
                        "[twelve_data] historical disabled symbol={} timeframe={} strict_realtime={} validation_mode={} reason={}",
                        symbol,
                        timeframe.as_str(),
                        strict_realtime_enabled(),
                        free_tier_validation_mode_enabled(),
                        reason
                    );
                    return Err(reason);
                }

                println!(
                    "[twelve_data] fallback to synthetic symbol={} timeframe={} reason={}",
                    symbol,
                    timeframe.as_str(),
                    reason
                );
                Ok(generate_synthetic_historical_result(
                    &symbol, timeframe, from, to, limit,
                ))
            } else if should_try_twelve_data_historical(&symbol, timeframe) {
                match try_twelve_data_historical(&symbol, timeframe, from, to, limit) {
                    Ok(candles) if !candles.is_empty() => Ok(candles),
                    Ok(_) => {
                        if free_tier_validation_mode_enabled() {
                            return Err(format!(
                                "Twelve Data historical unavailable for {}/{}: empty_response",
                                symbol,
                                timeframe.as_str()
                            ));
                        }
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
                        if free_tier_validation_mode_enabled() {
                            return Err(error);
                        }
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
                if free_tier_validation_mode_enabled() {
                    return Err(format!(
                        "Twelve Data historical unavailable for {}/{}: rest_validation_not_enabled",
                        symbol,
                        timeframe.as_str()
                    ));
                }
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
    subscribe_live_with_app(app, symbol, timeframe)
}

fn subscribe_live_with_app<R: Runtime>(
    app: AppHandle<R>,
    symbol: String,
    timeframe: String,
) -> Result<(), String> {
    let timeframe = Timeframe::parse(&timeframe)
        .ok_or_else(|| format!("Unsupported timeframe: {timeframe}"))?;

    if let Some(reason) = free_tier_validation_rejection(&symbol, timeframe) {
        eprintln!(
            "[validation] blocked subscribe_live symbol={} timeframe={} reason={}",
            symbol,
            timeframe.as_str(),
            reason
        );
        return Err(reason);
    }

    if !is_supported_symbol(&symbol) {
        return Err(format!("Unsupported symbol: {symbol}"));
    }
    let key = StreamKey {
        symbol: symbol.clone(),
        timeframe,
    };

    match configured_data_provider() {
        DataProviderMode::Synthetic => subscribe_synthetic_live(app, symbol, timeframe, key),
        DataProviderMode::TwelveData => {
            if let Some(reason) = twelve_data_validation_rejection(&symbol, timeframe) {
                fallback_or_error_for_twelve_data_live(app, symbol, timeframe, key, &reason)
            } else {
                subscribe_twelve_data_live(app, symbol, timeframe, key)
            }
        }
    }
}

#[tauri::command]
fn unsubscribe_live(symbol: String, timeframe: String) -> Result<(), String> {
    let timeframe = Timeframe::parse(&timeframe)
        .ok_or_else(|| format!("Unsupported timeframe: {timeframe}"))?;

    if let Some(reason) = free_tier_validation_rejection(&symbol, timeframe) {
        eprintln!(
            "[validation] blocked unsubscribe_live symbol={} timeframe={} reason={}",
            symbol,
            timeframe.as_str(),
            reason
        );
        return Err(reason);
    }

    if !is_supported_symbol(&symbol) {
        return Err(format!("Unsupported symbol: {symbol}"));
    }
    let key = StreamKey {
        symbol: symbol.clone(),
        timeframe,
    };

    match configured_data_provider() {
        DataProviderMode::Synthetic => unsubscribe_synthetic_live(symbol, timeframe, key),
        DataProviderMode::TwelveData => {
            if is_twelve_data_poll_stream(&key) {
                unsubscribe_twelve_data_live(symbol, timeframe, key)
            } else {
                println!(
                    "[twelve_data] unsubscribe_live symbol={} timeframe={} source=synthetic_fallback",
                    symbol,
                    timeframe.as_str()
                );
                unsubscribe_synthetic_live(symbol, timeframe, key)
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    clear_frontend_debug_log_file();
    runtime_debug_log("startup", "cleared debug log");
    runtime_debug_log(
        "startup",
        format!(
            "frontend_mode={}",
            env::var("VITE_STARTUP_DIAGNOSTICS_MODE")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "full".to_string())
        ),
    );
    runtime_debug_log(
        "startup",
        format!(
            "free_tier_validation_mode={}",
            free_tier_validation_mode_enabled()
        ),
    );

    match configured_data_provider() {
        DataProviderMode::Synthetic => {
            println!(
                "[data] startup provider=synthetic mode={}",
                synthetic_mode_label()
            );
        }
        DataProviderMode::TwelveData => {
            if free_tier_validation_mode_enabled() {
                println!(
                    "[validation] free-tier mode active provider=twelve_data live_source=real_poll poll_interval_ms={}",
                    twelve_data_live_poll_interval().as_millis()
                );
            }

            if strict_realtime_enabled() {
                println!(
                    "[twelve_data] provider mode active historical_source=twelve_data_rest_with_synthetic_fallback live_source=twelve_data_rest_poll_strict"
                );
            } else {
                println!(
                    "[twelve_data] provider mode active historical_source=twelve_data_rest_with_synthetic_fallback live_source=twelve_data_rest_poll_with_synthetic_fallback"
                );
            }
        }
    }

    tauri::Builder::default()
        .setup(|_app| {
            runtime_debug_log("setup", "tauri setup complete");
            Ok(())
        })
        .on_page_load(|webview, payload| {
            runtime_debug_log(
                "page_load",
                format!(
                    "window={} event={:?} url={}",
                    webview.label(),
                    payload.event(),
                    payload.url()
                ),
            );
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            frontend_debug_log,
            get_provider_capabilities,
            get_supported_symbols,
            get_historical,
            subscribe_live,
            unsubscribe_live
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(debug_assertions)]
#[derive(Debug, Clone, Deserialize)]
struct DebugSmokeLiveCandleEvent {
    symbol: String,
    timeframe: String,
    time: u64,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
}

#[cfg(debug_assertions)]
pub fn run_twelve_data_usdjpy_live_smoke() -> Result<(), String> {
    use std::collections::HashMap;
    use std::sync::mpsc;
    use std::time::Instant;
    use tauri::Listener;

    let symbol = "usdjpy".to_string();
    let timeframe = Timeframe::M1;
    let timeframe_str = timeframe.as_str().to_string();
    let key = StreamKey {
        symbol: symbol.clone(),
        timeframe,
    };

    std::env::set_var("DATA_PROVIDER", "twelve_data");
    std::env::set_var("STRICT_REALTIME", "true");

    twelve_data_api_key()?;

    let app = tauri::test::mock_app();
    let event_name = format!("candle://{symbol}/{timeframe_str}");
    let (tx, rx) = mpsc::channel::<DebugSmokeLiveCandleEvent>();
    let _listener = app.listen_any(event_name.clone(), move |event: tauri::Event| {
        let payload = serde_json::from_str::<DebugSmokeLiveCandleEvent>(event.payload()).unwrap();
        tx.send(payload).unwrap();
    });

    println!(
        "[smoke] subscribing symbol={} timeframe={} strict_realtime={} poll_interval_ms={}",
        symbol,
        timeframe_str,
        strict_realtime_enabled(),
        twelve_data_live_poll_interval().as_millis()
    );
    subscribe_live_with_app(app.handle().clone(), symbol.clone(), timeframe_str.clone())?;

    if !is_twelve_data_poll_stream(&key) {
        return Err(
            "expected Twelve Data poll stream registry to contain the active stream".into(),
        );
    }
    if SYNTHETIC_SYMBOL_STREAMS
        .lock()
        .map_err(|_| "synthetic stream registry lock failed".to_string())?
        .contains_key(symbol.as_str())
    {
        return Err(format!("unexpected synthetic stream for {symbol}"));
    }

    let initial_collection_deadline = Instant::now() + Duration::from_secs(20);
    let mut events = Vec::<DebugSmokeLiveCandleEvent>::new();

    while Instant::now() < initial_collection_deadline && events.len() < 2 {
        if let Ok(event) = rx.recv_timeout(Duration::from_secs(1)) {
            println!(
                "[smoke] initial event symbol={} timeframe={} time={} open={} high={} low={} close={}",
                event.symbol,
                event.timeframe,
                event.time,
                event.open,
                event.high,
                event.low,
                event.close
            );
            events.push(event);
        }
    }

    if events.is_empty() {
        return Err("expected at least one live event after subscribing".into());
    }

    let initial_latest_time = events.iter().map(|event| event.time).max().unwrap_or(0);
    let rollover_deadline = Instant::now()
        + Duration::from_secs(timeframe.duration() - (current_timestamp() % timeframe.duration()))
        + twelve_data_live_poll_interval()
        + Duration::from_secs(2);

    println!(
        "[smoke] waiting_for_rollover_until_unix={} initial_latest_time={}",
        current_timestamp()
            + rollover_deadline
                .saturating_duration_since(Instant::now())
                .as_secs(),
        initial_latest_time
    );

    while Instant::now() < rollover_deadline {
        if let Ok(event) = rx.recv_timeout(Duration::from_secs(1)) {
            println!(
                "[smoke] followup event symbol={} timeframe={} time={} open={} high={} low={} close={}",
                event.symbol,
                event.timeframe,
                event.time,
                event.open,
                event.high,
                event.low,
                event.close
            );
            events.push(event);
        }
    }

    let mut saw_revision = false;
    let mut last_by_time = HashMap::<u64, DebugSmokeLiveCandleEvent>::new();
    for event in &events {
        if let Some(previous) = last_by_time.get(&event.time) {
            if previous.open != event.open
                || previous.high != event.high
                || previous.low != event.low
                || previous.close != event.close
            {
                saw_revision = true;
            }
        }

        last_by_time.insert(event.time, event.clone());
    }

    let saw_rollover = events.iter().any(|event| event.time > initial_latest_time);
    println!(
        "[smoke] summary total_events={} saw_revision={} saw_rollover={}",
        events.len(),
        saw_revision,
        saw_rollover
    );

    unsubscribe_live(symbol.clone(), timeframe_str.clone())?;
    println!(
        "[smoke] unsubscribed symbol={} timeframe={}",
        symbol, timeframe_str
    );

    if is_twelve_data_poll_stream(&key) {
        return Err(
            "expected Twelve Data poll stream registry to be empty after unsubscribe".into(),
        );
    }
    if has_live_subscription(&key) {
        return Err("expected live subscription registry to be empty after unsubscribe".into());
    }

    let post_unsubscribe_event = rx.recv_timeout(Duration::from_secs(2)).ok();
    println!(
        "[smoke] post_unsubscribe_event_received={}",
        post_unsubscribe_event.is_some()
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::collections::HashMap;
    use std::sync::mpsc;
    use std::time::Instant;
    use tauri::Listener;

    #[derive(Debug, Clone, Deserialize)]
    struct TestLiveCandleEvent {
        symbol: String,
        timeframe: String,
        time: u64,
        open: f64,
        high: f64,
        low: f64,
        close: f64,
    }

    #[test]
    #[ignore = "requires Twelve Data API access and waits for realtime polling"]
    fn twelve_data_usdjpy_live_smoke() {
        let symbol = "usdjpy".to_string();
        let timeframe = Timeframe::M1;
        let timeframe_str = timeframe.as_str().to_string();
        let key = StreamKey {
            symbol: symbol.clone(),
            timeframe,
        };

        std::env::set_var("DATA_PROVIDER", "twelve_data");
        std::env::set_var("STRICT_REALTIME", "true");

        assert!(
            twelve_data_api_key().is_ok(),
            "TWELVE_DATA_API_KEY must be set to run this smoke test"
        );

        let app = tauri::test::mock_app();
        let event_name = format!("candle://{symbol}/{timeframe_str}");
        let (tx, rx) = mpsc::channel::<TestLiveCandleEvent>();
        let _listener = app.listen_any(event_name.clone(), move |event: tauri::Event| {
            let payload = serde_json::from_str::<TestLiveCandleEvent>(event.payload()).unwrap();
            tx.send(payload).unwrap();
        });

        println!(
            "[smoke] subscribing symbol={} timeframe={} strict_realtime={} poll_interval_ms={}",
            symbol,
            timeframe_str,
            strict_realtime_enabled(),
            twelve_data_live_poll_interval().as_millis()
        );
        subscribe_live_with_app(app.handle().clone(), symbol.clone(), timeframe_str.clone())
            .unwrap();

        assert!(
            is_twelve_data_poll_stream(&key),
            "expected Twelve Data poll stream registry to contain the active stream"
        );
        assert!(
            !SYNTHETIC_SYMBOL_STREAMS
                .lock()
                .unwrap()
                .contains_key(symbol.as_str()),
            "unexpected synthetic stream for {symbol}"
        );

        let initial_collection_deadline = Instant::now() + Duration::from_secs(20);
        let mut events = Vec::<TestLiveCandleEvent>::new();

        while Instant::now() < initial_collection_deadline && events.len() < 2 {
            if let Ok(event) = rx.recv_timeout(Duration::from_secs(1)) {
                println!(
                    "[smoke] initial event symbol={} timeframe={} time={} open={} high={} low={} close={}",
                    event.symbol,
                    event.timeframe,
                    event.time,
                    event.open,
                    event.high,
                    event.low,
                    event.close
                );
                events.push(event);
            }
        }

        assert!(
            !events.is_empty(),
            "expected at least one live event after subscribing"
        );

        let initial_latest_time = events.iter().map(|event| event.time).max().unwrap_or(0);
        let rollover_deadline = Instant::now()
            + Duration::from_secs(
                timeframe.duration() - (current_timestamp() % timeframe.duration()),
            )
            + twelve_data_live_poll_interval()
            + Duration::from_secs(2);

        println!(
            "[smoke] waiting_for_rollover_until_unix={} initial_latest_time={}",
            current_timestamp()
                + rollover_deadline
                    .saturating_duration_since(Instant::now())
                    .as_secs(),
            initial_latest_time
        );

        while Instant::now() < rollover_deadline {
            if let Ok(event) = rx.recv_timeout(Duration::from_secs(1)) {
                println!(
                    "[smoke] followup event symbol={} timeframe={} time={} open={} high={} low={} close={}",
                    event.symbol,
                    event.timeframe,
                    event.time,
                    event.open,
                    event.high,
                    event.low,
                    event.close
                );
                events.push(event);
            }
        }

        let mut saw_revision = false;
        let mut last_by_time = HashMap::<u64, TestLiveCandleEvent>::new();
        for event in &events {
            if let Some(previous) = last_by_time.get(&event.time) {
                if previous.open != event.open
                    || previous.high != event.high
                    || previous.low != event.low
                    || previous.close != event.close
                {
                    saw_revision = true;
                }
            }

            last_by_time.insert(event.time, event.clone());
        }

        let saw_rollover = events.iter().any(|event| event.time > initial_latest_time);
        println!(
            "[smoke] summary total_events={} saw_revision={} saw_rollover={}",
            events.len(),
            saw_revision,
            saw_rollover
        );

        unsubscribe_live(symbol.clone(), timeframe_str.clone()).unwrap();
        println!(
            "[smoke] unsubscribed symbol={} timeframe={}",
            symbol, timeframe_str
        );

        assert!(
            !is_twelve_data_poll_stream(&key),
            "expected Twelve Data poll stream registry to be empty after unsubscribe"
        );
        assert!(
            !has_live_subscription(&key),
            "expected live subscription registry to be empty after unsubscribe"
        );

        let post_unsubscribe_event = rx.recv_timeout(Duration::from_secs(2)).ok();
        println!(
            "[smoke] post_unsubscribe_event_received={}",
            post_unsubscribe_event.is_some()
        );
    }
}
