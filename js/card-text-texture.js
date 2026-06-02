import * as THREE from "three";

const FONT_BODY = '400 30px "Cormorant Garamond", Georgia, "Times New Roman", serif';
const FONT_CAP = '600 76px "Cormorant Garamond", Georgia, serif';

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} font
 * @param {string} text
 * @param {number} maxWidth
 * @returns {string[]}
 */
function wrapLines(ctx, font, text, maxWidth) {
  if (maxWidth < 40) return [];
  ctx.font = font;
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * @param {string[]} paragraphs
 */
export async function createTextTexture(paragraphs) {
  if (paragraphs.length === 0) {
    throw new Error("Нет текста для текстуры");
  }

  await document.fonts.load(FONT_BODY);
  await document.fonts.load(FONT_CAP);

  const width = 1200;
  const padding = 52;
  const lineHeight = 44;
  const paragraphGap = 22;
  const columnGap = 28;

  const bouquetZone = {
    x: padding,
    y: padding,
    w: Math.floor(width * 0.44),
    h: 500,
  };

  const sideColumnX = bouquetZone.x + bouquetZone.w + columnGap;
  const sideColumnWidth = width - padding - sideColumnX;
  const fullWidth = width - padding * 2;

  const measure = document.createElement("canvas").getContext("2d");
  if (!measure) throw new Error("Canvas 2D недоступен");

  /** @type {{ text: string, gap?: boolean }[]} */
  const flow = [];

  for (let p = 0; p < paragraphs.length; p++) {
    const lines = wrapLines(measure, FONT_BODY, paragraphs[p], sideColumnWidth);
    for (const text of lines) flow.push({ text });
    if (p < paragraphs.length - 1) flow.push({ text: "", gap: true });
  }

  const zoneBottomY = bouquetZone.y + bouquetZone.h;
  let y = padding + 30;
  let dropCapDone = false;

  const height = Math.max(
    720,
    zoneBottomY +
      Math.max(0, flow.length - 8) * lineHeight +
      paragraphs.length * paragraphGap +
      padding * 2
  );

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D недоступен");

  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, "#fffef9");
  bg.addColorStop(0.42, "#faf3eb");
  bg.addColorStop(1, "#f5ebe3");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(180, 120, 140, 0.28)";
  ctx.lineWidth = 2;
  ctx.strokeRect(10, 10, width - 20, height - 20);

  const zoneGrad = ctx.createLinearGradient(
    bouquetZone.x,
    bouquetZone.y,
    bouquetZone.x + bouquetZone.w,
    bouquetZone.y + bouquetZone.h
  );
  zoneGrad.addColorStop(0, "#f8f0f4");
  zoneGrad.addColorStop(1, "#ebe0e8");
  ctx.fillStyle = zoneGrad;
  ctx.fillRect(bouquetZone.x, bouquetZone.y, bouquetZone.w, bouquetZone.h);
  ctx.strokeStyle = "rgba(180, 120, 140, 0.2)";
  ctx.strokeRect(bouquetZone.x, bouquetZone.y, bouquetZone.w, bouquetZone.h);

  for (const item of flow) {
    if (item.gap) {
      y += paragraphGap;
      continue;
    }

    const inSideColumn = y < zoneBottomY;
    const xStart = inSideColumn ? sideColumnX : padding;
    const maxW = inSideColumn ? sideColumnWidth : fullWidth;

    if (!dropCapDone && item.text.length > 0) {
      dropCapDone = true;
      const letter = item.text[0];
      const rest = item.text.slice(1).trimStart();

      ctx.font = FONT_CAP;
      ctx.fillStyle = "#8b4a62";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(letter, xStart, y + 14);

      const capW = ctx.measureText(letter).width + 12;
      ctx.font = FONT_BODY;
      ctx.fillStyle = "#2c2419";

      if (rest) {
        const restLines = wrapLines(ctx, FONT_BODY, rest, maxW - capW);
        for (let i = 0; i < restLines.length; i++) {
          ctx.fillText(restLines[i], i === 0 ? xStart + capW : xStart, y);
          y += lineHeight;
        }
      } else {
        y += lineHeight;
      }
      continue;
    }

    ctx.font = FONT_BODY;
    ctx.fillStyle = "#2c2419";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(item.text, xStart, y);
    y += lineHeight;
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;

  return { texture, bouquetZone, width, height };
}

/**
 * Текст «приклеен» к камере (как HTML на сайте), букет — в мире сцены.
 * @param {THREE.Object3D} bouquet
 * @param {string[]} paragraphs
 */
export async function buildPostcardGlbRoot(bouquet, paragraphs) {
  const scene = new THREE.Scene();
  scene.name = "PostcardScene";

  const { texture, bouquetZone, width: texW, height: texH } =
    await createTextTexture(paragraphs);

  const panelHeight = 2.75;
  const panelWidth = panelHeight * (texW / texH);
  const aspect = texW / texH;

  const camera = new THREE.PerspectiveCamera(42, aspect, 0.05, 80);
  camera.name = "PostcardCamera";
  camera.position.set(0, 0, 5.8);
  camera.lookAt(0, 0, 0);

  const textPanel = new THREE.Mesh(
    new THREE.PlaneGeometry(panelWidth, panelHeight),
    new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.92,
      metalness: 0,
      side: THREE.DoubleSide,
    })
  );
  textPanel.name = "TextSheet_ScreenFixed";
  textPanel.position.set(0, 0, -5.2);
  camera.add(textPanel);
  scene.add(camera);

  const u0 = bouquetZone.x / texW;
  const u1 = (bouquetZone.x + bouquetZone.w) / texW;
  const v0 = bouquetZone.y / texH;
  const v1 = (bouquetZone.y + bouquetZone.h) / texH;

  const zoneW = (u1 - u0) * panelWidth;
  const zoneH = (v1 - v0) * panelHeight;
  const zoneLocalX = -panelWidth / 2 + ((u0 + u1) / 2) * panelWidth;
  const zoneLocalY = panelHeight / 2 - ((v0 + v1) / 2) * panelHeight;

  const bouquetPart = bouquet.clone(true);
  bouquetPart.name = "BouquetMesh";
  bouquetPart.updateMatrixWorld(true);
  const bBox = new THREE.Box3().setFromObject(bouquetPart);
  const bSize = bBox.getSize(new THREE.Vector3());
  const bCenter = bBox.getCenter(new THREE.Vector3());
  bouquetPart.position.sub(bCenter);

  const fitScale =
    Math.min(zoneW / Math.max(bSize.x, 0.001), zoneH / Math.max(bSize.y, 0.001)) *
    0.92;
  bouquetPart.scale.multiplyScalar(fitScale);

  const pivot = new THREE.Group();
  pivot.name = "BouquetPivot";

  scene.updateMatrixWorld(true);
  const pivotWorld = new THREE.Vector3(zoneLocalX, zoneLocalY, 0.06);
  textPanel.localToWorld(pivotWorld);
  pivot.position.copy(pivotWorld);
  pivot.add(bouquetPart);
  scene.add(pivot);

  scene.userData.orbitTarget = pivot.position.clone();

  return { root: scene, texture, pivot, camera };
}

/**
 * @param {THREE.Object3D} root
 * @param {THREE.Texture} [texture]
 */
export function disposePostcardGlbRoot(root, texture) {
  texture?.dispose();
  root.traverse((child) => {
    if (!child.isMesh) return;
    child.geometry?.dispose();
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of mats) {
      if (!m) continue;
      if (m.map && m.map !== texture) m.map.dispose();
      m.dispose();
    }
  });
}
