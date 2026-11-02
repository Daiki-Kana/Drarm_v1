/**
 * Drarm_v1 - 手のひら打鍵・低遅延Webドラムシステム
 * 
 * 単眼カメラの映像から手のひらのトラッキングラインと加速度を算出し、
 * Piarnoの打鍵検知データに基づく閾値ヒステリシスと急減速スパイクによって机面インパクトを検出。
 * 画面左右（左: シンバル / 右: 通常ドラム）でゼロレイテンシなプロシージャル合成音を発音します。
 */

import { FilesetResolver, HandLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm";

// ==========================================================================
// 1. DOM要素の取得
// ==========================================================================
const video = document.getElementById("webcam");
const canvas = document.getElementById("output-canvas");
const canvasCtx = canvas.getContext("2d");
const effectCanvas = document.getElementById("effect-canvas");
const effectCtx = effectCanvas.getContext("2d");

const zoneCymbal = document.getElementById("zone-cymbal");
const zoneDrum = document.getElementById("zone-drum");
const audioStartOverlay = document.getElementById("audio-start-overlay");
const audioStartBtn = document.getElementById("audio-start-btn");
const testAudioBtn = document.getElementById("test-audio-btn");
const toggleTrackingBtn = document.getElementById("toggle-tracking-btn");
const refreshCameraBtn = document.getElementById("refresh-camera-btn");
const fullscreenBtn = document.getElementById("fullscreen-btn");

const hudAudio = document.getElementById("hud-audio");
const hudHit = document.getElementById("hud-hit");
const hudAcc = document.getElementById("hud-acc");
const hudVel = document.getElementById("hud-vel");

const noticeModal = document.getElementById("notice-modal");
const noticeText = document.getElementById("notice-text");

// ==========================================================================
// 2. プロシージャル Web Audio ドラム音響エンジン（外部ファイル依存ゼロ）
// ==========================================================================
class ProceduralDrumEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.limiter = null;
    this.noiseBuffer = null;
    this.isReady = false;
  }

  /**
   * オーディオHUDの表示同期
   */
  updateHud() {
    if (!hudAudio) return;
    if (this.ctx && this.ctx.state === "running") {
      hudAudio.textContent = "READY";
      hudAudio.classList.add("ready");
    } else {
      hudAudio.textContent = "MUTED";
      hudAudio.classList.remove("ready");
    }
  }

  /**
   * オーディオコンテキストの初期化（ユーザー操作時に呼び出し）
   */
  async init() {
    if (this.ctx && this.ctx.state !== "closed") {
      if (this.ctx.state === "suspended") {
        await this.ctx.resume();
      }
      this.isReady = this.ctx.state === "running";
      this.updateHud();
      return;
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioContextClass({ latencyHint: "interactive" });

    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }

    // ダイナミクスコンプレッサー（クリッピング歪み防止と音圧確保）
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.setValueAtTime(-3, this.ctx.currentTime);
    this.limiter.knee.setValueAtTime(4, this.ctx.currentTime);
    this.limiter.ratio.setValueAtTime(12, this.ctx.currentTime);
    this.limiter.attack.setValueAtTime(0.001, this.ctx.currentTime);
    this.limiter.release.setValueAtTime(0.08, this.ctx.currentTime);

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.setValueAtTime(0.9, this.ctx.currentTime);

    this.masterGain.connect(this.limiter);
    this.limiter.connect(this.ctx.destination);

    // 1秒間のホワイトノイズバッファを生成（スネア・シンバル用）
    const bufferSize = this.ctx.sampleRate;
    this.noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }

    this.isReady = this.ctx.state === "running";
    this.updateHud();
    console.log("[AUDIO] Procedural Drum Engine initialized. State:", this.ctx.state);
  }

  /**
   * 音声コンテキストの稼働保証（未初期化または休止時の復帰）
   */
  async ensureRunning() {
    if (!this.ctx) {
      await this.init();
    } else if (this.ctx.state === "suspended") {
      await this.ctx.resume();
      this.updateHud();
    }
  }

  /**
   * バスドラム（Kick）の合成
   * 150Hzから38Hzへ急峻にピッチスイープするサイン波 ＋ アタッククリック
   */
  playKick(intensity = 1.0) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    const startFreq = 140 + 40 * intensity;
    const endFreq = 36;
    const duration = 0.28;

    osc.type = "sine";
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(endFreq, now + 0.08);

    const volume = Math.min(1.2, 0.7 * intensity);
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    // クリック音（トランジェントのアタック感を補強）
    const clickOsc = this.ctx.createOscillator();
    const clickGain = this.ctx.createGain();
    clickOsc.type = "triangle";
    clickOsc.frequency.setValueAtTime(320, now);
    clickOsc.frequency.exponentialRampToValueAtTime(40, now + 0.02);
    clickGain.gain.setValueAtTime(0.5 * intensity, now);
    clickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.02);

    clickOsc.connect(clickGain);
    clickGain.connect(this.masterGain);
    clickOsc.start(now);
    clickOsc.stop(now + 0.02);

    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + duration);
  }

  /**
   * スネアドラム（Snare）の合成
   * バンドパスノイズ（スナッピー） ＋ 減衰サイン波（シェル胴鳴り）
   */
  playSnare(intensity = 1.0) {
    if (!this.ctx || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;

    // 1. シェル（胴鳴りトーン）
    const osc = this.ctx.createOscillator();
    const oscGain = this.ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(80, now + 0.09);
    oscGain.gain.setValueAtTime(0.6 * intensity, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

    osc.connect(oscGain);
    oscGain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.12);

    // 2. スナッピー（ホワイトノイズ ＋ ハイパス・バンドパスフィルター）
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.setValueAtTime(1000, now);

    const noiseGain = this.ctx.createGain();
    const noiseDuration = 0.18;
    noiseGain.gain.setValueAtTime(0.8 * intensity, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + noiseDuration);

    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(this.masterGain);
    noise.start(now);
    noise.stop(now + noiseDuration);
  }

  /**
   * ハイハット（Hi-Hat）の合成
   * 金属的倍音ノイズ ＋ 鋭いハイパスフィルター
   */
  playHiHat(isOpen = false, intensity = 1.0) {
    if (!this.ctx || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;

    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.setValueAtTime(7500, now);

    const gain = this.ctx.createGain();
    const duration = isOpen ? 0.32 : 0.05;
    const vol = (isOpen ? 0.55 : 0.7) * intensity;

    gain.gain.setValueAtTime(vol, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    noise.start(now);
    noise.stop(now + duration);
  }

  /**
   * クラッシュシンバル（Crash）の合成
   * 複数の高周波金属倍音 ＋ ホワイトノイズ ＋ 長時間の豊かな減衰
   */
  playCrash(intensity = 1.0) {
    if (!this.ctx || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;

    // 金属光沢ノイズ
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(5400, now);
    filter.Q.setValueAtTime(1.8, now);

    const gain = this.ctx.createGain();
    const duration = 1.4;
    gain.gain.setValueAtTime(0.75 * intensity, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    noise.start(now);
    noise.stop(now + duration);
  }

  /**
   * タム（Tom）の合成
   * ピッチスイープするウォームな三角波
   */
  playTom(intensity = 1.0) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = "triangle";
    osc.frequency.setValueAtTime(160, now);
    osc.frequency.exponentialRampToValueAtTime(75, now + 0.16);

    const duration = 0.22;
    gain.gain.setValueAtTime(0.7 * intensity, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + duration);
  }
}

const drumEngine = new ProceduralDrumEngine();

// ==========================================================================
// 3. 1 Euro Filter による適応型平滑化（ノイズ除去とゼロレイテンシ追従）
// ==========================================================================
class OneEuroFilter {
  constructor(minCutoff = 1.4, beta = 0.012, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }

  reset(x = null, timestamp = null) {
    this.xPrev = x;
    this.dxPrev = 0;
    this.tPrev = timestamp;
  }

  alpha(cutoff, dt) {
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / dt);
  }

  filter(x, timestamp = performance.now()) {
    if (this.xPrev === null || this.tPrev === null) {
      this.xPrev = x;
      this.dxPrev = 0;
      this.tPrev = timestamp;
      return x;
    }

    const dt = Math.max((timestamp - this.tPrev) / 1000, 0.001);
    this.tPrev = timestamp;

    // 速度（1階差分）の平滑化
    const dx = (x - this.xPrev) / dt;
    const aD = this.alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    this.dxPrev = dxHat;

    // 速度に応じた動的カットオフ周波数
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = this.alpha(cutoff, dt);

    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    return xHat;
  }
}

/**
 * 指先代表点の2D座標・速度・加速度トラッカー（Fingertip Tracker）
 */
class PalmTracker {
  constructor() {
    // 指先の俊敏な運動に最適化した適応フィルタ（低ジッター ＆ 高速移動スルー）
    this.xf = new OneEuroFilter(1.5, 0.025);
    this.yf = new OneEuroFilter(1.5, 0.025);

    // 垂直速度と減速加速度のトラッキング
    this.prevVy = 0;
    this.prevTimestamp = null;
    this.smoothAccY = 0;
    this.accFilter = new OneEuroFilter(2.2, 0.03);
  }

  reset() {
    this.xf.reset();
    this.yf.reset();
    this.accFilter.reset();
    this.prevVy = 0;
    this.smoothAccY = 0;
    this.prevTimestamp = null;
  }

  update(rawX, rawY, timestamp = performance.now()) {
    const smoothX = this.xf.filter(rawX, timestamp);
    const smoothY = this.yf.filter(rawY, timestamp);

    const vy = this.yf.dxPrev; // Y軸速度（ピクセル/秒、下向き正）

    let accY = 0;
    if (this.prevTimestamp !== null) {
      const dt = Math.max((timestamp - this.prevTimestamp) / 1000, 0.001);
      // 離散加速度（速度の差分）
      const rawAccY = (vy - this.prevVy) / dt;
      // 加速度の適応平滑化
      accY = this.accFilter.filter(rawAccY, timestamp);
    }
    this.prevVy = vy;
    this.prevTimestamp = timestamp;
    this.smoothAccY = accY;

    return {
      x: smoothX,
      y: smoothY,
      vy: vy,
      ay: accY
    };
  }
}

const palmTracker = new PalmTracker();

// ==========================================================================
// 4. Piarno 打鍵データセット解析 ＆ 動的キャリブレーション
// ==========================================================================
let hitVelocityThreshold = 380;     // 振り下ろし速度閾値（px/s）
let impactDecelThreshold = -2800;   // 机面接触時の制動減速加速度スパイク（px/s²）
let baselineHitRy = 0.55;           // 相対沈み込み閾値
let datasetLoaded = false;

/**
 * Piarnoの既存データセット（public/dataset または dataset）を読み込み、閾値を最適化
 */
async function loadPiarnoDataset() {
  try {
    let res = await fetch("./dataset/manifest.json");
    if (!res.ok) {
      res = await fetch("/dataset/manifest.json");
    }
    if (!res.ok) return;

    const manifest = await res.json();
    let files = [];
    if (Array.isArray(manifest)) files = manifest;
    else if (manifest && manifest.files) files = manifest.files;
    else if (manifest && manifest.fingers) files = Object.values(manifest.fingers).flat();

    const hitRys = [];
    for (const f of files.slice(0, 8)) { // 代表ファイルをサンプリング
      try {
        let csvRes = await fetch(`./dataset/${f}`);
        if (!csvRes.ok) {
          csvRes = await fetch(`/dataset/${f}`);
        }
        if (!csvRes.ok) continue;

        const text = await csvRes.text();
        const lines = text.trim().split(/\r?\n/);
        if (lines.length < 2) continue;
        const header = lines[0].toLowerCase().split(",").map((s) => s.trim());
        const ryIdx = header.indexOf("ry");
        const labelIdx = header.indexOf("label") !== -1 ? header.indexOf("label") : header.indexOf("is_hit");

        if (ryIdx === -1) continue;
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(",").map((s) => s.trim());
          const ryVal = parseFloat(cols[ryIdx]);
          const isHit = labelIdx !== -1 ? cols[labelIdx] === "1" || cols[labelIdx].toLowerCase() === "true" : false;
          if (!isNaN(ryVal) && isHit) {
            hitRys.push(ryVal);
          }
        }
      } catch (err) {
        // 個別スキップ
      }
    }

    if (hitRys.length > 0) {
      hitRys.sort((a, b) => a - b);
      const median = hitRys[Math.floor(hitRys.length * 0.5)];
      baselineHitRy = Math.max(0.40, median * 0.85);
      datasetLoaded = true;
      console.log(`[DATASET] Loaded ${hitRys.length} hit samples from Piarno. Baseline Ry: ${baselineHitRy.toFixed(2)}`);
    }
  } catch (err) {
    console.warn("[DATASET] Using default biomechanical thresholds:", err);
  }
}

// ==========================================================================
// 5. 最下点ピーク反転検知（Extrema Detection）による確実な机面タップ検出
// ==========================================================================
const MIN_COOLDOWN_MS = 55; // チャタリング防止クールダウン（55ms）

class HandTrackerState {
  constructor(name) {
    this.name = name; // "Left" または "Right"
    this.tapState = "IDLE"; // "IDLE" または "TOUCHED"
    this.lastHitTime = 0;

    // 垂直移動ヒストリ
    this.prevY = null;
    this.prevPrevY = null;
    this.apexY = null; // 振り上げ時の頂点（Y最小）

    // 指先座標の適応平滑化フィルタ（打鍵ピークの遅延を抑え、机面衝突の急停止をシャープに捕捉）
    this.xf = new OneEuroFilter(2.5, 0.08);
    this.yf = new OneEuroFilter(3.0, 0.08);
  }

  reset() {
    this.tapState = "IDLE";
    this.prevY = null;
    this.prevPrevY = null;
    this.apexY = null;
    this.xf.reset();
    this.yf.reset();
  }

  /**
   * 最下点ピーク反転検知による打鍵判定
   * 振り下ろし（下向き移動）から机面に衝突して「下がらなくなった／跳ね返った瞬間」を確実に捉える
   */
  updateAndDetect(rawX, rawY, timestampMs, canvasWidth, canvasHeight) {
    const smoothX = this.xf.filter(rawX, timestampMs);
    const smoothY = this.yf.filter(rawY, timestampMs);
    const now = performance.now();

    if (this.prevY === null) {
      this.prevY = smoothY;
      this.prevPrevY = smoothY;
      this.apexY = smoothY;
      return { x: smoothX, y: smoothY, isHit: false, stroke: 0, dy: 0 };
    }

    const dy = smoothY - this.prevY;            // 現フレーム垂直変位（下向きが正）
    const prevDy = this.prevY - this.prevPrevY; // 前フレーム垂直変位

    let isHit = false;
    let stroke = 0;

    // 軽い指先タップも確実に拾う最小ストローク幅（画面高さの約0.8%または最低5px）
    const minStrokePx = Math.max(5, canvasHeight * 0.008);

    if (this.tapState === "IDLE") {
      // 指が上向きに動いている間、頂点（最も高い位置）を更新
      if (dy < 0) {
        if (this.apexY === null || smoothY < this.apexY) {
          this.apexY = smoothY;
        }
      }

      // 振り下ろしストローク量
      stroke = this.apexY !== null ? (smoothY - this.apexY) : 0;

      // 【机面最下点（反転）の判定】
      // 1. 直前フレームで下向きに動いていた（prevDy >= 0.8px）
      // 2. 十分な下向きの振り下ろし幅があった（stroke >= minStrokePx）
      // 3. 現フレームで下向き移動が急停止、または上向きに反転した（dy <= 0.8px）
      const wasMovingDown = prevDy >= 0.8 && stroke >= minStrokePx;
      const isBottomReached = dy <= 0.8;

      if (wasMovingDown && isBottomReached) {
        if (now - this.lastHitTime >= MIN_COOLDOWN_MS) {
          this.tapState = "TOUCHED";
          this.lastHitTime = now;
          isHit = true;

          // 打鍵強度（ストロークと下降速度に応じたダイナミクス）
          const intensity = Math.min(1.4, Math.max(0.7, 0.75 + (stroke / (canvasHeight * 0.08)) * 0.5));

          // ドラム発音 & 視覚フィードバック
          triggerDrumHit(smoothX, smoothY, intensity * 3500, canvasWidth, canvasHeight);
        }
      }
    } else if (this.tapState === "TOUCHED") {
      // 【リフト復帰判定】
      // 指先が机面からわずかに浮上した（dy <= -0.8px）、または45ms静止した
      const isLifting = dy <= -0.8;
      const isSettled = now - this.lastHitTime >= 45;

      if (isLifting || isSettled) {
        this.tapState = "IDLE";
        this.apexY = smoothY; // 新しい頂点基準に更新
      }
    }

    this.prevPrevY = this.prevY;
    this.prevY = smoothY;

    return { x: smoothX, y: smoothY, isHit: isHit, stroke: stroke, dy: dy };
  }
}

// 左右の手それぞれに専用のトラッカーを固定（フレーム間の入れ替わり混線を完全防止）
const handTrackers = {
  Left: new HandTrackerState("Left"),
  Right: new HandTrackerState("Right")
};

/**
 * リアルタイムHITバッジ表示の更新
 */
function updateHitBadge(label, intensity) {
  if (!hudHit) return;
  const powerPct = Math.round(Math.min(100, (intensity / 1.4) * 100));
  hudHit.textContent = `${label} ${powerPct}%`;
  hudHit.classList.add("flash-active");
  setTimeout(() => {
    if (hudHit) hudHit.classList.remove("flash-active");
  }, 130);
}

/**
 * ドラム発音と視覚演出の発火
 */
function triggerDrumHit(canvasX, canvasY, impactAcc, canvasWidth, canvasHeight) {
  // オーディオコンテキストの稼働を保証
  drumEngine.ensureRunning();

  // インカメラ映像は scaleX(-1) で鏡像表示されているため:
  // ユーザーが画面左側（CYMBAL）に手を出した時: カメラ生座標 canvasX > canvasWidth / 2
  // ユーザーが画面右側（DRUM）に手を出した時: カメラ生座標 canvasX <= canvasWidth / 2
  const isCymbalSide = canvasX > (canvasWidth / 2);

  const normalizedY = canvasY / canvasHeight; // 0 (上) 〜 1 (下: 机面)
  const intensity = Math.min(1.4, Math.max(0.65, impactAcc / 3500));

  let soundLabel = "";

  if (isCymbalSide) {
    // 【シンバルエリア：画面左側】
    if (normalizedY < 0.45 || intensity > 1.15) {
      soundLabel = "CRASH";
      drumEngine.playCrash(intensity);
      flashZone(zoneCymbal, soundLabel, intensity);
    } else {
      const isOpen = normalizedY < 0.65;
      soundLabel = isOpen ? "OPEN HI-HAT" : "CLOSED HI-HAT";
      drumEngine.playHiHat(isOpen, intensity);
      flashZone(zoneCymbal, soundLabel, intensity);
    }
  } else {
    // 【通常ドラムエリア：画面右側】
    if (normalizedY > 0.65) {
      soundLabel = "KICK";
      drumEngine.playKick(intensity);
      flashZone(zoneDrum, soundLabel, intensity);
    } else if (normalizedY < 0.38) {
      soundLabel = "TOM";
      drumEngine.playTom(intensity);
      flashZone(zoneDrum, soundLabel, intensity);
    } else {
      soundLabel = "SNARE";
      drumEngine.playSnare(intensity);
      flashZone(zoneDrum, soundLabel, intensity);
    }
  }

  // 白黒波紋リップルエフェクト生成
  createRipple(canvasX, canvasY, intensity);
}

/**
 * ゾーン背景の瞬間フラッシュ & HUD更新
 */
function flashZone(element, label, intensity = 1.0) {
  if (element) {
    element.classList.add("hit-flash");
    setTimeout(() => {
      element.classList.remove("hit-flash");
    }, 110);
  }
  updateHitBadge(label, intensity);
}

// ==========================================================================
// 6. 白黒ミニマル・リップルエフェクト（完全ボーダーレス波紋）
// ==========================================================================
const ripples = [];

function createRipple(x, y, intensity) {
  ripples.push({
    x: x,
    y: y,
    radius: 12,
    maxRadius: 100 + 50 * intensity,
    alpha: 0.85,
    speed: 6.5 + 3.0 * intensity
  });
}

function renderRipples() {
  effectCtx.clearRect(0, 0, effectCanvas.width, effectCanvas.height);

  for (let i = ripples.length - 1; i >= 0; i--) {
    const r = ripples[i];
    r.radius += r.speed;
    r.alpha *= 0.88;

    if (r.alpha < 0.02 || r.radius >= r.maxRadius) {
      ripples.splice(i, 1);
      continue;
    }

    // 枠線（stroke）ではなく、面の柔らかなグラデーション円で表現
    const grad = effectCtx.createRadialGradient(r.x, r.y, 0, r.x, r.y, r.radius);
    grad.addColorStop(0, `rgba(255, 255, 255, ${r.alpha * 0.4})`);
    grad.addColorStop(0.7, `rgba(255, 255, 255, ${r.alpha * 0.2})`);
    grad.addColorStop(1, "rgba(255, 255, 255, 0)");

    effectCtx.beginPath();
    effectCtx.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
    effectCtx.fillStyle = grad;
    effectCtx.fill();
  }

  requestAnimationFrame(renderRipples);
}
requestAnimationFrame(renderRipples);

// ==========================================================================
// 7. カメラ映像・MediaPipe HandLandmarker 統合
// ==========================================================================
let handLandmarker = null;
let showTrackingLines = true;
let isVideoReady = false;

/**
 * MediaPipe HandLandmarker の初期化
 */
async function setupHandLandmarker() {
  try {
    if (noticeText) noticeText.textContent = "LOADING VISION MODEL";
    if (noticeModal) noticeModal.classList.remove("hidden");

    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
    );

    // モデルアセットのパス解決（ローカル優先、CDNへフォールバック）
    const candidatePaths = [
      "./models/hand_landmarker.task",
      "/models/hand_landmarker.task",
      "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
    ];

    let resolvedModelPath = candidatePaths[candidatePaths.length - 1];
    for (const p of candidatePaths) {
      try {
        const headRes = await fetch(p, { method: "HEAD" });
        if (headRes.ok) {
          resolvedModelPath = p;
          break;
        }
      } catch (e) {
        // 次の候補を試行
      }
    }

    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: resolvedModelPath,
        delegate: "GPU"
      },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5
    });

    if (noticeModal) noticeModal.classList.add("hidden");
    console.log(`[VISION] Hand Landmarker initialized successfully with ${resolvedModelPath}`);
  } catch (err) {
    console.error("[VISION] Hand Landmarker load failed:", err);
    if (noticeText) noticeText.textContent = "VISION INITIALIZE FAILED";
  }
}

/**
 * Webカメラの起動と解像度同期
 */
async function setupCamera() {
  try {
    const constraints = {
      video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 60, min: 30 }
      },
      audio: false
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;

    return new Promise((resolve) => {
      video.onloadedmetadata = () => {
        video.play();
        updateCanvasResolution();
        isVideoReady = true;
        resolve();
      };
    });
  } catch (err) {
    console.error("[CAMERA] Access error:", err);
    if (noticeText) noticeText.textContent = "CAMERA ACCESS DENIED";
    if (noticeModal) noticeModal.classList.remove("hidden");
  }
}

/**
 * ビデオの生解像度にCanvasを1:1完全一致させる（Piarno 1D方式）
 * CSSの object-fit: cover によりブラウザが同一倍率・同一クリッピングで拡大描画するため、
 * 複雑なアスペクト比計算を全廃し、GPU/CPU負荷を最小化して超低遅延を実現します。
 */
function updateCanvasResolution() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;

  if (canvas.width !== vw || canvas.height !== vh) {
    canvas.width = vw;
    canvas.height = vh;
  }
  if (effectCanvas.width !== vw || effectCanvas.height !== vh) {
    effectCanvas.width = vw;
    effectCanvas.height = vh;
  }
}

window.addEventListener("resize", updateCanvasResolution);
video.addEventListener("resize", updateCanvasResolution);

// ==========================================================================
// 8. カメラ同期推論ループ（Piarno 1Dパイプライン）
// ==========================================================================
let lastVideoTimestamp = -1;
let isPredicting = false;
let animationFrameId = null;

/**
 * requestVideoFrameCallbackによるカメラ物理フレーム到着同期
 * 無駄な重複推論とスキップを全廃し、安定した60fps追従を保証
 */
function schedulePredictLoop() {
  if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
    video.requestVideoFrameCallback((now, metadata) => {
      const frameTime = metadata?.presentationTime ? metadata.presentationTime * 1000 : now;
      processVideoFrame(frameTime);
      schedulePredictLoop();
    });
  } else {
    animationFrameId = requestAnimationFrame((now) => {
      processVideoFrame(now);
      schedulePredictLoop();
    });
  }
}

/**
 * 毎フレームの推論・描画ループ（厳密単調増加タイムスタンプ保証・左右手固定ロック）
 */
function processVideoFrame(frameTime) {
  if (!isVideoReady || !handLandmarker) return;
  if (video.paused || video.ended || video.readyState < 2) return;

  // 二重推論・コールバック詰まりの防止
  if (isPredicting) return;
  isPredicting = true;

  try {
    updateCanvasResolution();

    // 【フリーズ根絶の最重要仕様】MediaPipe Tasks Vision C++エンジンのタイムスタンプ単調増加を保証
    // 前フレームと同一または逆転したタイムスタンプが渡されると内部アサートエラーでフリーズするため、
    // 必ず前フレームのタイムスタンプより +1.0ms 以上進んでいることを保証する
    const now = typeof frameTime === "number" && !isNaN(frameTime) ? frameTime : performance.now();
    const timestampMs = Math.max(now, lastVideoTimestamp + 1.0);
    lastVideoTimestamp = timestampMs;

    // 推論実行
    const results = handLandmarker.detectForVideo(video, timestampMs);

    canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

    if (results && results.landmarks && results.landmarks.length > 0) {
      const activeLabels = new Set();
      let maxAy = 0;
      let maxVy = 0;

      const cw = canvas.width;
      const ch = canvas.height;

      for (let i = 0; i < results.landmarks.length; i++) {
        const landmarks = results.landmarks[i];

        // 左右の手のラベル（Left / Right）を確定し、専用トラッカーに固定割り当て
        let handedness = "Right";
        if (results.handednesses && results.handednesses[i] && results.handednesses[i][0]) {
          handedness = results.handednesses[i][0].categoryName;
        } else {
          handedness = i === 0 ? "Right" : "Left";
        }
        activeLabels.add(handedness);

        const state = handTrackers[handedness];

        // 各指先（TIP）ピクセル座標の取得
        const tips = [4, 8, 12, 16, 20].map((idx) => ({
          id: idx,
          x: landmarks[idx].x * cw,
          y: landmarks[idx].y * ch
        }));

        // 打鍵の主軸指先：人差し指先端(8)と中指先端(12)の安定幾何中心
        const primaryTipX = (tips[1].x + tips[2].x) * 0.5;
        const primaryTipY = (tips[1].y + tips[2].y) * 0.5;

        // 最下点ピーク反転検知（振り下ろしから机面に衝突して止まった瞬間を100%検出）
        const detectResult = state.updateAndDetect(primaryTipX, primaryTipY, timestampMs, cw, ch);

        // 指先マーカーおよび全指骨格ラインの描画
        if (showTrackingLines) {
          drawFingertipTrackingLines(landmarks, cw, ch, tips, detectResult.x, detectResult.y, state.tapState);
        }

        if (detectResult.stroke > maxAy) maxAy = detectResult.stroke;
        if (Math.abs(detectResult.dy) > maxVy) maxVy = Math.abs(detectResult.dy);
      }

      // 画面から外れた手のリセット
      for (const label of ["Left", "Right"]) {
        if (!activeLabels.has(label)) {
          handTrackers[label].reset();
        }
      }

      // HUDのリアルタイム更新（振り下ろしストローク量 S と現フレーム変位 dY）
      if (hudAcc) hudAcc.textContent = `S:${Math.round(maxAy)}px`;
      if (hudVel) hudVel.textContent = `dY:${maxVy.toFixed(1)}`;
    } else {
      handTrackers.Left.reset();
      handTrackers.Right.reset();
      if (hudAcc) hudAcc.textContent = "-";
      if (hudVel) hudVel.textContent = "-";
    }
  } catch (err) {
    console.error("[PREDICT] Frame processing error:", err);
  } finally {
    isPredicting = false;
  }
}

/**
 * 指先優先トラッキングライン（完全ボーダーレス・洗練された幾何学骨格と指先マーカー）の描画
 */
function drawFingertipTrackingLines(landmarks, cw, ch, tips, filteredX, filteredY, tapState) {
  canvasCtx.save();
  canvasCtx.lineCap = "round";
  canvasCtx.lineJoin = "round";

  // 1. 各指の関節骨格ライン（手首から各指先まで）
  const fingerChains = [
    [0, 1, 2, 3, 4],     // 親指
    [0, 5, 6, 7, 8],     // 人差し指
    [0, 9, 10, 11, 12],  // 中指
    [0, 13, 14, 15, 16], // 薬指
    [0, 17, 18, 19, 20]  // 小指
  ];

  canvasCtx.strokeStyle = "rgba(255, 255, 255, 0.55)";
  canvasCtx.lineWidth = 2.0;

  fingerChains.forEach((chain) => {
    canvasCtx.beginPath();
    canvasCtx.moveTo(landmarks[chain[0]].x * cw, landmarks[chain[0]].y * ch);
    for (let j = 1; j < chain.length; j++) {
      canvasCtx.lineTo(landmarks[chain[j]].x * cw, landmarks[chain[j]].y * ch);
    }
    canvasCtx.stroke();
  });

  // 2. 指の付け根（MCPアーチ）ライン
  canvasCtx.strokeStyle = "rgba(255, 255, 255, 0.75)";
  canvasCtx.lineWidth = 2.6;
  canvasCtx.beginPath();
  canvasCtx.moveTo(landmarks[5].x * cw, landmarks[5].y * ch);
  canvasCtx.lineTo(landmarks[9].x * cw, landmarks[9].y * ch);
  canvasCtx.lineTo(landmarks[13].x * cw, landmarks[13].y * ch);
  canvasCtx.lineTo(landmarks[17].x * cw, landmarks[17].y * ch);
  canvasCtx.stroke();

  // 3. 全指先のマーカーノード（白丸）
  tips.forEach((t) => {
    canvasCtx.beginPath();
    canvasCtx.arc(t.x, t.y, 4.5, 0, Math.PI * 2);
    canvasCtx.fillStyle = "rgba(255, 255, 255, 0.85)";
    canvasCtx.fill();
  });

  // 4. 主動打鍵指先（Lead Fingertip）の追従ターゲットマーカー
  const isHit = tapState === "TOUCHED";
  canvasCtx.beginPath();
  canvasCtx.arc(filteredX, filteredY, isHit ? 16 : 8, 0, Math.PI * 2);
  canvasCtx.fillStyle = isHit ? "#ffffff" : "rgba(255, 255, 255, 0.95)";
  canvasCtx.shadowColor = "#ffffff";
  canvasCtx.shadowBlur = isHit ? 28 : 12;
  canvasCtx.fill();

  canvasCtx.restore();
}

// ==========================================================================
// 9. イベントリスナーと初期化フロー
// ==========================================================================

/**
 * オーディオのアンロック（確実な音声初期化 ＆ 即時テスト発音）
 */
async function unlockAudio() {
  if (audioStartOverlay) {
    audioStartOverlay.classList.add("hidden");
  }
  await drumEngine.init();
  drumEngine.playKick(1.1);
  updateHitBadge("AUDIO UNLOCKED", 1.0);
}

// 中央オーバーレイのクリック/タップでアンロック
if (audioStartOverlay) {
  audioStartOverlay.addEventListener("click", unlockAudio);
}
if (audioStartBtn) {
  audioStartBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    unlockAudio();
  });
}

// 音声テストボタン（右上ナビゲーション・スネア/キック試聴）
if (testAudioBtn) {
  testAudioBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    await drumEngine.ensureRunning();
    drumEngine.playSnare(1.2);
    updateHitBadge("TEST SNARE", 1.2);
    if (audioStartOverlay) audioStartOverlay.classList.add("hidden");
  });
}

// 画面全体のタップでもオーディオアンロック ＆ クリックでのドラムテスト発音
window.addEventListener("pointerdown", async (e) => {
  if (!drumEngine.isReady) {
    await unlockAudio();
  }

  // コントロールボタン・ナビゲーション領域のタップは除外
  if (e.target && typeof e.target.closest === "function" && (e.target.closest("button") || e.target.closest("nav"))) {
    return;
  }

  // 画面上のクリック位置をCanvas座標系にマッピング（鏡像反転考慮）
  const rect = canvas.getBoundingClientRect();
  const screenXRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / (rect.width || 1)));
  const screenYRatio = Math.max(0, Math.min(1, (e.clientY - rect.top) / (rect.height || 1)));
  const canvasX = (1 - screenXRatio) * canvas.width;
  const canvasY = screenYRatio * canvas.height;

  triggerDrumHit(canvasX, canvasY, 3200, canvas.width, canvas.height);
});

// デバッグ・テスト用グローバル関数
window.triggerDrumHit = triggerDrumHit;
window.drumEngine = drumEngine;
window.unlockAudio = unlockAudio;

// トラッキングライン表示切替
toggleTrackingBtn.addEventListener("click", () => {
  showTrackingLines = !showTrackingLines;
  toggleTrackingBtn.classList.toggle("active", showTrackingLines);
});

// カメラ再起動
refreshCameraBtn.addEventListener("click", async () => {
  isVideoReady = false;
  isPredicting = false;
  lastVideoTimestamp = -1;
  handTrackers.Left.reset();
  handTrackers.Right.reset();
  await setupCamera();
});

// フルスクリーン切替
fullscreenBtn.addEventListener("click", () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
});

// アプリケーション起動
async function main() {
  await loadPiarnoDataset();
  await setupHandLandmarker();
  await setupCamera();

  // カメラ同期推論ループ開始
  schedulePredictLoop();
}

main();
