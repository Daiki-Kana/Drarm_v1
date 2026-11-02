/**
 * Drarm_v1 - 手のひら・指先打鍵 低遅延Webドラムシステム
 * 
 * Piarno 1D方式の平滑化フィルタ（PointFilter）と十字ターゲット丸マーク（drawTipTargetMark）を完全移植。
 * 各関節独立の 1 Euro Filter によるジッターフリー追従と、
 * 相対沈み込み ry に基づく打鍵ヒステリシスで机面タッチを瞬時に検出します。
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

// 録画モード関連DOM要素
const toggleRecorderBtn = document.getElementById("toggle-recorder-btn");
const recorderPanel = document.getElementById("recorder-panel");
const recActionBtn = document.getElementById("rec-action-btn");
const recTime = document.getElementById("rec-time");
const recFrames = document.getElementById("rec-frames");
const recHits = document.getElementById("rec-hits");
const recDownloadBtn = document.getElementById("rec-download-btn");
const recSegBtns = document.querySelectorAll(".rec-seg-btn");

// アノテーションスタジオ（動画編集型プレビュー＆タイムライン）関連DOM要素
const toggleAnalyzerBtn = document.getElementById("toggle-analyzer-btn");
const videoFileInput = document.getElementById("video-file-input");
const annotationStudio = document.getElementById("annotation-studio");
const studioFilename = document.getElementById("studio-filename");
const studioTimecode = document.getElementById("studio-timecode");
const studioFlipBtn = document.getElementById("studio-flip-btn");
const studioToggleTrackBtn = document.getElementById("studio-toggle-track-btn");
const studioCloseBtn = document.getElementById("studio-close-btn");
const studioCanvas = document.getElementById("studio-canvas");
const studioCanvasCtx = studioCanvas ? studioCanvas.getContext("2d") : null;
const studioFlash = document.getElementById("studio-flash");

const timelineTrack = document.getElementById("timeline-track");
const timelineProgress = document.getElementById("timeline-progress");
const timelinePlayhead = document.getElementById("timeline-playhead");
const timelineMarkers = document.getElementById("timeline-markers");

const studioStepBack5Btn = document.getElementById("studio-step-back5-btn");
const studioStepBackBtn = document.getElementById("studio-step-back-btn");
const studioPlayBtn = document.getElementById("studio-play-btn");
const studioPlayIcon = document.getElementById("studio-play-icon");
const studioPauseIcon = document.getElementById("studio-pause-icon");
const studioStepFwdBtn = document.getElementById("studio-step-fwd-btn");
const studioStepFwd5Btn = document.getElementById("studio-step-fwd5-btn");
const studioSpeedBtns = document.querySelectorAll(".studio-speed-btn");

const studioMarkHitBtn = document.getElementById("studio-mark-hit-btn");
const studioMarkerCount = document.getElementById("studio-marker-count");

const studioOpenFileBtn = document.getElementById("studio-open-file-btn");
const studioClearMarkersBtn = document.getElementById("studio-clear-markers-btn");
const studioExportCsvBtn = document.getElementById("studio-export-csv-btn");

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

    const bufferSize = this.ctx.sampleRate;
    this.noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }

    this.isReady = this.ctx.state === "running";
    this.updateHud();
  }

  async ensureRunning() {
    if (!this.ctx) {
      await this.init();
    } else if (this.ctx.state === "suspended") {
      await this.ctx.resume();
      this.updateHud();
    }
  }

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

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start(now);
    osc.stop(now + duration);

    // クリックアタック
    const clickOsc = this.ctx.createOscillator();
    const clickGain = this.ctx.createGain();
    clickOsc.type = "triangle";
    clickOsc.frequency.setValueAtTime(400, now);
    clickGain.gain.setValueAtTime(0.3 * intensity, now);
    clickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.015);
    clickOsc.connect(clickGain);
    clickGain.connect(this.masterGain);
    clickOsc.start(now);
    clickOsc.stop(now + 0.015);
  }

  playSnare(intensity = 1.0) {
    if (!this.ctx || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    const volume = Math.min(1.0, 0.65 * intensity);

    // トーン成分
    const osc = this.ctx.createOscillator();
    const oscGain = this.ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(185, now);
    osc.frequency.exponentialRampToValueAtTime(90, now + 0.1);
    oscGain.gain.setValueAtTime(volume * 0.7, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    osc.connect(oscGain);
    oscGain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.12);

    // スナッピーノイズ成分
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.setValueAtTime(1000, now);
    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(volume * 0.85, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(this.masterGain);
    noise.start(now);
    noise.stop(now + 0.22);
  }

  playHiHat(isOpen = false, intensity = 1.0) {
    if (!this.ctx || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    const duration = isOpen ? 0.35 : 0.06;
    const volume = Math.min(0.8, 0.45 * intensity);

    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.setValueAtTime(7000, now);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    noise.start(now);
    noise.stop(now + duration);
  }

  playCrash(intensity = 1.0) {
    if (!this.ctx || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    const duration = 1.2;
    const volume = Math.min(1.1, 0.7 * intensity);

    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(4500, now);
    filter.Q.setValueAtTime(1.2, now);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    noise.start(now);
    noise.stop(now + duration);
  }

  playTom(intensity = 1.0) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const duration = 0.25;

    osc.type = "sine";
    osc.frequency.setValueAtTime(150, now);
    osc.frequency.exponentialRampToValueAtTime(70, now + duration);

    gain.gain.setValueAtTime(0.6 * intensity, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + duration);
  }
}

const drumEngine = new ProceduralDrumEngine();

// ==========================================================================
// 3. Piarno 1D方式 1 Euro Filter & PointFilter（超滑らか・ジッターゼロ追従）
// ==========================================================================
class OneEuroFilter {
  constructor(minCutoff = 1.2, beta = 0.008, dCutoff = 1.0) {
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

    const dx = (x - this.xPrev) / dt;
    const aD = this.alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    this.dxPrev = dxHat;

    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = this.alpha(cutoff, dt);

    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    return xHat;
  }
}

/**
 * 2D関節座標用 1 Euro Filter（Piarno完全準拠）
 */
class PointFilter {
  constructor(minCutoff = 1.2, beta = 0.008) {
    this.xf = new OneEuroFilter(minCutoff, beta);
    this.yf = new OneEuroFilter(minCutoff, beta);
  }

  reset() {
    this.xf.reset();
    this.yf.reset();
  }

  filter(x, y, timestamp = performance.now()) {
    return {
      x: this.xf.filter(x, timestamp),
      y: this.yf.filter(y, timestamp)
    };
  }
}

// 骨格接続定義
const HAND_CONNECTIONS = [
  // 手のひら
  [0, 1], [0, 5], [5, 9], [9, 13], [13, 17], [0, 17],
  // 親指
  [1, 2], [2, 3], [3, 4],
  // 人差し指
  [5, 6], [6, 7], [7, 8],
  // 中指
  [9, 10], [10, 11], [11, 12],
  // 薬指
  [13, 14], [14, 15], [15, 16],
  // 小指
  [17, 18], [18, 19], [19, 20]
];

const INDEX_LANDMARK_INDICES = [5, 6, 7, 8];
const OTHER_CONNECTIONS = HAND_CONNECTIONS.filter(
  ([s, e]) => !(INDEX_LANDMARK_INDICES.includes(s) && INDEX_LANDMARK_INDICES.includes(e))
);

// ==========================================================================
// 4. 打鍵閾値パラメータ & データセット読み込み
// ==========================================================================
let hitRyThreshold = 0.62;   // 沈み込み打鍵閾値 ry（全指・感度向上）
let liftRyThreshold = 0.38;  // リフト復帰閾値 ry
const MIN_COOLDOWN_MS = 55;  // チャタリング二重鳴り防止 ＆ 高速連打両立クールダウン（秒間約18打、両手約36打）

/**
 * Piarno / Drarm 実測データセットからの閾値最適化
 */
async function loadPiarnoDataset() {
  try {
    let res = await fetch("./dataset/manifest.json");
    if (!res.ok) res = await fetch("/dataset/manifest.json");
    if (!res.ok) return;

    const manifest = await res.json();
    let files = [];
    let isDrumDataset = false;

    // ドラム実測アノテーションデータ（drum_annotated）を最優先で適用
    if (manifest?.drum_annotated && Array.isArray(manifest.drum_annotated) && manifest.drum_annotated.length > 0) {
      files = manifest.drum_annotated;
      isDrumDataset = true;
    } else if (Array.isArray(manifest)) {
      files = manifest;
    } else if (manifest?.files) {
      files = manifest.files;
    } else if (manifest?.fingers) {
      files = Object.values(manifest.fingers).flat();
    }

    const hitRys = [];
    const targetFiles = isDrumDataset ? files : files.slice(0, 8);

    for (const f of targetFiles) {
      try {
        let csvRes = await fetch(`./dataset/${f}`);
        if (!csvRes.ok) csvRes = await fetch(`/dataset/${f}`);
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
          if (!isNaN(ryVal) && isHit && ryVal > 0) {
            hitRys.push(ryVal);
          }
        }
      } catch (e) {}
    }

    if (hitRys.length > 0) {
      hitRys.sort((a, b) => a - b);
      if (isDrumDataset) {
        // ドラム実測データに最適化した閾値設計（下位10%打鍵をカバーしつつ感度を向上）
        const p10 = hitRys[Math.floor(hitRys.length * 0.10)];
        const median = hitRys[Math.floor(hitRys.length * 0.5)];
        hitRyThreshold = Math.max(0.50, Math.min(0.72, p10 * 0.75));
        liftRyThreshold = hitRyThreshold * 0.60;
        console.log(`[DATASET] Drum dataset calibrated (${hitRys.length} hit frames, median ry=${median.toFixed(2)}): hitRy=${hitRyThreshold.toFixed(2)}, liftRy=${liftRyThreshold.toFixed(2)}`);
        updateHitBadge(`CALIBRATED: ${hitRys.length} HITS`, 1.0);
      } else {
        const median = hitRys[Math.floor(hitRys.length * 0.5)];
        hitRyThreshold = Math.max(0.45, Math.min(0.75, median * 0.88));
        liftRyThreshold = hitRyThreshold * 0.62;
        console.log(`[DATASET] Biomechanical thresholds: hitRy=${hitRyThreshold.toFixed(2)}, liftRy=${liftRyThreshold.toFixed(2)}`);
      }
    }
  } catch (err) {
    console.warn("[DATASET] Using default biomechanical thresholds:", err);
  }
}

// ==========================================================================
// 5. 左右の手のトラッカーステート（全5指インパルス・主動打鍵指先トラッキング）
// ==========================================================================
const FINGER_KEYS = ["thumb", "index", "middle", "ring", "pinky"];
const FINGER_LANDMARKS = {
  thumb:  { mcp: 2, tip: 4 },
  index:  { mcp: 5, tip: 8 },
  middle: { mcp: 9, tip: 12 },
  ring:   { mcp: 13, tip: 16 },
  pinky:  { mcp: 17, tip: 20 }
};

class HandTrackerState {
  constructor(name) {
    this.name = name; // "Left" または "Right"
    this.tapState = "IDLE"; // "IDLE" または "TOUCHED"
    this.lastHitTime = 0;

    // 全5指の各指先（TIP）およびMCPの独立 1 Euro Filter
    this.tipFilters = {};
    this.mcpFilters = {};
    for (const k of FINGER_KEYS) {
      this.tipFilters[k] = new PointFilter(1.5, 0.01);
      this.mcpFilters[k] = new PointFilter(1.5, 0.01);
    }
    this.wristFilter = new PointFilter(1.5, 0.01);

    this.prevLeadTipY = null;
    this.prevPrevLeadTipY = null;
    this.prevMaxRy = null;
    this.peakDownwardSpeed = 0.0;
    this.leadFinger = "index";
    this.hitRy = 0.0;
  }

  reset() {
    this.tapState = "IDLE";
    this.lastHitTime = 0;
    this.prevLeadTipY = null;
    this.prevPrevLeadTipY = null;
    this.prevMaxRy = null;
    this.peakDownwardSpeed = 0.0;
    this.leadFinger = "index";
    this.hitRy = 0.0;
    this.wristFilter.reset();
    Object.values(this.tipFilters).forEach((f) => f.reset());
    Object.values(this.mcpFilters).forEach((f) => f.reset());
  }

  /**
   * 手の全5指ランドマークを処理し、主動打鍵指先の選定と打鍵判定を計算
   */
  update(landmarks, timestampMs, cw, ch) {
    const rawWrist = { x: landmarks[0].x * cw, y: landmarks[0].y * ch };
    const smoothWrist = this.wristFilter.filter(rawWrist.x, rawWrist.y, timestampMs);

    // 手の3D基準長 L（手首〜人差し指MCP間）
    const dx05 = landmarks[5].x - landmarks[0].x;
    const dy05 = landmarks[5].y - landmarks[0].y;
    const dz05 = (landmarks[5].z ?? 0) - (landmarks[0].z ?? 0);
    const L = Math.hypot(dx05, dy05, dz05) || 0.001;

    // 全5指の平滑化座標と沈み込み変位 ry を計算
    const smoothTips = {};
    const smoothMcps = {};
    let maxRy = -999;
    let currentLeadFinger = "index";

    for (const key of FINGER_KEYS) {
      const { mcp: mcpIdx, tip: tipIdx } = FINGER_LANDMARKS[key];
      const rawMcp = { x: landmarks[mcpIdx].x * cw, y: landmarks[mcpIdx].y * ch };
      const rawTip = { x: landmarks[tipIdx].x * cw, y: landmarks[tipIdx].y * ch };

      const sMcp = this.mcpFilters[key].filter(rawMcp.x, rawMcp.y, timestampMs);
      const sTip = this.tipFilters[key].filter(rawTip.x, rawTip.y, timestampMs);

      smoothTips[key] = sTip;
      smoothMcps[key] = sMcp;

      // 各指の相対沈み込み変位 ry（指先がMCPに対してどれだけ机面下方向に沈んでいるか）
      const ry = (sTip.y - sMcp.y) / (ch * L);
      if (ry > maxRy) {
        maxRy = ry;
        currentLeadFinger = key;
      }
    }

    this.leadFinger = currentLeadFinger;
    const leadTip = smoothTips[currentLeadFinger];
    const leadMcp = smoothMcps[currentLeadFinger];

    // 主動指先の垂直移動速度（下降・最下点反転検知用）
    let dy = 0;
    let prevDy = 0;
    if (this.prevLeadTipY !== null) {
      dy = leadTip.y - this.prevLeadTipY;
      if (this.prevPrevLeadTipY !== null) {
        prevDy = this.prevLeadTipY - this.prevPrevLeadTipY;
      }
    }

    const now = performance.now();
    let isHit = false;

    // 【インパルス・インパクト打鍵判定（全指対応・リバウンド防止・高速連打両立）】
    if (this.tapState === "IDLE") {
      // 下降（振り下ろし）ピーク速度の追跡
      if (dy > this.peakDownwardSpeed) {
        this.peakDownwardSpeed = dy;
      }

      // 1. 机面打鍵ゾーン到達（最も深く沈んだ指の変位）
      const isInDeskZone = maxRy >= hitRyThreshold;

      // 2. 振り下ろしの下向き勢い（下降インパルス：0.45px）
      const hadDownwardMomentum = this.peakDownwardSpeed >= 0.45 || prevDy >= 0.45;

      // 3. 机面衝突による急制動・最下点到達（停止または跳ね返り：dy <= 2.2px）
      const isStoppingOrBottom = dy <= 2.2;

      // 4. 急峻な叩きつけ（フレーム間の急激な沈み込み：0.12）
      const prevRyVal = this.prevMaxRy !== null ? this.prevMaxRy : maxRy;
      const isSlam = isInDeskZone && (maxRy - prevRyVal >= 0.12);

      // 深い位置に「留まっている」だけでは絶対に鳴らさない。
      // 「振り下ろしからの急制動」または「急激な叩きつけ」の瞬間のみ発音
      const isImpactOnset = isInDeskZone && ((hadDownwardMomentum && isStoppingOrBottom) || isSlam);

      if (isImpactOnset && now - this.lastHitTime >= MIN_COOLDOWN_MS) {
        this.tapState = "TOUCHED";
        this.lastHitTime = now;
        this.peakDownwardSpeed = 0.0;
        this.hitRy = maxRy; // 打鍵時の沈み込みピークを記憶
        isHit = true;

        // 打鍵強度ダイナミクス（振り下ろし速度と深さから算出）
        const impactSpeed = Math.max(prevDy, this.peakDownwardSpeed);
        const intensity = Math.min(1.4, Math.max(0.75, 0.8 + (maxRy - hitRyThreshold) * 0.8 + impactSpeed * 0.05));
        // 主動打鍵指先の位置（leadTip.x, leadTip.y）で音色分岐＆発音
        triggerDrumHit(leadTip.x, leadTip.y, intensity * 3500, cw, ch);
      }
    } else if (this.tapState === "TOUCHED") {
      const timeSinceHit = now - this.lastHitTime;

      // 【絶対リフト ＆ 微小相対リフト（Micro-lift）判定】
      // 1. 手を大きく持ち上げた場合（絶対リフトは常時受付）
      const isAbsoluteLift = maxRy <= liftRyThreshold;

      // 2. 微小相対リフト（衝突直後50msの物理的跳ね返り振動ガード付き）
      //    衝突直後のリバウンドによる二重鳴りを遮断し、意識的な指上げ動作のみを捉えてIDLE復帰
      const isMicroLift = (timeSinceHit >= 50) && (
        (dy <= -1.2 && maxRy <= this.hitRy - 0.10) || (maxRy <= this.hitRy - 0.16)
      );

      if (isAbsoluteLift || isMicroLift) {
        this.tapState = "IDLE";
        this.peakDownwardSpeed = 0.0;
      }
    }

    this.prevPrevLeadTipY = this.prevLeadTipY;
    this.prevLeadTipY = leadTip.y;
    this.prevMaxRy = maxRy;

    return {
      smoothWrist,
      smoothTips,
      smoothMcps,
      smoothTip: leadTip,
      smoothMcp: leadMcp,
      smoothPip: leadMcp,
      smoothDip: leadTip,
      leadFinger: this.leadFinger,
      leadTip,
      ry: maxRy,
      dy,
      L,
      isHit
    };
  }
}

const handTrackers = {
  Left: new HandTrackerState("Left"),
  Right: new HandTrackerState("Right")
};

// ==========================================================================
// 6. 軽量学習用データセットレコーダー（CSVダイレクト記録・高速DL）
// ==========================================================================
class DatasetRecorder {
  constructor() {
    this.isRecording = false;
    this.sessionType = "tap";
    this.targetHand = "Right";
    this.records = [];
    this.startTime = 0;
    this.frameCount = 0;
    this.hitCount = 0;
    this.isSpacePressed = false;
  }

  start() {
    this.isRecording = true;
    this.records = [];
    this.startTime = performance.now();
    this.frameCount = 0;
    this.hitCount = 0;
    this.updateUI();
    updateHitBadge("REC START", 1.2);
  }

  stop() {
    if (!this.isRecording) return;
    this.isRecording = false;
    this.updateUI();
    updateHitBadge("REC STOP", 1.0);
    // 録画停止時にCSVダウンロードボタンをアクティブ化
    if (this.records.length > 0 && recDownloadBtn) {
      recDownloadBtn.classList.remove("disabled");
    }
  }

  toggle() {
    if (this.isRecording) this.stop();
    else this.start();
  }

  recordFrame(handedness, landmarks, trackResult, timestampMs, cw, ch) {
    if (!this.isRecording) return;
    if (this.targetHand !== "Both" && this.targetHand !== handedness) return;

    this.frameCount++;
    const isHit = this.isSpacePressed || trackResult.isHit ? 1 : 0;
    if (isHit) {
      this.hitCount++;
      this.flashHitUi();
    }

    const { smoothWrist, smoothMcp, smoothTip, ry, dy, L } = trackResult;

    this.records.push({
      timestamp: Math.round(timestampMs),
      hand: handedness,
      session_type: this.sessionType,
      wrist_x: (smoothWrist.x / cw).toFixed(5),
      wrist_y: (smoothWrist.y / ch).toFixed(5),
      mcp_x: (smoothMcp.x / cw).toFixed(5),
      mcp_y: (smoothMcp.y / ch).toFixed(5),
      tip_x: (smoothTip.x / cw).toFixed(5),
      tip_y: (smoothTip.y / ch).toFixed(5),
      ry: ry.toFixed(4),
      dy: dy.toFixed(2),
      L: L.toFixed(5),
      is_hit: isHit
    });

    this.updateMetrics();
  }

  updateMetrics() {
    const elapsed = ((performance.now() - this.startTime) / 1000).toFixed(1);
    if (recTime) recTime.textContent = `${elapsed}s`;
    if (recFrames) recFrames.textContent = `${this.frameCount}f`;
    if (recHits) recHits.textContent = `${this.hitCount} hits`;
  }

  flashHitUi() {
    if (recHits) {
      recHits.classList.add("active-hit");
      setTimeout(() => {
        if (recHits) recHits.classList.remove("active-hit");
      }, 100);
    }
  }

  updateUI() {
    if (recActionBtn) {
      recActionBtn.classList.toggle("recording", this.isRecording);
      recActionBtn.title = this.isRecording ? "Stop Recording (Shortcut: R)" : "Start Recording (Shortcut: R)";
    }
    if (recDownloadBtn) {
      recDownloadBtn.classList.toggle("disabled", this.records.length === 0);
    }
  }

  downloadCsv() {
    if (this.records.length === 0) return;
    const headers = Object.keys(this.records[0]);
    const csvLines = [headers.join(",")];
    for (const r of this.records) {
      csvLines.push(headers.map((h) => r[h]).join(","));
    }
    const csvString = csvLines.join("\n");
    const blob = new Blob([csvString], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const nowStr = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
    a.download = `drarm_${this.targetHand.toLowerCase()}_${this.sessionType}_${nowStr}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    updateHitBadge("CSV DOWNLOADED", 1.2);
  }
}

const datasetRecorder = new DatasetRecorder();

// ==========================================================================
// 6.5. 動画編集型アノテーションスタジオ（骨格追従プレビュー＆Hitマーカー手動設置）
// ==========================================================================
let isOfflineAnalyzing = false; // オフラインスタジオ実行中フラグ（カメラ推論の一時停止制御）

class AnnotationStudioController {
  constructor() {
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.preload = "auto";

    this.file = null;
    this.fileName = "";
    this.fps = 60;
    this.duration = 0;
    this.totalFrames = 0;
    this.currentFrame = 0;
    this.isPlaying = false;
    this.playbackRate = 1.0;
    this.isFlipped = false;
    this.showSkeleton = true;

    this.hitMarkers = new Set(); // ユーザーが設置したHitフレーム番号のSet
    this.skeletonCache = []; // 各フレームの骨格ランドマーク＆特徴量キャッシュ
    this.lastInferenceTimestamp = -1.0;

    // スタジオ専用の独立PointFilterトラッカー
    this.trackers = {
      Left: new HandTrackerState("Left"),
      Right: new HandTrackerState("Right")
    };

    this.animFrameId = null;
    this.initVideoEvents();
  }

  initVideoEvents() {
    this.video.addEventListener("ended", () => {
      this.pause();
    });
  }

  async openStudio(file) {
    if (!handLandmarker) {
      alert("Vision model is still loading. Please wait a moment.");
      return;
    }

    this.pause();
    isOfflineAnalyzing = true; // カメラ推論を停止
    this.file = file;
    this.fileName = file.name.replace(/\.[^/.]+$/, "");
    this.hitMarkers.clear();
    this.skeletonCache = [];
    this.lastInferenceTimestamp = -1.0;
    this.trackers.Left.reset();
    this.trackers.Right.reset();

    if (studioFilename) studioFilename.textContent = file.name;
    if (document.getElementById("annotation-studio")) {
      document.getElementById("annotation-studio").classList.remove("hidden");
    }

    this.video.src = URL.createObjectURL(file);

    try {
      // 1. メタデータと動画フレームピクセル展開の待機
      await new Promise((resolve, reject) => {
        const onLoaded = () => {
          if (this.video.readyState >= 2) {
            resolve();
          } else {
            this.video.addEventListener("loadeddata", () => resolve(), { once: true });
          }
        };
        if (this.video.readyState >= 2) {
          resolve();
        } else if (this.video.readyState >= 1) {
          onLoaded();
        } else {
          this.video.addEventListener("loadedmetadata", onLoaded, { once: true });
        }
        this.video.onerror = () => reject(new Error("Video failed to load."));
      });

      this.duration = this.video.duration;
      if (!this.duration || isNaN(this.duration) || this.duration <= 0) {
        throw new Error("Invalid video duration");
      }

      this.totalFrames = Math.max(1, Math.floor(this.duration * this.fps));
      this.skeletonCache = new Array(this.totalFrames).fill(null);

      // スタジオではコマ送り・シークでも100%確実に検出するためIMAGEモードへ切替
      if (handLandmarker && typeof handLandmarker.setOptions === "function") {
        await handLandmarker.setOptions({ runningMode: "IMAGE" });
      }

      // Canvas解像度をビデオ解像度と1:1で完全同期（ズレを完全に排除）
      const vw = this.video.videoWidth || 1280;
      const vh = this.video.videoHeight || 720;
      if (studioCanvas) {
        studioCanvas.width = vw;
        studioCanvas.height = vh;
        studioCanvas.classList.toggle("flipped", this.isFlipped);
      }

      this.currentFrame = 0;
      await this.seekToFrame(0);
      this.updateMarkerUi();
    } catch (err) {
      console.error("[STUDIO] Open error:", err);
      alert(`Could not open video: ${err.message}`);
      await this.closeStudio();
    }
  }

  async closeStudio() {
    this.pause();
    if (this.video.src) {
      URL.revokeObjectURL(this.video.src);
      this.video.src = "";
    }
    const studioEl = document.getElementById("annotation-studio");
    if (studioEl) studioEl.classList.add("hidden");

    // 通常のリアルタイムカメラ推論用にVIDEOモードへ復帰
    if (handLandmarker && typeof handLandmarker.setOptions === "function") {
      try {
        await handLandmarker.setOptions({ runningMode: "VIDEO" });
      } catch (e) {}
    }

    lastVideoTimestamp = -1; // タイムスタンプリセット
    isOfflineAnalyzing = false; // カメラ推論の再開
    if (canvasCtx) canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
  }

  toggleFlip() {
    this.isFlipped = !this.isFlipped;
    if (studioCanvas) {
      studioCanvas.classList.toggle("flipped", this.isFlipped);
    }
    if (studioFlipBtn) {
      studioFlipBtn.classList.toggle("active", this.isFlipped);
    }
  }

  toggleSkeleton() {
    this.showSkeleton = !this.showSkeleton;
    if (studioToggleTrackBtn) {
      studioToggleTrackBtn.classList.toggle("active", this.showSkeleton);
    }
    this.renderFrame(false);
  }

  setSpeed(speed) {
    this.playbackRate = speed;
    this.video.playbackRate = speed;
    studioSpeedBtns.forEach((b) => {
      b.classList.toggle("active", parseFloat(b.dataset.speed) === speed);
    });
  }

  play() {
    if (this.isPlaying) return;
    this.isPlaying = true;
    this.video.playbackRate = this.playbackRate;
    this.video.play();

    if (studioPlayIcon) studioPlayIcon.classList.add("hidden");
    if (studioPauseIcon) studioPauseIcon.classList.remove("hidden");

    const loop = () => {
      if (!this.isPlaying) return;
      const f = Math.floor(this.video.currentTime * this.fps);
      if (f !== this.currentFrame) {
        this.currentFrame = Math.min(this.totalFrames - 1, Math.max(0, f));
        this.renderFrame(true);
      }
      this.animFrameId = requestAnimationFrame(loop);
    };
    this.animFrameId = requestAnimationFrame(loop);
  }

  pause() {
    this.isPlaying = false;
    this.video.pause();
    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);

    if (studioPlayIcon) studioPlayIcon.classList.remove("hidden");
    if (studioPauseIcon) studioPauseIcon.classList.add("hidden");
  }

  togglePlay() {
    if (this.isPlaying) this.pause();
    else this.play();
  }

  async seekToFrame(frameIndex) {
    const clamped = Math.max(0, Math.min(this.totalFrames - 1, frameIndex));
    this.currentFrame = clamped;
    const targetTime = clamped / this.fps;

    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.video.removeEventListener("seeked", onSeeked);
        resolve();
      }, 500);
      const onSeeked = () => {
        clearTimeout(timeout);
        this.video.removeEventListener("seeked", onSeeked);
        resolve();
      };
      this.video.addEventListener("seeked", onSeeked, { once: true });
      this.video.currentTime = targetTime;
    });

    this.renderFrame(true);
  }

  step(delta) {
    this.pause();
    this.seekToFrame(this.currentFrame + delta);
  }

  /**
   * 現在のフレームを描画し、必要に応じてMediaPipe推論を実行＆キャッシュ
   */
  renderFrame(allowInference = true) {
    if (!studioCanvas || !studioCanvasCtx) return;

    const cw = studioCanvas.width;
    const ch = studioCanvas.height;
    const f = this.currentFrame;
    const targetTime = f / this.fps;

    // 1. ビデオフレームを描画
    studioCanvasCtx.clearRect(0, 0, cw, ch);
    studioCanvasCtx.drawImage(this.video, 0, 0, cw, ch);

    // 2. 骨格トラッキング（キャッシュ確認または新規推論）
    let frameData = this.skeletonCache[f];

    if (!frameData && allowInference && handLandmarker) {
      try {
        let results = null;

        // IMAGEモードのときはCanvas画像からタイムスタンプなしで直接推論
        if (typeof handLandmarker.detect === "function") {
          results = handLandmarker.detect(studioCanvas);
        } else if (typeof handLandmarker.detectForVideo === "function") {
          const calculatedMs = Math.round(targetTime * 1000);
          const timestampMs = Math.max(this.lastInferenceTimestamp + 1.0, calculatedMs);
          this.lastInferenceTimestamp = timestampMs;
          results = handLandmarker.detectForVideo(studioCanvas, timestampMs);
        }

        if (results && results.landmarks && results.landmarks.length > 0) {
          const hands = [];
          for (let i = 0; i < results.landmarks.length; i++) {
            const landmarks = results.landmarks[i];
            let handedness = "Right";
            if (results.handednesses?.[i]?.[0]) {
              handedness = results.handednesses[i][0].categoryName;
            } else {
              handedness = i === 0 ? "Right" : "Left";
            }

            // 手の3D基準長 L（手首〜人差し指MCP間）
            const dx05 = landmarks[5].x - landmarks[0].x;
            const dy05 = landmarks[5].y - landmarks[0].y;
            const dz05 = (landmarks[5].z ?? 0) - (landmarks[0].z ?? 0);
            const L = Math.hypot(dx05, dy05, dz05) || 0.001;

            // 相対沈み込み変位 ry
            const ry = (landmarks[8].y - landmarks[5].y) / L;

            // 垂直移動差分 dy
            let dy = 0;
            if (f > 0 && this.skeletonCache[f - 1]?.hands) {
              const prev = this.skeletonCache[f - 1].hands.find((h) => h.handedness === handedness);
              if (prev) {
                dy = (landmarks[8].y - prev.landmarks[8].y) * ch;
              }
            }

            // 動画アノテーションでは平滑化履歴によるズレを防ぎ、現在コマの手の位置と1:1完全一致
            const trackResult = {
              smoothTip: { x: landmarks[8].x * cw, y: landmarks[8].y * ch },
              smoothMcp: { x: landmarks[5].x * cw, y: landmarks[5].y * ch },
              smoothPip: { x: landmarks[6].x * cw, y: landmarks[6].y * ch },
              smoothDip: { x: landmarks[7].x * cw, y: landmarks[7].y * ch },
              ry,
              dy,
              L,
              isHit: false
            };

            hands.push({ handedness, landmarks, trackResult, tapState: "IDLE" });
          }
          frameData = { hands, timestampMs: Math.round(targetTime * 1000) };
          this.skeletonCache[f] = frameData;
        }
      } catch (err) {
        console.warn("[STUDIO] Inference skipped for frame:", f, err);
      }
    }

    // 3. 骨格のオーバーレイ描画
    if (this.showSkeleton && frameData && frameData.hands) {
      for (const h of frameData.hands) {
        drawPiarnoHand(h.landmarks, cw, ch, h.trackResult, h.tapState, studioCanvasCtx);
      }
    }

    // 4. UIメタデータの更新
    const curSec = targetTime.toFixed(2);
    const durSec = this.duration.toFixed(2);
    if (studioTimecode) {
      studioTimecode.textContent = `${curSec}s / ${durSec}s (F: ${f} / ${this.totalFrames - 1})`;
    }

    const progressPct = this.totalFrames > 1 ? (f / (this.totalFrames - 1)) * 100 : 0;
    if (timelineProgress) timelineProgress.style.width = `${progressPct}%`;
    if (timelinePlayhead) timelinePlayhead.style.left = `${progressPct}%`;

    const isMarked = this.hitMarkers.has(f);
    if (studioMarkHitBtn) {
      studioMarkHitBtn.classList.toggle("is-marked", isMarked);
      const labelEl = studioMarkHitBtn.querySelector(".mark-label");
      if (labelEl) labelEl.textContent = isMarked ? "UNMARK HIT" : "MARK HIT";
    }
  }

  /**
   * 現在フレームにHitマーカーを設置 / 削除
   */
  toggleHitMarker(frame = this.currentFrame) {
    const isMarked = this.hitMarkers.has(frame);
    if (isMarked) {
      this.hitMarkers.delete(frame);
    } else {
      this.hitMarkers.add(frame);
      // ドラム試聴音
      drumEngine.ensureRunning();
      drumEngine.playSnare(1.2);
      // 白熱フラッシュ
      if (studioFlash) {
        studioFlash.classList.add("flash-active");
        setTimeout(() => studioFlash.classList.remove("flash-active"), 120);
      }
    }

    this.renderFrame(false);
    this.updateMarkerUi();
  }

  clearAllMarkers() {
    if (this.hitMarkers.size === 0) return;
    this.hitMarkers.clear();
    this.renderFrame(false);
    this.updateMarkerUi();
  }

  updateMarkerUi() {
    if (studioMarkerCount) {
      studioMarkerCount.textContent = `${this.hitMarkers.size} HITS`;
    }

    if (!timelineMarkers) return;
    timelineMarkers.innerHTML = "";

    const total = this.totalFrames > 1 ? this.totalFrames - 1 : 1;
    this.hitMarkers.forEach((f) => {
      const pin = document.createElement("span");
      pin.className = "marker-pin";
      pin.style.left = `${(f / total) * 100}%`;
      timelineMarkers.appendChild(pin);
    });
  }

  /**
   * 未推論のフレームを全自動シーク補完して、手動Hitラベル付きの全フレーム骨格CSVを書き出し
   */
  async exportCsv() {
    if (!this.file || this.totalFrames <= 0) return;

    this.pause();
    updateHitBadge("EXPORTING CSV", 1.0);

    const cw = studioCanvas.width;
    const ch = studioCanvas.height;

    // 未推論フレームがあれば順番に推論補完
    for (let f = 0; f < this.totalFrames; f++) {
      if (!this.skeletonCache[f]) {
        await this.seekToFrame(f);
      }
    }

    const records = [];
    for (let f = 0; f < this.totalFrames; f++) {
      const targetTime = f / this.fps;
      const isHit = this.hitMarkers.has(f) ? 1 : 0;
      const frameData = this.skeletonCache[f];

      if (frameData && frameData.hands && frameData.hands.length > 0) {
        for (const h of frameData.hands) {
          const lms = h.landmarks;
          const tr = h.trackResult;
          records.push({
            frame: f,
            timestamp_ms: frameData.timestampMs,
            time_sec: targetTime.toFixed(3),
            hand: h.handedness,
            wrist_x: lms[0].x.toFixed(5),
            wrist_y: lms[0].y.toFixed(5),
            mcp_x: lms[5].x.toFixed(5),
            mcp_y: lms[5].y.toFixed(5),
            pip_x: lms[6].x.toFixed(5),
            pip_y: lms[6].y.toFixed(5),
            tip_x: lms[8].x.toFixed(5),
            tip_y: lms[8].y.toFixed(5),
            smooth_tip_x: (tr.smoothTip.x / cw).toFixed(5),
            smooth_tip_y: (tr.smoothTip.y / ch).toFixed(5),
            ry: tr.ry.toFixed(4),
            dy: tr.dy.toFixed(2),
            L: tr.L.toFixed(5),
            is_hit: isHit
          });
        }
      } else {
        records.push({
          frame: f,
          timestamp_ms: Math.round(targetTime * 1000),
          time_sec: targetTime.toFixed(3),
          hand: "None",
          wrist_x: "", wrist_y: "",
          mcp_x: "", mcp_y: "",
          pip_x: "", pip_y: "",
          tip_x: "", tip_y: "",
          smooth_tip_x: "", smooth_tip_y: "",
          ry: "0.0000", dy: "0.00", L: "0.00000",
          is_hit: isHit
        });
      }
    }

    const headers = Object.keys(records[0]);
    const csvLines = [headers.join(",")];
    for (const r of records) {
      csvLines.push(headers.map((k) => r[k]).join(","));
    }
    const csvString = csvLines.join("\n");
    const blob = new Blob([csvString], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const nowStr = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
    a.download = `annotated_${this.fileName}_${this.fps}fps_${this.hitMarkers.size}hits_${nowStr}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    updateHitBadge("CSV EXPORTED", 1.2);
  }
}

const annotationStudioController = new AnnotationStudioController();

// ==========================================================================
// 7. ドラム発音・ゾーン判定・リップルエフェクト
// ==========================================================================
function updateHitBadge(label, intensity) {
  if (!hudHit) return;
  const powerPct = Math.round(Math.min(100, (intensity / 1.4) * 100));
  hudHit.textContent = `${label} ${powerPct}%`;
  hudHit.classList.add("flash-active");
  setTimeout(() => {
    if (hudHit) hudHit.classList.remove("flash-active");
  }, 130);
}

function triggerDrumHit(canvasX, canvasY, impactAcc, canvasWidth, canvasHeight) {
  drumEngine.ensureRunning();

  // インカメラは scaleX(-1) 反転表示
  // 画面左側（CYMBAL）: 生座標 canvasX > canvasWidth / 2
  // 画面右側（DRUM）: 生座標 canvasX <= canvasWidth / 2
  const isCymbalSide = canvasX > (canvasWidth / 2);
  const normalizedY = canvasY / canvasHeight;
  const intensity = Math.min(1.4, Math.max(0.65, impactAcc / 3500));

  let soundLabel = "";

  if (isCymbalSide) {
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

  createRipple(canvasX, canvasY, intensity);
}

function flashZone(element, label, intensity = 1.0) {
  if (element) {
    element.classList.add("hit-flash");
    setTimeout(() => {
      element.classList.remove("hit-flash");
    }, 110);
  }
  updateHitBadge(label, intensity);
}

// 白黒ミニマル波紋エフェクト
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
// 8. MediaPipe HandLandmarker ＆ カメラパイプライン
// ==========================================================================
let handLandmarker = null;
let showTrackingLines = true;
let isVideoReady = false;

async function setupHandLandmarker() {
  try {
    if (noticeText) noticeText.textContent = "LOADING VISION MODEL";
    if (noticeModal) noticeModal.classList.remove("hidden");

    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
    );

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
      } catch (e) {}
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
    console.log(`[VISION] Hand Landmarker initialized with ${resolvedModelPath}`);
  } catch (err) {
    console.error("[VISION] Hand Landmarker load failed:", err);
    if (noticeText) noticeText.textContent = "VISION INITIALIZE FAILED";
  }
}

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
// 9. カメラ同期推論ループ & Piarno完全準拠描画
// ==========================================================================
let lastVideoTimestamp = -1;
let isPredicting = false;

function schedulePredictLoop() {
  if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
    video.requestVideoFrameCallback((now, metadata) => {
      const frameTime = metadata?.presentationTime ? metadata.presentationTime * 1000 : now;
      processVideoFrame(frameTime);
      schedulePredictLoop();
    });
  } else {
    requestAnimationFrame((now) => {
      processVideoFrame(now);
      schedulePredictLoop();
    });
  }
}

function processVideoFrame(frameTime) {
  if (!isVideoReady || !handLandmarker) return;
  if (isOfflineAnalyzing) return; // オフライン動画解析中はカメラ推論を一時停止
  if (video.paused || video.ended || video.readyState < 2) return;
  if (isPredicting) return;
  isPredicting = true;

  try {
    updateCanvasResolution();

    const now = typeof frameTime === "number" && !isNaN(frameTime) ? frameTime : performance.now();
    const timestampMs = Math.max(now, lastVideoTimestamp + 1.0);
    lastVideoTimestamp = timestampMs;

    const results = handLandmarker.detectForVideo(video, timestampMs);
    canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

    if (results && results.landmarks && results.landmarks.length > 0) {
      const activeLabels = new Set();
      let maxRy = 0;
      let maxDy = 0;
      const cw = canvas.width;
      const ch = canvas.height;

      for (let i = 0; i < results.landmarks.length; i++) {
        const landmarks = results.landmarks[i];

        let handedness = "Right";
        if (results.handednesses?.[i]?.[0]) {
          handedness = results.handednesses[i][0].categoryName;
        } else {
          handedness = i === 0 ? "Right" : "Left";
        }
        activeLabels.add(handedness);

        const state = handTrackers[handedness];
        const trackResult = state.update(landmarks, timestampMs, cw, ch);

        if (datasetRecorder.isRecording) {
          datasetRecorder.recordFrame(handedness, landmarks, trackResult, timestampMs, cw, ch);
        }

        if (showTrackingLines) {
          drawPiarnoHand(landmarks, cw, ch, trackResult, state.tapState);
        }

        if (trackResult.ry > maxRy) maxRy = trackResult.ry;
        if (Math.abs(trackResult.dy) > maxDy) maxDy = Math.abs(trackResult.dy);
      }

      for (const label of ["Left", "Right"]) {
        if (!activeLabels.has(label)) {
          handTrackers[label].reset();
        }
      }

      if (hudAcc) hudAcc.textContent = `ry:${maxRy >= 0 ? "+" : ""}${maxRy.toFixed(2)}`;
      if (hudVel) hudVel.textContent = `dy:${maxDy.toFixed(1)}`;
    } else {
      handTrackers.Left.reset();
      handTrackers.Right.reset();
      if (hudAcc) hudAcc.textContent = "-";
      if (hudVel) hudVel.textContent = "-";
    }
  } catch (err) {
    console.error("[PREDICT] Frame error:", err);
  } finally {
    isPredicting = false;
  }
}

/**
 * 全5指・主動打鍵指先対応のPiarno骨格＆指先マーカー描画
 */
function drawPiarnoHand(landmarks, cw, ch, trackResult, tapState, ctx = canvasCtx) {
  if (!ctx || !landmarks || landmarks.length < 21) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // 背景色に埋もれないよう、黒シャドウを全体に適用
  ctx.shadowColor = "rgba(0, 0, 0, 0.85)";
  ctx.shadowBlur = 4;
  ctx.shadowOffsetX = 1;
  ctx.shadowOffsetY = 1;

  // 1. 手全体の骨格ライン描画（HAND_CONNECTIONS）
  ctx.strokeStyle = "rgba(255, 255, 255, 0.75)";
  ctx.lineWidth = 2.4;

  HAND_CONNECTIONS.forEach(([startIdx, endIdx]) => {
    const p1 = landmarks[startIdx];
    const p2 = landmarks[endIdx];
    ctx.beginPath();
    ctx.moveTo(p1.x * cw, p1.y * ch);
    ctx.lineTo(p2.x * cw, p2.y * ch);
    ctx.stroke();
  });

  // 2. 全関節点（白丸）
  landmarks.forEach((p) => {
    ctx.beginPath();
    ctx.arc(p.x * cw, p.y * ch, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
    ctx.fill();
  });

  const { smoothTips, leadTip, leadFinger } = trackResult;
  const isTouched = tapState === "TOUCHED";

  // 3. 全5指の指先に白丸マーカー描画
  if (smoothTips) {
    Object.entries(smoothTips).forEach(([k, pt]) => {
      if (k === leadFinger) return; // 主動指先は十字ターゲットマークで描画
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 5.0, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
    });
  }

  // 4. 主動打鍵指先（Lead Fingertip）にPiarno十字ターゲット丸マーク描画
  if (leadTip) {
    drawTipTargetMark(leadTip.x, leadTip.y, isTouched, ctx);
  }

  ctx.restore();
}

/**
 * Piarno完全準拠の指先十字ターゲット丸マーク描画
 * @param {number} x TIP X座標
 * @param {number} y TIP Y座標
 * @param {boolean} isTouched 机面接触中フラグ（白熱グロー表示）
 * @param {CanvasRenderingContext2D} ctx 描画先コンテキスト
 */
function drawTipTargetMark(x, y, isTouched = false, ctx = canvasCtx) {
  if (!ctx) return;
  ctx.save();

  if (isTouched) {
    ctx.shadowColor = "#ffffff";
    ctx.shadowBlur = 24;
  }

  // 外側のターゲットサークル
  const outerR = isTouched ? 14 : 10;
  ctx.beginPath();
  ctx.arc(x, y, outerR, 0, Math.PI * 2);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = isTouched ? 2.5 : 2.0;
  ctx.stroke();

  // 十字ターゲットインジケータ（水平・垂直線）
  const crossInner = isTouched ? 6 : 5;
  const crossOuter = isTouched ? 16 : 13;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  // 水平線
  ctx.moveTo(x - crossOuter, y);
  ctx.lineTo(x - crossInner, y);
  ctx.moveTo(x + crossInner, y);
  ctx.lineTo(x + crossOuter, y);
  // 垂直線
  ctx.moveTo(x, y - crossOuter);
  ctx.lineTo(x, y - crossInner);
  ctx.moveTo(x, y + crossInner);
  ctx.lineTo(x, y + crossOuter);
  ctx.stroke();

  // 中心ターゲット丸
  const centerR = isTouched ? 5.5 : 4.0;
  ctx.beginPath();
  ctx.arc(x, y, centerR, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();

  ctx.restore();
}

// ==========================================================================
// 10. イベントリスナーと初期化フロー
// ==========================================================================
async function unlockAudio() {
  if (audioStartOverlay) audioStartOverlay.classList.add("hidden");
  await drumEngine.init();
  drumEngine.playKick(1.1);
  updateHitBadge("AUDIO UNLOCKED", 1.0);
}

if (audioStartOverlay) audioStartOverlay.addEventListener("click", unlockAudio);
if (audioStartBtn) {
  audioStartBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    unlockAudio();
  });
}

if (testAudioBtn) {
  testAudioBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    await drumEngine.ensureRunning();
    drumEngine.playSnare(1.2);
    updateHitBadge("TEST SNARE", 1.2);
    if (audioStartOverlay) audioStartOverlay.classList.add("hidden");
  });
}

// 画面全体のタップでもオーディオアンロック & クリックでのドラムテスト発音
window.addEventListener("pointerdown", async (e) => {
  if (!drumEngine.isReady) {
    await unlockAudio();
  }

  if (e.target && typeof e.target.closest === "function" && (e.target.closest("button") || e.target.closest("nav"))) {
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const screenXRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / (rect.width || 1)));
  const screenYRatio = Math.max(0, Math.min(1, (e.clientY - rect.top) / (rect.height || 1)));
  const canvasX = (1 - screenXRatio) * canvas.width;
  const canvasY = screenYRatio * canvas.height;

  triggerDrumHit(canvasX, canvasY, 3200, canvas.width, canvas.height);
});

// トラッキングライン表示切替
if (toggleTrackingBtn) {
  toggleTrackingBtn.addEventListener("click", () => {
    showTrackingLines = !showTrackingLines;
    toggleTrackingBtn.classList.toggle("active", showTrackingLines);
  });
}

// カメラ再起動
if (refreshCameraBtn) {
  refreshCameraBtn.addEventListener("click", async () => {
    isVideoReady = false;
    isPredicting = false;
    lastVideoTimestamp = -1;
    handTrackers.Left.reset();
    handTrackers.Right.reset();
    await setupCamera();
  });
}

// フルスクリーン切替
if (fullscreenBtn) {
  fullscreenBtn.addEventListener("click", () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });
}

// 録画パネルの表示 / 非表示トグル
if (toggleRecorderBtn && recorderPanel) {
  toggleRecorderBtn.addEventListener("click", () => {
    const isHidden = recorderPanel.classList.toggle("hidden");
    toggleRecorderBtn.classList.toggle("active", !isHidden);
  });
}

// 録画開始 / 停止ボタン
if (recActionBtn) {
  recActionBtn.addEventListener("click", () => {
    datasetRecorder.toggle();
  });
}

// CSVダウンロードボタン
if (recDownloadBtn) {
  recDownloadBtn.addEventListener("click", () => {
    datasetRecorder.downloadCsv();
  });
}

// セグメントボタン
recSegBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const sessionType = btn.dataset.type;
    const targetHand = btn.dataset.hand;

    if (sessionType) {
      document.querySelectorAll(".rec-seg-btn[data-type]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      datasetRecorder.sessionType = sessionType;
      updateHitBadge(`MODE: ${sessionType.toUpperCase()}`, 1.0);
    } else if (targetHand) {
      document.querySelectorAll(".rec-seg-btn[data-hand]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      datasetRecorder.targetHand = targetHand;
      updateHitBadge(`HAND: ${targetHand.toUpperCase()}`, 1.0);
    }
  });
});

// キーボードショートカット操作
window.addEventListener("keydown", (e) => {
  if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;

  if (e.code === "KeyR" && !e.repeat) {
    e.preventDefault();
    datasetRecorder.toggle();
  } else if (e.code === "Space") {
    e.preventDefault();
    datasetRecorder.isSpacePressed = true;
    if (datasetRecorder.isRecording) {
      datasetRecorder.hitCount++;
      datasetRecorder.flashHitUi();
    }
  } else if (e.code === "Digit1") {
    const btn = document.querySelector('.rec-seg-btn[data-type="tap"]');
    if (btn) btn.click();
  } else if (e.code === "Digit2") {
    const btn = document.querySelector('.rec-seg-btn[data-type="neg_air"]');
    if (btn) btn.click();
  } else if (e.code === "Digit3") {
    const btn = document.querySelector('.rec-seg-btn[data-type="neg_idle"]');
    if (btn) btn.click();
  } else if (e.code === "Digit4") {
    const btn = document.querySelector('.rec-seg-btn[data-type="neg_wrist"]');
    if (btn) btn.click();
  }
});

window.addEventListener("keyup", (e) => {
  if (e.code === "Space") {
    datasetRecorder.isSpacePressed = false;
  }
});

// アノテーションスタジオ起動（ナビゲーションボタン）
if (toggleAnalyzerBtn && videoFileInput) {
  toggleAnalyzerBtn.addEventListener("click", () => {
    videoFileInput.click();
  });
}

// 別動画を開くボタン
if (studioOpenFileBtn && videoFileInput) {
  studioOpenFileBtn.addEventListener("click", () => {
    videoFileInput.click();
  });
}

// ファイル選択時のスタジオオープン
if (videoFileInput) {
  videoFileInput.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) {
      annotationStudioController.openStudio(file);
    }
    videoFileInput.value = ""; // 同一ファイルを再選択可能にする
  });
}

// スタジオを閉じる
if (studioCloseBtn) {
  studioCloseBtn.addEventListener("click", () => {
    annotationStudioController.closeStudio();
  });
}

// 再生 / 一時停止
if (studioPlayBtn) {
  studioPlayBtn.addEventListener("click", () => {
    annotationStudioController.togglePlay();
  });
}

// コマ送り / コマ戻しボタン
if (studioStepBackBtn) {
  studioStepBackBtn.addEventListener("click", () => {
    annotationStudioController.step(-1);
  });
}

if (studioStepFwdBtn) {
  studioStepFwdBtn.addEventListener("click", () => {
    annotationStudioController.step(1);
  });
}

if (studioStepBack5Btn) {
  studioStepBack5Btn.addEventListener("click", () => {
    annotationStudioController.step(-5);
  });
}

if (studioStepFwd5Btn) {
  studioStepFwd5Btn.addEventListener("click", () => {
    annotationStudioController.step(5);
  });
}

// HITマーカー設置ボタン
if (studioMarkHitBtn) {
  studioMarkHitBtn.addEventListener("click", () => {
    annotationStudioController.toggleHitMarker();
  });
}

// 全マーカー消去
if (studioClearMarkersBtn) {
  studioClearMarkersBtn.addEventListener("click", () => {
    annotationStudioController.clearAllMarkers();
  });
}

// CSVエクスポート
if (studioExportCsvBtn) {
  studioExportCsvBtn.addEventListener("click", () => {
    annotationStudioController.exportCsv();
  });
}

// 鏡像反転（FLIP）トグル
if (studioFlipBtn) {
  studioFlipBtn.addEventListener("click", () => {
    annotationStudioController.toggleFlip();
  });
}

// 骨格ライン表示切替
if (studioToggleTrackBtn) {
  studioToggleTrackBtn.addEventListener("click", () => {
    annotationStudioController.toggleSkeleton();
  });
}

// 再生速度切替
studioSpeedBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const spd = parseFloat(btn.dataset.speed) || 1.0;
    annotationStudioController.setSpeed(spd);
  });
});

// タイムラインのクリック ＆ ドラッグシーク
let isTimelineDragging = false;
function handleTimelinePointer(e) {
  if (!timelineTrack || !annotationStudioController.file || annotationStudioController.totalFrames <= 0) return;
  const rect = timelineTrack.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const targetFrame = Math.round(ratio * (annotationStudioController.totalFrames - 1));
  annotationStudioController.seekToFrame(targetFrame);
}

if (timelineTrack) {
  timelineTrack.addEventListener("pointerdown", (e) => {
    isTimelineDragging = true;
    annotationStudioController.pause();
    handleTimelinePointer(e);
  });
  window.addEventListener("pointermove", (e) => {
    if (isTimelineDragging) handleTimelinePointer(e);
  });
  window.addEventListener("pointerup", () => {
    isTimelineDragging = false;
  });
}

// 動画ファイルのドラッグ＆ドロップ受け入れ
window.addEventListener("dragover", (e) => {
  e.preventDefault();
});

window.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file && (file.type.startsWith("video/") || file.name.endsWith(".webm") || file.name.endsWith(".mp4"))) {
    annotationStudioController.openStudio(file);
  }
});

// スタジオアクティブ時のキーボードショートカット
window.addEventListener("keydown", (e) => {
  const isStudioOpen = annotationStudio && !annotationStudio.classList.contains("hidden");
  if (!isStudioOpen) return;
  if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;

  if (e.code === "Space") {
    e.preventDefault();
    e.stopPropagation();
    annotationStudioController.togglePlay();
  } else if (e.code === "ArrowLeft") {
    e.preventDefault();
    annotationStudioController.step(e.shiftKey ? -5 : -1);
  } else if (e.code === "ArrowRight") {
    e.preventDefault();
    annotationStudioController.step(e.shiftKey ? 5 : 1);
  } else if (e.code === "KeyH" || e.code === "KeyM") {
    e.preventDefault();
    annotationStudioController.toggleHitMarker();
  } else if (e.code === "KeyF") {
    e.preventDefault();
    annotationStudioController.toggleFlip();
  } else if (e.code === "Escape") {
    e.preventDefault();
    annotationStudioController.closeStudio();
  }
}, true);

// デバッグ用グローバル参照
window.triggerDrumHit = triggerDrumHit;
window.drumEngine = drumEngine;
window.datasetRecorder = datasetRecorder;
window.annotationStudioController = annotationStudioController;

// アプリケーション起動
async function main() {
  await loadPiarnoDataset();
  await setupHandLandmarker();
  await setupCamera();
  schedulePredictLoop();
}

main();
