import * as THREE from "three";

const DEFAULT_COUNT = 10;
const FOOTPRINT_RADIUS_FACTOR = 0.31;

/**
 * Выравнивает модель: центр по XZ, основание на Y = 0.
 * @param {THREE.Object3D} object
 */
function alignModelBase(object) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  object.position.x -= (box.min.x + box.max.x) / 2;
  object.position.y -= box.min.y;
  object.position.z -= (box.min.z + box.max.z) / 2;
}

/**
 * @param {THREE.Object3D} object
 * @returns {THREE.Vector3}
 */
function getModelSize(object) {
  object.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
}

/**
 * @param {THREE.Object3D} object
 * @returns {number}
 */
function getModelFootprint(object) {
  const size = getModelSize(object);
  return Math.max(size.x, size.z, 0.001);
}

/**
 * Эталонный «след» букета — по самому компактному цветку (радиус не раздувается).
 * @param {number[]} footprints
 * @returns {number}
 */
export function computeReferenceFootprint(footprints) {
  return Math.min(...footprints, 0.001);
}

/**
 * Масштаб стебля: крупные модели уменьшаются до эталона, мелкие не увеличиваются.
 * @param {number} footprint
 * @param {number} referenceFootprint
 * @returns {number}
 */
export function computeStemFitScale(footprint, referenceFootprint) {
  if (footprint <= referenceFootprint) return 1;
  return referenceFootprint / footprint;
}

/**
 * @param {number} referenceFootprint
 * @param {number} radiusScale
 * @param {number | undefined} explicitRadius
 * @returns {number}
 */
export function computeBouquetRadius(referenceFootprint, radiusScale = 1, explicitRadius) {
  const auto = referenceFootprint * FOOTPRINT_RADIUS_FACTOR * radiusScale;
  if (typeof explicitRadius === "number" && explicitRadius > 0) {
    return Math.max(auto, explicitRadius);
  }
  return auto;
}

/**
 * @param {import("three/addons/loaders/GLTFLoader.js").GLTFLoader} loader
 * @param {string} url
 * @returns {Promise<THREE.Object3D>}
 */
function loadTemplate(loader, url) {
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (gltf) => {
        const template = gltf.scene;
        alignModelBase(template);
        resolve(template);
      },
      undefined,
      reject
    );
  });
}

/**
 * @typedef {{ url: string, count?: number, scale?: number }} BouquetStemSpec
 */

/**
 * Загружает GLB и расставляет стебли по кругу в плоскости XZ.
 * Радиус — по самому компактному цветку; более крупные уменьшаются (scale).
 *
 * @param {import("three/addons/loaders/GLTFLoader.js").GLTFLoader} loader
 * @param {{ stems: BouquetStemSpec[], radius?: number, radiusScale?: number, tilt?: number }} options
 * @returns {Promise<THREE.Group>}
 */
export async function loadGlbBouquet(loader, options) {
  const stems = options.stems ?? [];
  if (stems.length === 0) {
    throw new Error("Букет: не заданы стебли (stems)");
  }

  const tilt = options.tilt ?? 0.14;
  const radiusScale = options.radiusScale ?? 1;

  const uniqueUrls = [...new Set(stems.map((s) => s.url))];
  /** @type {Map<string, { template: THREE.Object3D, footprint: number }>} */
  const templates = new Map();

  await Promise.all(
    uniqueUrls.map(async (url) => {
      const template = await loadTemplate(loader, url);
      templates.set(url, {
        template,
        footprint: getModelFootprint(template),
      });
    })
  );

  /** @type {{ url: string, scale?: number }[]} */
  const stemPlacements = [];
  for (const spec of stems) {
    const n = Math.max(1, Math.floor(spec.count ?? 1));
    for (let i = 0; i < n; i++) {
      stemPlacements.push({ url: spec.url, scale: spec.scale });
    }
  }

  const footprints = [...templates.values()].map((t) => t.footprint);
  const referenceFootprint = computeReferenceFootprint(footprints);
  const radius = computeBouquetRadius(referenceFootprint, radiusScale, options.radius);
  const count = stemPlacements.length;

  const bouquet = new THREE.Group();
  bouquet.name = "GlbBouquet";

  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const { url, scale: stemScaleOverride } = stemPlacements[i];
    const { template, footprint } = templates.get(url);

    const slot = new THREE.Group();
    slot.rotation.y = angle;

    const instance = template.clone(true);
    const fitScale = computeStemFitScale(footprint, referenceFootprint);
    const manualScale =
      typeof stemScaleOverride === "number" && stemScaleOverride > 0
        ? stemScaleOverride
        : 1;
    const s = fitScale * manualScale;
    instance.scale.set(s, s, s);

    instance.position.set(0, 0, radius);
    instance.rotation.y = Math.PI;
    instance.rotation.x = tilt * 0.85;
    instance.rotation.order = "YXZ";

    slot.add(instance);
    bouquet.add(slot);
  }

  return bouquet;
}

/**
 * Собирает спецификацию стеблей из manifest (один файл или массив items).
 * @param {Record<string, unknown>} bouquet
 * @returns {{ stems: BouquetStemSpec[], count?: number, radius?: number, radiusScale?: number, tilt?: number } | null}
 */
export function parseBouquetManifest(bouquet) {
  if (!bouquet || typeof bouquet !== "object") return null;

  const b = bouquet;
  const opts = {
    count: typeof b.count === "number" ? b.count : undefined,
    radius: typeof b.radius === "number" ? b.radius : undefined,
    radiusScale: typeof b.radiusScale === "number" ? b.radiusScale : undefined,
    tilt: typeof b.tilt === "number" ? b.tilt : undefined,
    stems: /** @type {BouquetStemSpec[]} */ ([]),
  };

  if (Array.isArray(b.items)) {
    for (const raw of b.items) {
      if (!raw || typeof raw !== "object") continue;
      const item = /** @type {Record<string, unknown>} */ (raw);
      if (typeof item.file !== "string" || !item.file.toLowerCase().endsWith(".glb")) {
        continue;
      }
      opts.stems.push({
        url: item.file,
        count: typeof item.count === "number" ? item.count : 1,
        scale: typeof item.scale === "number" ? item.scale : undefined,
      });
    }
  } else if (typeof b.file === "string" && b.file.toLowerCase().endsWith(".glb")) {
    opts.stems.push({
      url: b.file,
      count: typeof b.count === "number" ? b.count : DEFAULT_COUNT,
    });
  }

  if (opts.stems.length === 0) return null;
  return opts;
}

/**
 * Масштабирует объект так, чтобы он занимал ~targetMaxDim в сцене (для открытки / превью).
 * @param {THREE.Object3D} object
 * @param {number} [targetMaxDim]
 * @returns {number} применённый коэффициент
 */
export function scaleObjectToMaxDimension(object, targetMaxDim = 2.6) {
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
export function disposeObject3D(root) {
  const geometries = new Set();
  const materials = new Set();

  root.traverse((child) => {
    if (!child.isMesh) return;
    if (child.geometry && !geometries.has(child.geometry)) {
      geometries.add(child.geometry);
      child.geometry.dispose();
    }
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of mats) {
      if (m && !materials.has(m)) {
        materials.add(m);
        m.dispose();
      }
    }
  });
}
