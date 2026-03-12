import {
  EMA,
  SMA,
  BollingerBands,
  RSI,
  MACD,
  Stochastic,
  ADX,
  CCI,
  WilliamsR,
  ATR,
  OBV,
  IchimokuCloud,
  AwesomeOscillator,
  StochasticRSI,
  WMA,
  PSAR,
  KeltnerChannels,
  ROC,
  KST,
  TRIX,
  MFI,
  ForceIndex,
  ADL,
} from "technicalindicators";
import type {
  OhlcvRow,
  IndicatorConfig,
  OverlayData,
  OscillatorData,
  VolumeData,
  CandlesWithIndicators,
} from "./types";
import { DEFAULT_INDICATOR_CONFIG } from "./types";

function padLeft(
  values: readonly number[],
  totalLength: number,
): readonly (number | null)[] {
  const padCount = totalLength - values.length;
  const pad: readonly (number | null)[] = Array.from<null>({
    length: Math.max(0, padCount),
  }).fill(null);
  return [...pad, ...values];
}

function computeVwap(candles: readonly OhlcvRow[]): readonly (number | null)[] {
  let cumTpVol = 0;
  let cumVol = 0;
  return candles.map((c) => {
    const tp = (c.high + c.low + c.close) / 3;
    cumTpVol += tp * c.volume;
    cumVol += c.volume;
    return cumVol > 0 ? cumTpVol / cumVol : null;
  });
}

export function computeOverlays(
  candles: readonly OhlcvRow[],
  config: IndicatorConfig = DEFAULT_INDICATOR_CONFIG,
): OverlayData {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const len = candles.length;

  const emaMap = new Map(
    config.ema.map((period) => [
      period,
      padLeft(EMA.calculate({ period, values: closes }), len),
    ]),
  );

  const smaMap = new Map(
    config.sma.map((period) => [
      period,
      padLeft(SMA.calculate({ period, values: closes }), len),
    ]),
  );

  // Hull Moving Average: WMA(2*WMA(n/2) - WMA(n), sqrt(n))
  const hmaPeriod = config.hmaPeriod;
  const hmaHalf = Math.floor(hmaPeriod / 2);
  const hmaSqrt = Math.round(Math.sqrt(hmaPeriod));
  const wmaHalf = WMA.calculate({ period: hmaHalf, values: closes });
  const wmaFull = WMA.calculate({ period: hmaPeriod, values: closes });
  const minLen = Math.min(wmaHalf.length, wmaFull.length);
  const hmaDiff: number[] = [];
  for (let i = 0; i < minLen; i++) {
    const hIdx = wmaHalf.length - minLen + i;
    const fIdx = wmaFull.length - minLen + i;
    hmaDiff.push(2 * wmaHalf[hIdx]! - wmaFull[fIdx]!);
  }
  const hmaRaw =
    hmaDiff.length >= hmaSqrt
      ? WMA.calculate({ period: hmaSqrt, values: hmaDiff })
      : [];

  // VWMA: SMA(close * volume, period) / SMA(volume, period)
  const vwmaPeriod = config.vwmaPeriod;
  const closeTimesVol = candles.map((c) => c.close * c.volume);
  const volumes = candles.map((c) => c.volume);
  const cvSma = SMA.calculate({ period: vwmaPeriod, values: closeTimesVol });
  const vSma = SMA.calculate({ period: vwmaPeriod, values: volumes });
  const vwmaRaw: number[] = [];
  for (let i = 0; i < cvSma.length; i++) {
    vwmaRaw.push(
      vSma[i]! > 0
        ? cvSma[i]! / vSma[i]!
        : closes[closes.length - cvSma.length + i]!,
    );
  }

  const bb = BollingerBands.calculate({
    period: config.bbPeriod,
    values: closes,
    stdDev: config.bbStdDev,
  });

  const ichimoku = IchimokuCloud.calculate({
    high: highs,
    low: lows,
    conversionPeriod: 9,
    basePeriod: 26,
    spanPeriod: 52,
    displacement: 26,
  });

  // SuperTrend (custom: ATR-based trend indicator)
  const stPeriod = config.superTrendPeriod;
  const stMult = config.superTrendMultiplier;
  const stAtr = ATR.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: stPeriod,
  });
  const stOffset = len - stAtr.length;
  const superTrendRaw: number[] = [];
  if (stAtr.length > 0) {
    let prevFinalUpper = Infinity;
    let prevFinalLower = -Infinity;
    let prevSt = 0;
    for (let i = 0; i < stAtr.length; i++) {
      const idx = i + stOffset;
      const hl2 = (highs[idx]! + lows[idx]!) / 2;
      const basicUpper = hl2 + stMult * stAtr[i]!;
      const basicLower = hl2 - stMult * stAtr[i]!;
      const prevClose = idx > 0 ? closes[idx - 1]! : closes[idx]!;
      const finalUpper =
        basicUpper < prevFinalUpper || prevClose > prevFinalUpper
          ? basicUpper
          : prevFinalUpper;
      const finalLower =
        basicLower > prevFinalLower || prevClose < prevFinalLower
          ? basicLower
          : prevFinalLower;
      let st: number;
      if (i === 0) {
        st = closes[idx]! > finalUpper ? finalLower : finalUpper;
      } else if (prevSt === prevFinalUpper) {
        st = closes[idx]! <= finalUpper ? finalUpper : finalLower;
      } else {
        st = closes[idx]! >= finalLower ? finalLower : finalUpper;
      }
      prevFinalUpper = finalUpper;
      prevFinalLower = finalLower;
      prevSt = st;
      superTrendRaw.push(st);
    }
  }

  // Parabolic SAR
  const psarRaw = PSAR.calculate({
    high: highs,
    low: lows,
    step: config.psarStep,
    max: config.psarMax,
  });

  // Keltner Channels
  const keltner = KeltnerChannels.calculate({
    high: highs,
    low: lows,
    close: closes,
    maPeriod: config.keltnerMaPeriod,
    atrPeriod: config.keltnerAtrPeriod,
    useSMA: false,
    multiplier: config.keltnerMultiplier,
  });

  const empty = padLeft([], len);

  return {
    ema9: emaMap.get(9) ?? empty,
    ema10: emaMap.get(10) ?? empty,
    ema21: emaMap.get(21) ?? empty,
    ema30: emaMap.get(30) ?? empty,
    ema50: emaMap.get(50) ?? empty,
    ema100: emaMap.get(100) ?? empty,
    ema200: emaMap.get(200) ?? empty,
    sma10: smaMap.get(10) ?? empty,
    sma20: smaMap.get(20) ?? empty,
    sma30: smaMap.get(30) ?? empty,
    sma50: smaMap.get(50) ?? empty,
    sma100: smaMap.get(100) ?? empty,
    sma200: smaMap.get(200) ?? empty,
    bbUpper: padLeft(
      bb.map((b) => b.upper),
      len,
    ),
    bbMiddle: padLeft(
      bb.map((b) => b.middle),
      len,
    ),
    bbLower: padLeft(
      bb.map((b) => b.lower),
      len,
    ),
    vwap: computeVwap(candles),
    hma9: padLeft(hmaRaw, len),
    vwma20: padLeft(vwmaRaw, len),
    superTrend: padLeft(superTrendRaw, len),
    psar: padLeft(psarRaw, len),
    keltnerUpper: padLeft(
      keltner.map((k) => k.upper),
      len,
    ),
    keltnerMiddle: padLeft(
      keltner.map((k) => k.middle),
      len,
    ),
    keltnerLower: padLeft(
      keltner.map((k) => k.lower),
      len,
    ),
    ichimokuConversion: padLeft(
      ichimoku.map((i) => i.conversion),
      len,
    ),
    ichimokuBase: padLeft(
      ichimoku.map((i) => i.base),
      len,
    ),
    ichimokuSpanA: padLeft(
      ichimoku.map((i) => i.spanA),
      len,
    ),
    ichimokuSpanB: padLeft(
      ichimoku.map((i) => i.spanB),
      len,
    ),
  };
}

export function computeOscillators(
  candles: readonly OhlcvRow[],
  config: IndicatorConfig = DEFAULT_INDICATOR_CONFIG,
): OscillatorData {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const len = candles.length;

  const rsi = RSI.calculate({ period: config.rsiPeriod, values: closes });

  const macd = MACD.calculate({
    fastPeriod: config.macdFast,
    slowPeriod: config.macdSlow,
    signalPeriod: config.macdSignal,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
    values: closes,
  });

  const stoch = Stochastic.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: config.stochPeriod,
    signalPeriod: config.stochSignal,
  });

  const adx = ADX.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: config.adxPeriod,
  });

  const cci = CCI.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: config.cciPeriod,
  });

  const williamsR = WilliamsR.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: config.williamsRPeriod,
  });

  const atr = ATR.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: config.atrPeriod,
  });

  // Awesome Oscillator
  const ao = AwesomeOscillator.calculate({
    high: highs,
    low: lows,
    fastPeriod: 5,
    slowPeriod: 34,
  });

  // Momentum: close[i] - close[i - period]
  const momPeriod = config.momentumPeriod;
  const momentumRaw: number[] = [];
  for (let i = momPeriod; i < closes.length; i++) {
    momentumRaw.push(closes[i]! - closes[i - momPeriod]!);
  }

  // Stochastic RSI
  const stochRsi = StochasticRSI.calculate({
    values: closes,
    rsiPeriod: config.stochRsiPeriod,
    stochasticPeriod: config.stochRsiStochPeriod,
    kPeriod: config.stochRsiKPeriod,
    dPeriod: config.stochRsiDPeriod,
  });

  // Bull Bear Power: (high - EMA(13)) + (low - EMA(13))
  const bbpEma = EMA.calculate({
    period: config.bullBearPeriod,
    values: closes,
  });
  const bbpRaw: number[] = [];
  const bbpOffset = closes.length - bbpEma.length;
  for (let i = 0; i < bbpEma.length; i++) {
    const h = highs[i + bbpOffset]!;
    const l = lows[i + bbpOffset]!;
    const e = bbpEma[i]!;
    bbpRaw.push(h - e + (l - e));
  }

  // Ultimate Oscillator
  const p1 = config.ultimateOscPeriod1;
  const p2 = config.ultimateOscPeriod2;
  const p3 = config.ultimateOscPeriod3;
  const uoRaw: number[] = [];
  if (closes.length > p3) {
    const bp: number[] = [0];
    const tr: number[] = [0];
    for (let i = 1; i < closes.length; i++) {
      const minLowPc = Math.min(lows[i]!, closes[i - 1]!);
      const maxHighPc = Math.max(highs[i]!, closes[i - 1]!);
      bp.push(closes[i]! - minLowPc);
      tr.push(maxHighPc - minLowPc);
    }
    for (let i = p3; i < closes.length; i++) {
      let bpSum1 = 0,
        trSum1 = 0;
      let bpSum2 = 0,
        trSum2 = 0;
      let bpSum3 = 0,
        trSum3 = 0;
      for (let j = i - p1 + 1; j <= i; j++) {
        bpSum1 += bp[j]!;
        trSum1 += tr[j]!;
      }
      for (let j = i - p2 + 1; j <= i; j++) {
        bpSum2 += bp[j]!;
        trSum2 += tr[j]!;
      }
      for (let j = i - p3 + 1; j <= i; j++) {
        bpSum3 += bp[j]!;
        trSum3 += tr[j]!;
      }
      const avg1 = trSum1 > 0 ? bpSum1 / trSum1 : 0;
      const avg2 = trSum2 > 0 ? bpSum2 / trSum2 : 0;
      const avg3 = trSum3 > 0 ? bpSum3 / trSum3 : 0;
      uoRaw.push((100 * (4 * avg1 + 2 * avg2 + avg3)) / 7);
    }
  }

  // Rate of Change
  const rocResult = ROC.calculate({
    period: config.rocPeriod,
    values: closes,
  });

  // Know Sure Thing
  const kstResult = KST.calculate({
    values: closes,
    ROCPer1: config.kstRocPer1,
    ROCPer2: config.kstRocPer2,
    ROCPer3: config.kstRocPer3,
    ROCPer4: config.kstRocPer4,
    SMAROCPer1: config.kstSmaPer1,
    SMAROCPer2: config.kstSmaPer2,
    SMAROCPer3: config.kstSmaPer3,
    SMAROCPer4: config.kstSmaPer4,
    signalPeriod: config.kstSignalPeriod,
  });

  // TRIX
  const trixResult = TRIX.calculate({
    period: config.trixPeriod,
    values: closes,
  });

  // Money Flow Index
  const mfiResult = MFI.calculate({
    high: highs,
    low: lows,
    close: closes,
    volume: candles.map((c) => c.volume),
    period: config.mfiPeriod,
  });

  // Force Index
  const fiResult = ForceIndex.calculate({
    close: closes,
    volume: candles.map((c) => c.volume),
    period: config.forceIndexPeriod,
  });

  return {
    rsi: padLeft(rsi, len),
    macdLine: padLeft(
      macd.map((m) => m.MACD ?? 0),
      len,
    ),
    macdSignal: padLeft(
      macd.map((m) => m.signal ?? 0),
      len,
    ),
    macdHistogram: padLeft(
      macd.map((m) => m.histogram ?? 0),
      len,
    ),
    stochK: padLeft(
      stoch.map((s) => s.k),
      len,
    ),
    stochD: padLeft(
      stoch.map((s) => s.d),
      len,
    ),
    adx: padLeft(
      adx.map((a) => a.adx),
      len,
    ),
    cci: padLeft(cci, len),
    williamsR: padLeft(williamsR, len),
    atr: padLeft(atr, len),
    awesomeOsc: padLeft(ao, len),
    momentum: padLeft(momentumRaw, len),
    stochRsiK: padLeft(
      stochRsi.map((s) => s.k),
      len,
    ),
    stochRsiD: padLeft(
      stochRsi.map((s) => s.d),
      len,
    ),
    bullBearPower: padLeft(bbpRaw, len),
    ultimateOsc: padLeft(uoRaw, len),
    roc: padLeft(rocResult, len),
    kstLine: padLeft(
      kstResult.map((k) => k.kst),
      len,
    ),
    kstSignal: padLeft(
      kstResult.map((k) => k.signal),
      len,
    ),
    trix: padLeft(trixResult, len),
    mfi: padLeft(mfiResult, len),
    forceIndex: padLeft(fiResult, len),
  };
}

export function computeVolumeIndicators(
  candles: readonly OhlcvRow[],
  config: IndicatorConfig = DEFAULT_INDICATOR_CONFIG,
): VolumeData {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const len = candles.length;

  const obv = OBV.calculate({ close: closes, volume: volumes });
  const volumeMa = SMA.calculate({
    period: config.volumeMaPeriod,
    values: volumes,
  });
  const adlResult = ADL.calculate({
    high: highs,
    low: lows,
    close: closes,
    volume: volumes,
  });

  return {
    obv: padLeft(obv, len),
    volumeMa: padLeft(volumeMa, len),
    adl: padLeft(adlResult, len),
  };
}

export function computeAllIndicators(
  candles: readonly OhlcvRow[],
  config: IndicatorConfig = DEFAULT_INDICATOR_CONFIG,
): CandlesWithIndicators {
  return {
    candles,
    overlays: computeOverlays(candles, config),
    oscillators: computeOscillators(candles, config),
    volume: computeVolumeIndicators(candles, config),
  };
}
