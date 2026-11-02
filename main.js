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
let hitRyThreshold = 0.58;   // 沈み込み打鍵閾値 ry
let liftRyThreshold = 0.38;  // リフト復帰閾値 ry
const MIN_COOLDOWN_MS = 60;  // チャタリング防止クールダウン

/**
 * Piarnoデータセットからの閾値最適化
 */
async function loadPiarnoDataset() {
  try {
    let res = await fetch("./dataset/manifest.json");
    if (!res.ok) res = await fetch("/dataset/manifest.json");
    if (!res.ok) return;

    const manifest = await res.json();
    let files = [];
    if (Array.isArray(manifest)) files = manifest;
    else if (manifest?.files) files = manifest.files;
    else if (manifest?.fingers) files = Object.values(manifest.fingers).flat();

    const hitRys = [];
    for (const f of files.slice(0, 8)) {
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
          if (!isNaN(ryVal) && isHit) {
            hitRys.push(ryVal);
          }
        }
      } catch (e) {}
    }

    if (hitRys.length > 0) {
      hitRys.sort((a, b) => a - b);
      const median = hitRys[Math.floor(hitRys.length * 0.5)];
      hitRyThreshold = Math.max(0.45, Math.min(0.75, median * 0.88));
      liftRyThreshold = hitRyThreshold * 0.62;
      console.log(`[DATASET] Optimized thresholds: hitRy=${hitRyThreshold.toFixed(2)}, liftRy=${liftRyThreshold.toFixed(2)}`);
    }
  } catch (err) {
    console.warn("[DATASET] Using default biomechanical thresholds:", err);
  }
}

// ==========================================================================
// 5. 左右の手のトラッカーステート（Piarno準拠 独立PointFilter & ry打鍵検知）
// ==========================================================================
class HandTrackerState {
  constructor(name) {
    this.name = name; // "Left" または "Right"
    this.tapState = "IDLE"; // "IDLE" または "TOUCHED"
    this.lastHitTime = 0;

    // Piarnoと同じく人差し指の各関節独立PointFilter（1.5, 0.01）
    this.filters = {
      wrist: new PointFilter(1.5, 0.01),
      mcp: new PointFilter(1.5, 0.01),
      pip: new PointFilter(1.5, 0.01),
      dip: new PointFilter(1.5, 0.01),
      tip: new PointFilter(1.5, 0.01)
    };

    this.prevTipY = null;
    this.prevPrevTipY = null;
  }

  reset() {
    this.tapState = "IDLE";
    this.lastHitTime = 0;
    this.prevTipY = null;
    this.prevPrevTipY = null;
    Object.values(this.filters).forEach((f) => f.reset());
  }

  /**
   * 手のランドマークを処理し、Piarnoの平滑化座標と打鍵判定を計算
   */
  update(landmarks, timestampMs, cw, ch) {
    const rawWrist = { x: landmarks[0].x * cw, y: landmarks[0].y * ch };
    const rawMcp = { x: landmarks[5].x * cw, y: landmarks[5].y * ch };
    const rawPip = { x: landmarks[6].x * cw, y: landmarks[6].y * ch };
    const rawDip = { x: landmarks[7].x * cw, y: landmarks[7].y * ch };
    const rawTip = { x: landmarks[8].x * cw, y: landmarks[8].y * ch };

    // 各関節独立 1 Euro Filter 平滑化
    const smoothWrist = this.filters.wrist.filter(rawWrist.x, rawWrist.y, timestampMs);
    const smoothMcp = this.filters.mcp.filter(rawMcp.x, rawMcp.y, timestampMs);
    const smoothPip = this.filters.pip.filter(rawPip.x, rawPip.y, timestampMs);
    const smoothDip = this.filters.dip.filter(rawDip.x, rawDip.y, timestampMs);
    const smoothTip = this.filters.tip.filter(rawTip.x, rawTip.y, timestampMs);

    // 手の3D基準長 L（手首〜人差し指MCP間）
    const dx05 = landmarks[5].x - landmarks[0].x;
    const dy05 = landmarks[5].y - landmarks[0].y;
    const dz05 = (landmarks[5].z ?? 0) - (landmarks[0].z ?? 0);
    const L = Math.hypot(dx05, dy05, dz05) || 0.001;

    // Piarnoの相対沈み込み変位 ry（TIPのY - MCPのY）/ (画面高さ * L)
    const ry = (smoothTip.y - smoothMcp.y) / (ch * L);
    const rawRy = (landmarks[8].y - landmarks[5].y) / L;

    // 垂直移動速度（下降・最下点反転検知用）
    let dy = 0;
    let prevDy = 0;
    if (this.prevTipY !== null) {
      dy = smoothTip.y - this.prevTipY;
      if (this.prevPrevTipY !== null) {
        prevDy = this.prevTipY - this.prevPrevTipY;
      }
    }

    const now = performance.now();
    let isHit = false;

    // 【Piarno 1D方式 + 机面衝突ピーク急停止による打鍵判定】
    if (this.tapState === "IDLE") {
      // 1. 相対沈み込み ry が閾値を超過
      const isRyThresholdPassed = ry >= hitRyThreshold && rawRy >= hitRyThreshold * 0.90;
      // 2. 振り下ろし動作（直前フレームで下向き移動）から机面に衝突して減速/停止した（dy <= 1.2px）
      const isBottomReached = prevDy >= 0.8 && dy <= 1.2;

      // ryが十分に深く入った場合、または沈み込み＋最下点停止が揃った瞬間に打鍵発音
      if ((isRyThresholdPassed || (ry >= hitRyThreshold * 0.85 && isBottomReached)) &&
          now - this.lastHitTime >= MIN_COOLDOWN_MS) {
        this.tapState = "TOUCHED";
        this.lastHitTime = now;
        isHit = true;

        // 打鍵強度ダイナミクス
        const intensity = Math.min(1.4, Math.max(0.7, 0.75 + (ry - hitRyThreshold) * 0.8 + prevDy * 0.05));
        triggerDrumHit(smoothTip.x, smoothTip.y, intensity * 3500, cw, ch);
      }
    } else if (this.tapState === "TOUCHED") {
      // 指が持ち上がった（リフト）、または沈み込みが復帰閾値以下になった時
      if (ry < liftRyThreshold || dy < -1.5) {
        this.tapState = "IDLE";
      }
    }

    this.prevPrevTipY = this.prevTipY;
    this.prevTipY = smoothTip.y;

    return {
      smoothWrist,
      smoothMcp,
      smoothPip,
      smoothDip,
      smoothTip,
      ry,
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
 * Piarno完全準拠の骨格＆指先マーカー描画
 */
function drawPiarnoHand(landmarks, cw, ch, trackResult, tapState) {
  canvasCtx.save();
  canvasCtx.lineCap = "round";
  canvasCtx.lineJoin = "round";

  // 1. 他の指・手のひら（Piarnoと同じく極めて薄いグレースケールで描画）
  canvasCtx.strokeStyle = "rgba(255, 255, 255, 0.12)";
  canvasCtx.lineWidth = 1;

  OTHER_CONNECTIONS.forEach(([startIdx, endIdx]) => {
    const p1 = landmarks[startIdx];
    const p2 = landmarks[endIdx];
    canvasCtx.beginPath();
    canvasCtx.moveTo(p1.x * cw, p1.y * ch);
    canvasCtx.lineTo(p2.x * cw, p2.y * ch);
    canvasCtx.stroke();
  });

  // 人差し指以外の関節点（極小薄グレー）
  landmarks.forEach((p, idx) => {
    if (INDEX_LANDMARK_INDICES.includes(idx)) return;
    canvasCtx.beginPath();
    canvasCtx.arc(p.x * cw, p.y * ch, 2, 0, Math.PI * 2);
    canvasCtx.fillStyle = "rgba(255, 255, 255, 0.15)";
    canvasCtx.fill();
  });

  const { smoothMcp, smoothPip, smoothDip, smoothTip } = trackResult;

  // 2. 人差し指の骨格ライン（ブレのない独立PointFilter平滑化ライン）
  canvasCtx.strokeStyle = "#ffffff";
  canvasCtx.lineWidth = 3;
  canvasCtx.beginPath();
  canvasCtx.moveTo(smoothMcp.x, smoothMcp.y);
  canvasCtx.lineTo(smoothPip.x, smoothPip.y);
  canvasCtx.lineTo(smoothDip.x, smoothDip.y);
  canvasCtx.lineTo(smoothTip.x, smoothTip.y);
  canvasCtx.stroke();

  // 3. 人差し指関節点（5: MCP, 6: PIP, 7: DIP）白丸
  [smoothMcp, smoothPip, smoothDip].forEach((pt) => {
    canvasCtx.beginPath();
    canvasCtx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
    canvasCtx.fillStyle = "#ffffff";
    canvasCtx.fill();
  });

  // 4. 人差し指先端（TIP: Landmark 8）のPiarno十字ターゲット丸マーク描画
  const isTouched = tapState === "TOUCHED";
  drawTipTargetMark(smoothTip.x, smoothTip.y, isTouched);

  canvasCtx.restore();
}

/**
 * Piarno完全準拠の指先十字ターゲット丸マーク描画
 * @param {number} x TIP X座標
 * @param {number} y TIP Y座標
 * @param {boolean} isTouched 机面接触中フラグ（白熱グロー表示）
 */
function drawTipTargetMark(x, y, isTouched = false) {
  canvasCtx.save();

  if (isTouched) {
    canvasCtx.shadowColor = "#ffffff";
    canvasCtx.shadowBlur = 24;
  }

  // 外側のターゲットサークル
  const outerR = isTouched ? 13 : 9;
  canvasCtx.beginPath();
  canvasCtx.arc(x, y, outerR, 0, Math.PI * 2);
  canvasCtx.strokeStyle = "#ffffff";
  canvasCtx.lineWidth = isTouched ? 2.5 : 2.0;
  canvasCtx.stroke();

  // 十字ターゲットインジケータ（水平・垂直線）
  const crossInner = isTouched ? 6 : 5;
  const crossOuter = isTouched ? 16 : 13;
  canvasCtx.strokeStyle = "#ffffff";
  canvasCtx.lineWidth = 1.5;
  canvasCtx.beginPath();
  // 水平線
  canvasCtx.moveTo(x - crossOuter, y);
  canvasCtx.lineTo(x - crossInner, y);
  canvasCtx.moveTo(x + crossInner, y);
  canvasCtx.lineTo(x + crossOuter, y);
  // 垂直線
  canvasCtx.moveTo(x, y - crossOuter);
  canvasCtx.lineTo(x, y - crossInner);
  canvasCtx.moveTo(x, y + crossInner);
  canvasCtx.lineTo(x, y + crossOuter);
  canvasCtx.stroke();

  // 中心ターゲット丸
  const centerR = isTouched ? 5.0 : 3.5;
  canvasCtx.beginPath();
  canvasCtx.arc(x, y, centerR, 0, Math.PI * 2);
  canvasCtx.fillStyle = "#ffffff";
  canvasCtx.fill();

  canvasCtx.restore();
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

// デバッグ用グローバル参照
window.triggerDrumHit = triggerDrumHit;
window.drumEngine = drumEngine;
window.datasetRecorder = datasetRecorder;

// アプリケーション起動
async function main() {
  await loadPiarnoDataset();
  await setupHandLandmarker();
  await setupCamera();
  schedulePredictLoop();
}

main();
