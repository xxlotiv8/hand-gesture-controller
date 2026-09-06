const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const cameraShell = document.querySelector(".camera-shell");
const ctx = overlay.getContext("2d");
const cursor = document.getElementById("cursor");
const clickFlash = document.getElementById("clickFlash");
const startButton = document.getElementById("startButton");
const cameraStatus = document.getElementById("cameraStatus");
const handStatus = document.getElementById("handStatus");
const cameraDot = document.getElementById("cameraDot");
const handDot = document.getElementById("handDot");
const pointerX = document.getElementById("pointerX");
const pointerY = document.getElementById("pointerY");
const pinchDistance = document.getElementById("pinchDistance");
const bridgeStatus = document.getElementById("bridgeStatus");
const mirrorPreview = document.getElementById("mirrorPreview");
const sensitivity = document.getElementById("sensitivity");
const sensitivityValue = document.getElementById("sensitivityValue");
const activeGain = document.getElementById("activeGain");

let camera;
let smoothedX = 0.5;
let smoothedY = 0.5;
let seenHand = false;
let pinchHeld = false;
let bridgeOnline = false;
let lastBridgeSend = 0;
let previewMirrored = false;
let lastCursorX = 0.5;
let lastCursorY = 0.5;
let lastThumbX = 0.5;
let lastThumbY = 0.5;
let lastThumbAt = performance.now();
let thumbTrackingInitialized = false;

const BRIDGE_URL = "http://127.0.0.1:8765/event";
let cursorGain = Number(sensitivity.value);
const PINCH_DOWN_THRESHOLD = 0.025;
const PINCH_UP_THRESHOLD = 0.05;
const THUMB_DEAD_ZONE = 0.0018;
const MIN_SMOOTHING = 0.1;
const MAX_SMOOTHING = 0.5;
const MAX_SPEED_BOOST = 1.5;
const SPEED_ACCELERATION = 3.5;

function resizeCanvas() {
  const rect = video.getBoundingClientRect();
  overlay.width = Math.round(rect.width * window.devicePixelRatio);
  overlay.height = Math.round(rect.height * window.devicePixelRatio);
}

function triggerLocalClick(x, y) {
  const el = document.elementFromPoint(x, y);
  if (el) {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
  }

  clickFlash.style.left = `${x}px`;
  clickFlash.style.top = `${y}px`;
  clickFlash.animate(
    [{ opacity: 0.95, transform: "translate(-50%, -50%) scale(1)" }, { opacity: 0, transform: "translate(-50%, -50%) scale(16)" }],
    { duration: 260, easing: "ease-out" }
  );
}

async function sendMouseEvent(type, x, y) {
  if (!bridgeOnline && type === "move") return;

  try {
    const response = await fetch(BRIDGE_URL, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, x, y }),
      keepalive: type !== "move",
    });
    if (!response.ok) throw new Error(`Bridge returned ${response.status}`);
    bridgeOnline = true;
    bridgeStatus.textContent = "System cursor bridge: connected";
  } catch {
    bridgeOnline = false;
    bridgeStatus.textContent = "System cursor bridge: run ./gesture-mouse-helper";
  }
}

async function checkBridge() {
  try {
    const response = await fetch("http://127.0.0.1:8765/status");
    const status = await response.json();
    bridgeOnline = status.accessibility === true;
    bridgeStatus.textContent = bridgeOnline
      ? "System cursor bridge: connected"
      : "System cursor bridge: Accessibility permission required";
  } catch {
    bridgeOnline = false;
    bridgeStatus.textContent = "System cursor bridge: run ./gesture-mouse-helper";
  }
}

function updateMouse(x, y, pinch) {
  const now = performance.now();
  const isPinching = pinchHeld ? pinch < PINCH_UP_THRESHOLD : pinch < PINCH_DOWN_THRESHOLD;
  if (now - lastBridgeSend > 20 || isPinching !== pinchHeld) {
    lastBridgeSend = now;
    sendMouseEvent("move", x, y);
  }

  if (isPinching && !pinchHeld) {
    pinchHeld = true;
    triggerLocalClick(x, y);
    sendMouseEvent("down", x, y);
  } else if (!isPinching && pinchHeld) {
    pinchHeld = false;
    sendMouseEvent("up", x, y);
  }
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function smoothThumbPosition(thumbTip) {
  const now = performance.now();
  if (!thumbTrackingInitialized) {
    smoothedX = thumbTip.x;
    smoothedY = thumbTip.y;
    lastThumbX = thumbTip.x;
    lastThumbY = thumbTip.y;
    lastThumbAt = now;
    thumbTrackingInitialized = true;
    return { deltaX: 0, deltaY: 0, gain: cursorGain };
  }

  const elapsed = Math.max(1, now - lastThumbAt);
  const rawDistance = Math.hypot(thumbTip.x - lastThumbX, thumbTip.y - lastThumbY);
  const thumbSpeed = Math.max(0, rawDistance - THUMB_DEAD_ZONE) / elapsed * 1000;
  const distance = Math.hypot(thumbTip.x - smoothedX, thumbTip.y - smoothedY);
  const previousX = smoothedX;
  const previousY = smoothedY;

  if (distance > THUMB_DEAD_ZONE) {
    const smoothing = Math.min(MAX_SMOOTHING, MIN_SMOOTHING + distance * 6);
    smoothedX += (thumbTip.x - smoothedX) * smoothing;
    smoothedY += (thumbTip.y - smoothedY) * smoothing;
  }

  lastThumbX = thumbTip.x;
  lastThumbY = thumbTip.y;
  lastThumbAt = now;

  // Slow movement stays precise; fast movement expands the reachable screen area.
  return {
    deltaX: smoothedX - previousX,
    deltaY: smoothedY - previousY,
    gain: cursorGain * (1 + Math.min(MAX_SPEED_BOOST, thumbSpeed * SPEED_ACCELERATION)),
  };
}

function drawHandOverlay(landmarks) {
  const width = overlay.width;
  const height = overlay.height;
  ctx.clearRect(0, 0, width, height);

  window.drawConnectors(ctx, landmarks, HAND_CONNECTIONS, { color: "rgba(100, 210, 255, 0.85)", lineWidth: 4 });
  window.drawLandmarks(ctx, landmarks, { color: "rgba(255, 255, 255, 0.9)", lineWidth: 2, radius: 4 });
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    cameraStatus.textContent = "Camera not supported";
    cameraDot.style.background = "var(--danger)";
    return;
  }

  const hands = new Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
  });

  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    selfieMode: false,
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.6,
  });

  hands.onResults((results) => {
    resizeCanvas();
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    if (!results.multiHandLandmarks?.length) {
      if (pinchHeld) {
        pinchHeld = false;
        sendMouseEvent("up", lastCursorX, lastCursorY);
      }
      thumbTrackingInitialized = false;
      seenHand = false;
      handStatus.textContent = "Waiting for hand";
      handDot.style.background = "var(--danger)";
      cursor.style.opacity = "0";
      return;
    }

    const landmarks = results.multiHandLandmarks[0];
    seenHand = true;
    handStatus.textContent = "Hand tracked";
    handDot.style.background = "var(--success)";
    drawHandOverlay(landmarks);

    const indexTip = landmarks[8];
    const thumbTip = landmarks[4];
    const dx = indexTip.x - thumbTip.x;
    const dy = indexTip.y - thumbTip.y;
    const pinch = Math.hypot(dx, dy);

    const thumbMotion = smoothThumbPosition(thumbTip);
    activeGain.textContent = `${thumbMotion.gain.toFixed(2)}x`;

    const rect = video.getBoundingClientRect();
    lastCursorX = clamp(lastCursorX + (previewMirrored ? -thumbMotion.deltaX : thumbMotion.deltaX) * thumbMotion.gain);
    lastCursorY = clamp(lastCursorY + thumbMotion.deltaY * thumbMotion.gain);
    const pointerRatioX = lastCursorX;
    const x = rect.left + pointerRatioX * rect.width;
    const y = rect.top + lastCursorY * rect.height;

    cursor.style.left = `${x}px`;
    cursor.style.top = `${y}px`;
    cursor.style.opacity = "1";

    pointerX.textContent = x.toFixed(0);
    pointerY.textContent = y.toFixed(0);
    pinchDistance.textContent = pinch.toFixed(3);

    updateMouse(pointerRatioX, lastCursorY, pinch);
  });

  camera = new Camera(video, {
    onFrame: async () => {
      await hands.send({ image: video });
    },
    width: 1280,
    height: 800,
  });

  try {
    await camera.start();
    resizeCanvas();
    cameraStatus.textContent = "Camera running";
    cameraDot.style.background = "var(--success)";
  } catch (error) {
    console.error(error);
    cameraStatus.textContent = "Camera permission denied";
    cameraDot.style.background = "var(--danger)";
  }
}

startButton.addEventListener("click", startCamera);
window.addEventListener("resize", resizeCanvas);
mirrorPreview.addEventListener("change", () => {
  previewMirrored = mirrorPreview.checked;
  cameraShell.classList.toggle("is-mirrored", previewMirrored);
});
sensitivity.addEventListener("input", () => {
  cursorGain = Number(sensitivity.value);
  sensitivityValue.textContent = `${cursorGain.toFixed(2)}x base`;
  activeGain.textContent = `${cursorGain.toFixed(2)}x`;
});

checkBridge();
