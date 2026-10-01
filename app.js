import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getDatabase, ref, set, get, onValue, onDisconnect, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// === ЗАМЕНИ НА СВОЙ КОНФИГ ИЗ FIREBASE ===
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

// === КОНСТАНТЫ ===
const GRID_SIZE = 1000;
const COOLDOWN_MS = 5000; // 5 секунд

// 16 основных цветов (индексы 0–15)
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
let pixelCache = {}; // { "x_y": { color, uid, nick } }

const canvas = document.getElementById("pixel-canvas");
const ctx = canvas.getContext("2d");
const tooltip = document.getElementById("tooltip");

// === ОТРИСОВКА ПИКСЕЛЕЙ ===
// Рисуем по одному пикселю за раз, масштабируя 1000x1000 до canvas.
// Для производительности canvas 1000x1000 и один пиксель = 1x1 CSS-пиксель.

function drawPixel(x, y, colorIndex) {
  ctx.fillStyle = COLORS[colorIndex];
  ctx.fillRect(x, y, 1, 1);
}

function redrawAll() {
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, GRID_SIZE, GRID_SIZE);
  for (const [key, data] of Object.entries(pixelCache)) {
    const [x, y] = key.split("_").map(Number);
    drawPixel(x, y, data.color);
  }
}

// === ПОДПИСКА НА ПИКСЕЛИ ===
const pixelsRef = ref(db, "pixels");
onValue(pixelsRef, (snapshot) => {
  const data = snapshot.val() || {};
  // Обновляем только изменённые пиксели для производительности
  for (const [key, val] of Object.entries(data)) {
    if (!pixelCache[key] || pixelCache[key].color !== val.color) {
      const [x, y] = key.split("_").map(Number);
      drawPixel(x, y, val.color);
    }
  }
  pixelCache = data;
});

// === АВТОРИЗАЦИЯ ===
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

    // Загружаем ник из базы или ставим displayName по умолчанию
    const nickSnap = await get(ref(db, `nicks/${user.uid}`));
    if (nickSnap.exists()) {
      userNick = nickSnap.val();
    } else {
      userNick = (user.displayName || "Аноним").slice(0, 32);
      await set(ref(db, `nicks/${user.uid}`), userNick);
    }
    nickInput.value = userNick;

    // Загружаем кулдаун
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

// === СОХРАНЕНИЕ НИКА ===
saveNickBtn.addEventListener("click", async () => {
  if (!currentUser) return;
  const newNick = nickInput.value.trim().slice(0, 32);
  if (!newNick) return;
  userNick = newNick;
  await set(ref(db, `nicks/${currentUser.uid}`), newNick);
  alert("Ник сохранён!");
});

// === КУЛДАУН ===
function updateCooldownUI() {
  const now = Date.now();
  const remaining = lastPaintTime + COOLDOWN_MS - now;
  if (remaining > 0) {
    cooldownStatus.textContent = `⏳ ${Math.ceil(remaining / 1000)} с`;
  } else {
    cooldownStatus.textContent = "✅ Можно рисовать";
  }
}

setInterval(updateCooldownUI, 200);

// === ПАЛИТРА ===
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

// === КЛИК ПО CANVAS ===
canvas.addEventListener("click", async (e) => {
  if (!currentUser) {
    alert("Войдите через Google, чтобы рисовать.");
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  const x = Math.floor((e.clientX - rect.left) * scaleX);
  const y = Math.floor((e.clientY - rect.top) * scaleY);

  if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return;

  // Проверка кулдауна на клиенте (сервер тоже проверяет через правила)
  const now = Date.now();
  if (now - lastPaintTime < COOLDOWN_MS) {
    alert(`Подождите ${Math.ceil((COOLDOWN_MS - (now - lastPaintTime)) / 1000)} с.`);
    return;
  }

  const key = `${x}_${y}`;
  const pixelRef = ref(db, `pixels/${key}`);

  // Проверяем, не занят ли пиксель другим пользователем (не перезаписываем чужое)
  const snap = await get(pixelRef);
  if (snap.exists() && snap.val().uid !== currentUser.uid) {
    alert("Этот пиксель уже занят другим художником.");
    return;
  }

  // Записываем пиксель
  await set(pixelRef, {
    color: selectedColor,
    uid: currentUser.uid,
    nick: userNick,
    timestamp: Date.now()
  });

  // Обновляем кулдаун
  lastPaintTime = now;
  await set(ref(db, `cooldowns/${currentUser.uid}`), now);
  updateCooldownUI();
});

// === TOOLTIP ПРИ НАВЕДЕНИИ ===
canvas.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = Math.floor((e.clientX - rect.left) * scaleX);
  const y = Math.floor((e.clientY - rect.top) * scaleY);
  const key = `${x}_${y}`;

  if (pixelCache[key]) {
    tooltip.style.display = "block";
    tooltip.textContent = `${pixelCache[key].nick} (${x}, ${y})`;
    tooltip.style.left = (e.clientX - rect.left + 12) + "px";
    tooltip.style.top = (e.clientY - rect.top + 12) + "px";
  } else {
    tooltip.style.display = "none";
  }
});

canvas.addEventListener("mouseleave", () => {
  tooltip.style.display = "none";
});

// === ИНИЦИАЛИЗАЦИЯ CANVAS ===
redrawAll();
