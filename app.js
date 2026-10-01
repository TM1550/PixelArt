import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getDatabase, ref, set, get, onValue }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// === КОНФИГ ===
// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyBb8SFdz4CHRuIz1qwpcbyN4Zpfg3stdlo",
  authDomain: "pixelart-e69d7.firebaseapp.com",
  databaseURL: "https://pixelart-e69d7-default-rtdb.firebaseio.com",
  projectId: "pixelart-e69d7",
  storageBucket: "pixelart-e69d7.firebasestorage.app",
  messagingSenderId: "137587995053",
  appId: "1:137587995053:web:f3fc80bc9674990b927124"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// ============================================================
// НАСТРОЙКИ
// ============================================================
const GRID_SIZE = 400;
const COOLDOWN_MS = 2000;

// Сколько настоящих пикселей канваса приходится на 1 пиксель поля.
// Это ключевой фикс для мобильных: раньше было 1, из-за чего при
// уменьшении субпиксельные квадраты исчезали.
const PIXEL_SCALE = GRID_SIZE <= 500 ? 4 : 2;
const CANVAS_W = GRID_SIZE * PIXEL_SCALE;
const CANVAS_H = GRID_SIZE * PIXEL_SCALE;

// === ЛИМИТЫ ЗУМА ===
// Выражены в «экранных пикселях на один пиксель поля» — интуитивно понятны.
// Изменяй эти две константы, чтобы настроить границы приближения.
const MIN_PIXEL_SCREEN = 0.5;   // 1 пиксель поля занимает минимум 0.5 экранного пикселя
const MAX_PIXEL_SCREEN = 60;    // ...и максимум 60 экранных пикселей (сильно приближено)

const MIN_SCALE = MIN_PIXEL_SCREEN / PIXEL_SCALE;
const MAX_SCALE = MAX_PIXEL_SCREEN / PIXEL_SCALE;

const COLORS = [
  "#000000", "#FFFFFF", "#FF0000", "#00FF00",
  "#0000FF", "#FFFF00", "#FF00FF", "#00FFFF",
  "#FF8000", "#8000FF", "#008000", "#800000",
  "#008080", "#800080", "#C0C0C0", "#808080"
];

// === СОСТОЯНИЕ ===
let currentUser = null;
let selectedColor = 0;
let userNick = "";
let lastPaintTime = 0;
let pixelCache = {};

const container = document.getElementById("canvas-container");
const canvas = document.getElementById("pixel-canvas");
const ctx = canvas.getContext("2d");
const tooltip = document.getElementById("tooltip");
const zoomLabel = document.getElementById("zoom-label");
const cursorPosEl = document.getElementById("cursor-pos");
const fieldSizeEl = document.getElementById("field-size");

canvas.width = CANVAS_W;
canvas.height = CANVAS_H;

fieldSizeEl.textContent = `Поле: ${GRID_SIZE} × ${GRID_SIZE} (${GRID_SIZE * GRID_SIZE} пикс.)`;

// ============================================================
// ОТРИСОВКА
// ============================================================
function drawPixel(x, y, colorIndex) {
  ctx.fillStyle = COLORS[colorIndex];
  ctx.fillRect(x * PIXEL_SCALE, y * PIXEL_SCALE, PIXEL_SCALE, PIXEL_SCALE);
}

function clearCanvas() {
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
}

// ============================================================
// ЗУМ И ПАН
// ============================================================
let scale = 1;
let offsetX = 0;
let offsetY = 0;
let initialized = false;

function applyTransform() {
  canvas.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
  // Показываем масштаб относительно «как в поле»: сколько экранных пикселей на пиксель поля
  const px = scale * PIXEL_SCALE;
  zoomLabel.textContent = `${px < 1 ? px.toFixed(2) : Math.round(px)}px`;
}

function clampScale(s) {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
}

function fitToScreen() {
  const cw = container.clientWidth;
  const ch = container.clientHeight;
  if (!cw || !ch) return false;

  // Немного запаса (0.95), чтобы поле не касалось краёв
  const fit = Math.min(cw / CANVAS_W, ch / CANVAS_H) * 0.95;
  scale = clampScale(fit);
  offsetX = (cw - CANVAS_W * scale) / 2;
  offsetY = (ch - CANVAS_H * scale) / 2;
  applyTransform();
  return true;
}

function zoomAt(px, py, factor) {
  const newScale = clampScale(scale * factor);
  const actual = newScale / scale;
  offsetX = px - (px - offsetX) * actual;
  offsetY = py - (py - offsetY) * actual;
  scale = newScale;
  applyTransform();
}

// --- Колесо мыши / трекпад ---
container.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = container.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const sensitivity = e.ctrlKey ? 0.01 : 0.002;
  const factor = Math.exp(-e.deltaY * sensitivity);
  zoomAt(px, py, factor);
}, { passive: false });

// --- Кнопки ---
document.getElementById("zoom-in").addEventListener("click", () => {
  zoomAt(container.clientWidth / 2, container.clientHeight / 2, 1.5);
});
document.getElementById("zoom-out").addEventListener("click", () => {
  zoomAt(container.clientWidth / 2, container.clientHeight / 2, 1 / 1.5);
});
document.getElementById("fit-screen").addEventListener("click", fitToScreen);

// ============================================================
// УКАЗАТЕЛИ
// ============================================================
const pointers = new Map();
let pointerDownInfo = null;
let isDragging = false;
let dragStartX = 0, dragStartY = 0;
let startOffsetX = 0, startOffsetY = 0;
let pinchStartDist = 0;
let pinchStartScale = 1;
let pinchCenter = { x: 0, y: 0 };

container.addEventListener("pointerdown", (e) => {
  try { container.setPointerCapture(e.pointerId); } catch {}
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 1) {
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    startOffsetX = offsetX;
    startOffsetY = offsetY;
    pointerDownInfo = { x: e.clientX, y: e.clientY, time: Date.now(), id: e.pointerId };
    container.classList.add("dragging");
  } else if (pointers.size === 2) {
    isDragging = false;
    pointerDownInfo = null;
    const pts = [...pointers.values()];
    pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    pinchStartScale = scale;
    const rect = container.getBoundingClientRect();
    pinchCenter = {
      x: (pts[0].x + pts[1].x) / 2 - rect.left,
      y: (pts[0].y + pts[1].y) / 2 - rect.top
    };
  }
});

container.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) {
    updateCursorPos(e);
    return;
  }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 1 && isDragging) {
    offsetX = startOffsetX + (e.clientX - dragStartX);
    offsetY = startOffsetY + (e.clientY - dragStartY);
    applyTransform();
  } else if (pointers.size === 2) {
    const pts = [...pointers.values()];
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const targetScale = clampScale(pinchStartScale * (dist / pinchStartDist));
    const factor = targetScale / scale;
    offsetX = pinchCenter.x - (pinchCenter.x - offsetX) * factor;
    offsetY = pinchCenter.y - (pinchCenter.y - offsetY) * factor;
    scale = targetScale;
    applyTransform();
  }
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  try { container.releasePointerCapture(e.pointerId); } catch {}

  if (pointers.size === 0) {
    isDragging = false;
    container.classList.remove("dragging");
    if (pointerDownInfo && pointerDownInfo.id === e.pointerId) {
      const dx = e.clientX - pointerDownInfo.x;
      const dy = e.clientY - pointerDownInfo.y;
      const dt = Date.now() - pointerDownInfo.time;
      if (Math.hypot(dx, dy) < 6 && dt < 600) {
        handleCanvasClick(e);
      }
      pointerDownInfo = null;
    }
  } else if (pointers.size === 1) {
    isDragging = true;
    const p = [...pointers.values()][0];
    dragStartX = p.x;
    dragStartY = p.y;
    startOffsetX = offsetX;
    startOffsetY = offsetY;
    pointerDownInfo = null;
  }
}

container.addEventListener("pointerup", endPointer);
container.addEventListener("pointercancel", endPointer);

// ============================================================
// КООРДИНАТЫ
// ============================================================
function clientToPixel(clientX, clientY) {
  const rect = container.getBoundingClientRect();
  // Экранные пиксели на пиксель поля = scale * PIXEL_SCALE
  const perPixel = scale * PIXEL_SCALE;
  const x = Math.floor((clientX - rect.left - offsetX) / perPixel);
  const y = Math.floor((clientY - rect.top - offsetY) / perPixel);
  return { x, y };
}

function updateCursorPos(e) {
  const { x, y } = clientToPixel(e.clientX, e.clientY);
  cursorPosEl.textContent = (x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE)
    ? `Курсор: (${x}, ${y})`
    : "Курсор: —";
}

container.addEventListener("mousemove", (e) => {
  updateCursorPos(e);

  const { x, y } = clientToPixel(e.clientX, e.clientY);
  if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) {
    tooltip.style.display = "none";
    return;
  }
  const key = `${x}_${y}`;
  if (pixelCache[key]) {
    const rect = container.getBoundingClientRect();
    tooltip.style.display = "block";
    tooltip.textContent = `${pixelCache[key].nick} (${x}, ${y})`;
    tooltip.style.left = (e.clientX - rect.left + 14) + "px";
    tooltip.style.top = (e.clientY - rect.top + 14) + "px";
  } else {
    tooltip.style.display = "none";
  }
});

container.addEventListener("mouseleave", () => {
  tooltip.style.display = "none";
  cursorPosEl.textContent = "Курсор: —";
});

// ============================================================
// АВТОРИЗАЦИЯ
// ============================================================
const googleLoginBtn = document.getElementById("google-login");
const userInfo = document.getElementById("user-info");
const userAvatar = document.getElementById("user-avatar");
const nickInput = document.getElementById("nick-input");
const saveNickBtn = document.getElementById("save-nick");
const cooldownStatus = document.getElementById("cooldown-status");

googleLoginBtn.addEventListener("click", async () => {
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    console.error("Ошибка входа:", e);
  }
});

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (user) {
    googleLoginBtn.style.display = "none";
    userInfo.style.display = "flex";
    userAvatar.src = user.photoURL || "";
    userAvatar.alt = user.displayName || "";

    const nickSnap = await get(ref(db, `nicks/${user.uid}`));
    if (nickSnap.exists()) {
      userNick = nickSnap.val();
    } else {
      userNick = (user.displayName || "Аноним").slice(0, 32);
      await set(ref(db, `nicks/${user.uid}`), userNick);
    }
    nickInput.value = userNick;

    const cdSnap = await get(ref(db, `cooldowns/${user.uid}`));
    lastPaintTime = cdSnap.exists() ? cdSnap.val() : 0;
    updateCooldownUI();
  } else {
    googleLoginBtn.style.display = "block";
    userInfo.style.display = "none";
    userNick = "";
    lastPaintTime = 0;
  }
});

saveNickBtn.addEventListener("click", async () => {
  if (!currentUser) return;
  const newNick = nickInput.value.trim().slice(0, 32);
  if (!newNick) return;
  userNick = newNick;
  await set(ref(db, `nicks/${currentUser.uid}`), newNick);
  alert("Ник сохранён!");
});

function updateCooldownUI() {
  const remaining = lastPaintTime + COOLDOWN_MS - Date.now();
  cooldownStatus.textContent = remaining > 0
    ? `⏳ ${Math.ceil(remaining / 1000)} с`
    : "✅ Можно рисовать";
}
setInterval(updateCooldownUI, 200);

// ============================================================
// ПАЛИТРА
// ============================================================
const paletteEl = document.getElementById("palette");
COLORS.forEach((color, i) => {
  const swatch = document.createElement("div");
  swatch.className = "color-swatch" + (i === 0 ? " active" : "");
  swatch.style.background = color;
  swatch.addEventListener("click", () => {
    selectedColor = i;
    document.querySelectorAll(".color-swatch").forEach((el) => el.classList.remove("active"));
    swatch.classList.add("active");
  });
  paletteEl.appendChild(swatch);
});

// ============================================================
// FIREBASE
// ============================================================
clearCanvas();

onValue(ref(db, "pixels"), (snapshot) => {
  const data = snapshot.val() || {};
  for (const [key, val] of Object.entries(data)) {
    if (!pixelCache[key] || pixelCache[key].color !== val.color) {
      const [x, y] = key.split("_").map(Number);
      drawPixel(x, y, val.color);
    }
  }
  pixelCache = data;
});

async function handleCanvasClick(e) {
  if (!currentUser) {
    alert("Войдите через Google, чтобы рисовать.");
    return;
  }

  const { x, y } = clientToPixel(e.clientX, e.clientY);
  if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return;

  const now = Date.now();
  if (now - lastPaintTime < COOLDOWN_MS) {
    alert(`Подождите ${Math.ceil((COOLDOWN_MS - (now - lastPaintTime)) / 1000)} с.`);
    return;
  }

  const key = `${x}_${y}`;
  await set(ref(db, `pixels/${key}`), {
    color: selectedColor,
    uid: currentUser.uid,
    nick: userNick,
    timestamp: now
  });

  lastPaintTime = now;
  await set(ref(db, `cooldowns/${currentUser.uid}`), now);
  updateCooldownUI();
}

// ============================================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================================
function tryInit() {
  if (initialized) return;
  if (fitToScreen()) initialized = true;
}

// ResizeObserver — надёжнее, чем load/resize: срабатывает, как только
// контейнер получает реальные размеры (это критично для мобильных)
const ro = new ResizeObserver(() => {
  if (!initialized) {
    tryInit();
  } else {
    // После инициализации — при смене размеров окна подгоняем лимиты,
    // но не трогаем текущий вид пользователя
    // (при желании можно раскомментировать авто-фит: fitToScreen();)
  }
});
ro.observe(container);

window.addEventListener("load", tryInit);
// Страховка на случай, если ResizeObserver не сработал
setTimeout(tryInit, 200);
setTimeout(tryInit, 800);

// Клавиатурные шорткаты
window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  const cx = container.clientWidth / 2;
  const cy = container.clientHeight / 2;
  if (e.key === "+" || e.key === "=") zoomAt(cx, cy, 1.3);
  if (e.key === "-" || e.key === "_") zoomAt(cx, cy, 1 / 1.3);
  if (e.key === "0") fitToScreen();
});
