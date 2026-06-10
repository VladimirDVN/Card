import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import {
  loadGlbBouquet,
  disposeObject3D,
  parseBouquetManifest,
} from "./glb-bouquet.js";
import {
  buildPostcardGlbRoot,
  disposePostcardGlbRoot,
} from "./card-text-texture.js";

const MODELS_DIR = "models/";
const TEXT_URL = "text.txt";
const MANIFEST_URL = `${MODELS_DIR}manifest.json`;
const BOUQUET_TITLE = "Тюльпаны и орхидеи";

const textEl = document.getElementById("card-text");
const viewportEl = document.getElementById("card-scene");
const statusEl = document.getElementById("card-scene-status");
const savePngBtn = document.getElementById("card-save-png");
const savePdfBtn = document.getElementById("card-save-pdf");
const saveGlbBtn = document.getElementById("card-save-glb");

/** @type {{ scene: THREE.Scene, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer, controls: OrbitControls, bouquet: THREE.Group | null } | null} */
let viewRef = null;

/** @type {string[]} */
let cardParagraphs = [];

/**
 * @param {unknown} data
 * @returns {Record<string, unknown>[]}
 */
function normalizeManifest(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const o = /** @type {Record<string, unknown>} */ (data);
    if (o.file || o.bouquet || o.title) return [o];
  }
  return [];
}

/**
 * @param {string} raw
 * @returns {string[]}
 */
function parseTextParagraphs(raw) {
  const paragraphs = [];
  let block = [];

  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (block.length) {
        paragraphs.push(block.join(" "));
        block = [];
      }
      continue;
    }
    block.push(trimmed);
  }
  if (block.length) paragraphs.push(block.join(" "));
  return paragraphs;
}

function renderText(paragraphs) {
  cardParagraphs = paragraphs;
  textEl.innerHTML = "";
  for (const text of paragraphs) {
    const p = document.createElement("p");
    p.textContent = text;
    textEl.appendChild(p);
  }
}

function showTextError(message) {
  textEl.innerHTML = "";
  const p = document.createElement("p");
  p.className = "postcard__error";
  p.textContent = message;
  textEl.appendChild(p);
}

function setSceneStatus(message, type = "loading") {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.remove("postcard__scene-status--hidden", "postcard__scene-status--error");
  if (type === "hidden") {
    statusEl.classList.add("postcard__scene-status--hidden");
  } else if (type === "error") {
    statusEl.classList.add("postcard__scene-status--error");
  }
}

async function loadCardText() {
  const res = await fetch(TEXT_URL);
  if (!res.ok) {
    showTextError(`Не удалось загрузить ${TEXT_URL}`);
    return;
  }
  const raw = await res.text();
  const paragraphs = parseTextParagraphs(raw);
  if (paragraphs.length === 0) {
    showTextError("Файл text.txt пуст.");
    return;
  }
  renderText(paragraphs);
}

/**
 * @returns {Promise<{ stems: { url: string, count?: number, scale?: number }[], radiusScale?: number, tilt?: number }>}
 */
async function resolveBouquetOptions() {
  const res = await fetch(MANIFEST_URL);
  if (!res.ok) throw new Error("manifest.json недоступен");
  const entries = normalizeManifest(await res.json());

  const byTitle = entries.find((e) => e.title === BOUQUET_TITLE);
  const withItems = entries.find(
    (e) =>
      e.bouquet &&
      typeof e.bouquet === "object" &&
      Array.isArray(/** @type {Record<string, unknown>} */ (e.bouquet).items)
  );
  const anyBouquet = entries.find((e) => e.bouquet);
  const source = byTitle ?? withItems ?? anyBouquet;

  if (!source?.bouquet) {
    throw new Error(`В manifest.json нет букета «${BOUQUET_TITLE}»`);
  }

  const cfg = parseBouquetManifest(
    /** @type {Record<string, unknown>} */ (source.bouquet)
  );
  if (!cfg) throw new Error("Некорректное описание букета");

  return {
    stems: cfg.stems.map((s) => ({
      url: `${MODELS_DIR}${encodeURIComponent(s.url)}`,
      count: s.count,
      scale: s.scale,
    })),
    radiusScale: cfg.radiusScale ?? 1.12,
    tilt: cfg.tilt,
  };
}

/**
 * @param {THREE.Object3D} object
 * @param {number} [targetMaxDim]
 * @returns {number}
 */
function scaleObjectToMaxDimension(object, targetMaxDim = 2.85) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1e-8);
  const factor = targetMaxDim / maxDim;

  object.position.sub(center);
  object.scale.multiplyScalar(factor);
  object.updateMatrixWorld(true);
  return factor;
}

/**
 * @param {THREE.Object3D} root
 */
function prepareMaterials(root) {
  root.traverse((child) => {
    if (!child.isMesh) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of mats) {
      if (!m) continue;
      m.side = THREE.DoubleSide;
      if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
    }
  });
}

/**
 * @param {THREE.Object3D} root
 * @returns {number}
 */
function countMeshes(root) {
  let n = 0;
  root.traverse((c) => {
    if (c.isMesh) n += 1;
  });
  return n;
}

/**
 * @param {THREE.PerspectiveCamera} camera
 * @param {THREE.Object3D} object
 * @param {number} [offset]
 * @returns {THREE.Vector3 | null}
 */
function fitCameraToObject(camera, object, offset = 1.22) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return null;

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 0.001);
  const fov = (camera.fov * Math.PI) / 180;
  const distance = (maxDim / 2 / Math.tan(fov / 2)) * offset;

  camera.position.set(center.x, center.y + size.y * 0.08, center.z + distance);
  camera.near = Math.max(distance / 500, 0.01);
  camera.far = Math.max(distance * 50, 50);
  camera.updateProjectionMatrix();
  camera.lookAt(center);
  return center;
}

function waitForLayout(el) {
  return new Promise((resolve) => {
    const check = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) {
        resolve({ w, h });
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
}

async function savePostcardAsPng() {
  const postcard = document.querySelector(".postcard");
  if (!postcard) return;
  if (!viewRef) {
    alert("Подождите, пока загрузится букет.");
    return;
  }

  if (savePngBtn) savePngBtn.disabled = true;

  try {
    viewRef.controls.update();
    viewRef.renderer.render(viewRef.scene, viewRef.camera);
    const bouquetSnapshot = viewRef.renderer.domElement.toDataURL("image/png");

    const { default: html2canvas } = await import(
      "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/+esm"
    );

    const canvas = await html2canvas(postcard, {
      scale: 2,
      useCORS: true,
      logging: false,
      onclone(clonedDoc) {
        const hint = clonedDoc.querySelector(".postcard__hint");
        const status = clonedDoc.getElementById("card-scene-status");
        if (hint) hint.remove();
        if (status) status.remove();

        const clonedViewport = clonedDoc.getElementById("card-scene");
        if (clonedViewport && bouquetSnapshot) {
          clonedViewport.innerHTML = "";
          const img = clonedDoc.createElement("img");
          img.src = bouquetSnapshot;
          img.alt = BOUQUET_TITLE;
          img.style.cssText = "display:block;width:100%;height:100%;object-fit:cover";
          clonedViewport.appendChild(img);
        }
      },
    });

    const link = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10);
    link.download = `3d-otkrytka-${date}.png`;
    link.href = canvas.toDataURL("image/png", 0.92);
    link.click();
  } catch (err) {
    console.error(err);
    alert(
      "Не удалось сохранить PNG. Попробуйте кнопку PDF: в диалоге печати выберите «Сохранить как PDF»."
    );
  } finally {
    if (savePngBtn) savePngBtn.disabled = false;
  }
}

function savePostcardAsPdf() {
  window.print();
}

/**
 * @param {ArrayBuffer} buffer
 * @param {string} filename
 */
function downloadArrayBuffer(buffer, filename) {
  const blob = new Blob([buffer], { type: "model/gltf-binary" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function saveBouquetAsGlb() {
  if (!viewRef?.bouquet) {
    alert("Подождите, пока загрузится букет.");
    return;
  }
  if (cardParagraphs.length === 0) {
    alert("Текст открытки ещё не загружен.");
    return;
  }

  if (saveGlbBtn) saveGlbBtn.disabled = true;

  try {
    const { root: exportRoot, texture } = await buildPostcardGlbRoot(
      viewRef.bouquet,
      cardParagraphs
    );

    const exporter = new GLTFExporter();
    const result = await new Promise((resolve, reject) => {
      exporter.parse(exportRoot, resolve, reject, { binary: true });
    });

    disposePostcardGlbRoot(exportRoot, texture);

    if (!(result instanceof ArrayBuffer)) {
      throw new Error("Экспорт не вернул бинарный GLB");
    }

    downloadArrayBuffer(result, "3d-otkrytka.glb");
  } catch (err) {
    console.error(err);
    alert(
      err instanceof Error
        ? `Не удалось сохранить GLB: ${err.message}`
        : "Не удалось сохранить GLB."
    );
  } finally {
    if (saveGlbBtn) saveGlbBtn.disabled = false;
  }
}

async function initBouquetScene() {
  if (!viewportEl) return;

  setSceneStatus(`Загрузка «${BOUQUET_TITLE}»…`);
  await waitForLayout(viewportEl);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe8dde6);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  viewportEl.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 0.15;
  controls.maxDistance = 20;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.75;
  controls.target.set(0, 0.5, 0);

  viewRef = { scene, camera, renderer, controls, bouquet: null };

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  scene.add(new THREE.HemisphereLight(0xfff5f8, 0x6a5a62, 1.2));
  const key = new THREE.DirectionalLight(0xffffff, 1.35);
  key.position.set(4, 9, 6);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffe8f0, 0.65);
  fill.position.set(-5, 4, 3);
  scene.add(fill);

  const loader = new GLTFLoader();
  let bouquet = null;

  function resizeRenderer() {
    const w = Math.max(viewportEl.clientWidth, 1);
    const h = Math.max(viewportEl.clientHeight, 1);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }

  try {
    const opts = await resolveBouquetOptions();
    bouquet = await loadGlbBouquet(loader, opts);
    prepareMaterials(bouquet);
    scene.add(bouquet);
    scaleObjectToMaxDimension(bouquet, 2.85);
    bouquet.position.x -= 0.22;
    bouquet.position.y += 0.14;
    bouquet.updateMatrixWorld(true);

    const meshCount = countMeshes(bouquet);
    if (meshCount === 0) {
      throw new Error("Модели загружены, но в сцене нет мешей");
    }

    resizeRenderer();
    const center = fitCameraToObject(camera, bouquet, 1.22);
    if (!center) {
      throw new Error("Не удалось рассчитать рамки букета");
    }
    controls.target.copy(center);
    controls.update();

    setSceneStatus("", "hidden");
    if (savePngBtn) savePngBtn.disabled = false;
    if (saveGlbBtn) saveGlbBtn.disabled = false;
    viewRef.bouquet = bouquet;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Ошибка загрузки букета";
    setSceneStatus(message, "error");
    console.error("Букет:", err);
    resizeRenderer();
    if (savePngBtn) savePngBtn.disabled = true;
    if (saveGlbBtn) saveGlbBtn.disabled = true;
  }

  const resizeObserver = new ResizeObserver(resizeRenderer);
  resizeObserver.observe(viewportEl);

  let animId = 0;
  function animate() {
    animId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  window.addEventListener(
    "pagehide",
    () => {
      cancelAnimationFrame(animId);
      resizeObserver.disconnect();
      controls.dispose();
      renderer.dispose();
      viewRef = null;
      if (bouquet) disposeObject3D(bouquet);
    },
    { once: true }
  );
}

function bindSaveButtons() {
  if (savePngBtn) {
    savePngBtn.disabled = true;
    savePngBtn.addEventListener("click", () => savePostcardAsPng());
  }
  if (savePdfBtn) {
    savePdfBtn.addEventListener("click", () => savePostcardAsPdf());
  }
  if (saveGlbBtn) {
    saveGlbBtn.disabled = true;
    saveGlbBtn.addEventListener("click", () => saveBouquetAsGlb());
  }
}

loadCardText();
bindSaveButtons();
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => initBouquetScene());
} else {
  initBouquetScene();
}
