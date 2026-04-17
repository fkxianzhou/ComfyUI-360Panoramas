import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET_NODE = "PanoramaRectify";
const SIZE_WIDGET = "size_preset";
const WIDTH_WIDGET = "output_width";
const HEIGHT_WIDGET = "output_height";
const CUSTOM_SIZE_PRESET = "Custom";
const SIZE_PRESETS = {
  "1:1 (1024x1024)": [1024, 1024],
  "2:1 (2048x1024)": [2048, 1024],
  "4:3 (1600x1200)": [1600, 1200],
  "16:9 (1920x1080)": [1920, 1080],
  "21:9 (2520x1080)": [2520, 1080],
  "9:16 (1080x1920)": [1080, 1920],
  "3:4 (1200x1600)": [1200, 1600],
  "1:2 (1024x2048)": [1024, 2048],
  "1:1 (2048x2048)": [2048, 2048],
};
const PREVIEW_W = 360;
const PREVIEW_H = 360;
const MIN_PREVIEW_BASE_WIDTH = 1536;
const MIN_PREVIEW_BASE_HEIGHT = 1536;
const OUTPUT_MIN = 128;
const OUTPUT_MAX = 4096;
const OUTPUT_STEP = 2;
const RESIZE_HIT_PAD = 6;
const IS_ZH = typeof navigator !== "undefined" && String(navigator.language || "").toLowerCase().startsWith("zh");
const UI_TEXT = {
  uploadFailed: IS_ZH ? "上传图片失败" : "Upload image failed",
  dragDropUploadFailed: IS_ZH ? "拖拽上传失败" : "Drag-drop upload failed",
  hintLine1: IS_ZH ? "可将图片拖拽到此处，或使用上方“上传图片”控件" : "Drag an image here or use the upload control above",
  hintLine2: IS_ZH ? "左键拖动调整视角；中键拖动或滚轮可调节水平视场角" : "Left drag to change view; middle drag or wheel adjusts horizontal FOV",
};
let canvasInterceptorsInstalled = false;
let currentCanvasCursor = "";
let uploadFetchHookInstalled = false;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function normalizeOutputSize(value) {
  const clamped = clamp(Math.round(Number(value) || OUTPUT_MIN), OUTPUT_MIN, OUTPUT_MAX);
  return Math.max(OUTPUT_MIN, Math.round(clamped / OUTPUT_STEP) * OUTPUT_STEP);
}

function normalizeAngleDeg(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0.0;
  let wrapped = ((num + 180.0) % 360.0 + 360.0) % 360.0 - 180.0;
  if (Math.abs(wrapped + 180.0) < 1e-8) wrapped = 180.0;
  return wrapped;
}

function imageDataToUrl(data) {
  if (!data) return null;
  const filename = encodeURIComponent(data.filename || "");
  const type = encodeURIComponent(data.type || "temp");
  const subfolder = encodeURIComponent(data.subfolder || "");
  const previewParam = app.getPreviewFormatParam ? app.getPreviewFormatParam() : "";
  const randParam = app.getRandParam ? app.getRandParam() : "";
  return api.apiURL(`/view?filename=${filename}&type=${type}&subfolder=${subfolder}${previewParam}${randParam}`);
}

function findWidget(node, name) {
  return node?.widgets?.find((w) => w && w.name === name) || null;
}

function getWidgetNumber(node, name, fallback) {
  const w = findWidget(node, name);
  const num = Number(w?.value);
  return Number.isFinite(num) ? num : fallback;
}

function setWidgetValue(node, name, value) {
  const w = findWidget(node, name);
  if (!w) return;
  if (w.value === value) return;
  w.value = value;
  if (typeof w.callback === "function") w.callback(value);
}

function isPanoramaLinked(node) {
  return node?.inputs?.some((input) => input?.name === "panorama" && input.link !== null) === true;
}

function isWidgetLinked(node, name) {
  return node.inputs ? node.inputs.some((input) => input.name === name && input.link !== null) : false;
}

function toggleWidget(node, widget, show) {
  if (!widget) return false;
  if (isWidgetLinked(node, widget.name)) return false;

  if (!widget.__origType && widget.type !== "hidden") {
    widget.__origType = widget.type;
    widget.__origComputeSize = widget.computeSize;
  }

  if (!widget.__origType && widget.type === "hidden") return false;

  const isHidden = widget.type === "hidden";
  if (show !== isHidden) return false;

  if (show) {
    widget.type = widget.__origType;
    widget.computeSize = widget.__origComputeSize;
  } else {
    widget.type = "hidden";
    widget.computeSize = () => [0, -4];
  }
  return true;
}

function applySizePreset(node) {
  const sizeWidget = findWidget(node, SIZE_WIDGET);
  const widthWidget = findWidget(node, WIDTH_WIDGET);
  const heightWidget = findWidget(node, HEIGHT_WIDGET);
  if (!sizeWidget || !widthWidget || !heightWidget) return;

  const isCustom = sizeWidget.value === CUSTOM_SIZE_PRESET;

  const changedW = toggleWidget(node, widthWidget, isCustom);
  const changedH = toggleWidget(node, heightWidget, isCustom);
  if (changedW || changedH) {
    app.graph.setDirtyCanvas(true, true);
  }
  if (node.__pano_preview_widget) {
    node.__pano_preview_widget.setDirty();
  }
}

function getEffectiveOutputSize(node) {
  const sizeWidget = findWidget(node, SIZE_WIDGET);
  const selected = String(sizeWidget?.value ?? "");
  if (selected && selected !== CUSTOM_SIZE_PRESET) {
    const preset = SIZE_PRESETS[selected];
    if (Array.isArray(preset) && preset.length === 2) {
      return [Math.max(2, Number(preset[0]) || 2), Math.max(2, Number(preset[1]) || 2)];
    }
  }
  const outputW = Math.max(2, getWidgetNumber(node, WIDTH_WIDGET, 1024));
  const outputH = Math.max(2, getWidgetNumber(node, HEIGHT_WIDGET, 1024));
  return [outputW, outputH];
}

function normalizeAngleWidgets(node) {
  const yawWidget = findWidget(node, "yaw");
  if (yawWidget) {
    const next = normalizeAngleDeg(yawWidget.value);
    if (Math.abs(Number(yawWidget.value) - next) > 1e-6) {
      setWidgetValue(node, "yaw", next);
    }
  }
  const pitchWidget = findWidget(node, "pitch");
  if (pitchWidget) {
    const next = normalizeAngleDeg(pitchWidget.value);
    if (Math.abs(Number(pitchWidget.value) - next) > 1e-6) {
      setWidgetValue(node, "pitch", next);
    }
  }
}

async function uploadImageFile(file) {
  if (!(file instanceof File)) throw new Error("Invalid file.");
  const formData = new FormData();
  formData.append("image", file, file.name || "panorama.png");
  formData.append("type", "input");
  const response = await fetch(api.apiURL("/upload/image"), {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Upload failed: ${response.status}`);
  }
  return await response.json();
}

function applyUploadedImageSelection(node, uploadInfo) {
  if (!node || !uploadInfo || typeof uploadInfo !== "object") return;
  const imageName = String(uploadInfo.name || "").trim();
  if (!imageName) return;
  const imageWidget = findWidget(node, "image");
  const values = imageWidget?.options?.values;
  if (Array.isArray(values) && !values.includes(imageName)) {
    values.push(imageName);
  }
  setWidgetValue(node, "image", imageName);
  if (!isPanoramaLinked(node) && node.__pano_preview_widget) {
    node.__pano_preview_widget.setSourceFromUpload(uploadInfo);
    node.__pano_preview_widget.setDirty();
  }
}

function applyUploadedImageSelectionToBestNode(uploadInfo) {
  const graph = app?.canvas?.graph || app?.graph;
  if (!graph?._nodes?.length) return;
  const targetNodes = graph._nodes.filter((n) => n?.comfyClass === TARGET_NODE);
  if (targetNodes.length === 0) return;

  const selectedMap = app?.canvas?.selected_nodes || {};
  const selectedTargets = targetNodes.filter((n) => selectedMap[n.id]);
  const preferred = selectedTargets.length > 0 ? selectedTargets : targetNodes;
  for (const node of preferred) {
    applyUploadedImageSelection(node, uploadInfo);
  }
}

function installUploadFetchHook() {
  if (uploadFetchHookInstalled) return;
  if (typeof window === "undefined" || typeof window.fetch !== "function") return;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    try {
      const requestInfo = args[0];
      const urlText =
        typeof requestInfo === "string"
          ? requestInfo
          : (requestInfo && typeof requestInfo.url === "string" ? requestInfo.url : "");
      if (response?.ok && typeof urlText === "string" && urlText.includes("/upload/image")) {
        const cloned = response.clone();
        cloned
          .json()
          .then((payload) => applyUploadedImageSelectionToBestNode(payload))
          .catch(() => { });
      }
    } catch (_) { }
    return response;
  };
  uploadFetchHookInstalled = true;
}

function fitText(ctx, text, maxWidth) {
  const value = String(text ?? "");
  if (ctx.measureText(value).width <= maxWidth) return value;
  let out = value;
  while (out.length > 1 && ctx.measureText(`${out}...`).width > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}...`;
}

function getGraphPosFromEvent(event) {
  const canvas = app?.canvas;
  if (!canvas) return null;
  if (typeof canvas.convertEventToCanvasOffset === "function") {
    const p = canvas.convertEventToCanvasOffset(event);
    if (Array.isArray(p) && p.length >= 2) return p;
  }
  if (!canvas.canvas || !canvas.ds) return null;
  const rect = canvas.canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const scale = Number(canvas.ds.scale || 1);
  const offset = canvas.ds.offset || [0, 0];
  return [x / scale - offset[0], y / scale - offset[1]];
}

function getPreviewHit(event, forcedNode = null) {
  const graphPos = getGraphPosFromEvent(event);
  if (!graphPos) return null;
  const graph = app?.canvas?.graph || app?.graph;
  if (!graph?._nodes?.length) return null;

  const nodes = forcedNode ? [forcedNode] : [...graph._nodes].reverse();
  for (const node of nodes) {
    if (!node || node.comfyClass !== TARGET_NODE) continue;
    const widget = node.__pano_preview_widget;
    if (!widget) continue;
    const localPos = [graphPos[0] - node.pos[0], graphPos[1] - node.pos[1]];
    if (!widget._insidePreview(localPos)) continue;
    return { node, widget, localPos };
  }
  return null;
}

function findActivePreviewInteraction() {
  const graph = app?.canvas?.graph || app?.graph;
  if (!graph?._nodes?.length) return null;
  for (const node of [...graph._nodes].reverse()) {
    if (!node || node.comfyClass !== TARGET_NODE) continue;
    const widget = node.__pano_preview_widget;
    if (!widget) continue;
    if (widget.dragging || widget.resizing || widget.fovDragging) {
      return { node, widget };
    }
  }
  return null;
}

function blockEvent(event) {
  if (typeof event.preventDefault === "function") event.preventDefault();
  if (typeof event.stopPropagation === "function") event.stopPropagation();
  if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
}

function getCursorForResizeMode(mode) {
  if (!mode) return "";
  if (mode === "e" || mode === "w") return "ew-resize";
  if (mode === "n" || mode === "s") return "ns-resize";
  if (mode === "ne" || mode === "sw") return "nesw-resize";
  if (mode === "nw" || mode === "se") return "nwse-resize";
  return "";
}

function setCanvasCursor(canvasEl, cursor) {
  const next = cursor || "";
  if (next === currentCanvasCursor) return;
  currentCanvasCursor = next;
  canvasEl.style.cursor = next;
}

function installCanvasInterceptors() {
  if (canvasInterceptorsInstalled) return;
  const canvasEl = app?.canvas?.canvas;
  if (!canvasEl) return;

  canvasEl.addEventListener(
    "pointerdown",
    (event) => {
      const hit = getPreviewHit(event);
      if (!hit) return;
      const handled = hit.widget.mouse(event, hit.localPos, hit.node) === true;
      if (handled) blockEvent(event);
    },
    { capture: true, passive: false },
  );

  canvasEl.addEventListener(
    "pointermove",
    (event) => {
      const active = findActivePreviewInteraction();
      if (!active) return;
      const graphPos = getGraphPosFromEvent(event);
      if (!graphPos) return;
      const localPos = [graphPos[0] - active.node.pos[0], graphPos[1] - active.node.pos[1]];
      if (active.widget.resizing) {
        setCanvasCursor(canvasEl, getCursorForResizeMode(active.widget.resizeMode));
      }
      const handled = active.widget.mouse(event, localPos, active.node) === true;
      if (handled) blockEvent(event);
    },
    { capture: true, passive: false },
  );

  canvasEl.addEventListener(
    "pointermove",
    (event) => {
      const active = findActivePreviewInteraction();
      if (active) return;
      const hit = getPreviewHit(event);
      if (!hit) {
        setCanvasCursor(canvasEl, "");
        return;
      }
      const mode = typeof hit.widget._getResizeMode === "function" ? hit.widget._getResizeMode(hit.localPos) : "";
      setCanvasCursor(canvasEl, getCursorForResizeMode(mode));
    },
    { capture: true, passive: true },
  );

  canvasEl.addEventListener(
    "pointerup",
    (event) => {
      const active = findActivePreviewInteraction();
      if (!active) return;
      const graphPos = getGraphPosFromEvent(event);
      if (!graphPos) return;
      const localPos = [graphPos[0] - active.node.pos[0], graphPos[1] - active.node.pos[1]];
      const handled = active.widget.mouse(event, localPos, active.node) === true;
      if (handled) blockEvent(event);
    },
    { capture: true, passive: false },
  );

  canvasEl.addEventListener(
    "pointercancel",
    (event) => {
      const active = findActivePreviewInteraction();
      if (!active) return;
      const graphPos = getGraphPosFromEvent(event);
      if (!graphPos) return;
      const localPos = [graphPos[0] - active.node.pos[0], graphPos[1] - active.node.pos[1]];
      const handled = active.widget.mouse(event, localPos, active.node) === true;
      if (handled) blockEvent(event);
    },
    { capture: true, passive: false },
  );

  canvasEl.addEventListener(
    "pointerleave",
    () => {
      setCanvasCursor(canvasEl, "");
    },
    { capture: true, passive: true },
  );

  canvasEl.addEventListener(
    "dragover",
    (event) => {
      const hit = getPreviewHit(event);
      if (!hit) return;
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      blockEvent(event);
    },
    { capture: true, passive: false },
  );

  canvasEl.addEventListener(
    "drop",
    async (event) => {
      const hit = getPreviewHit(event);
      if (!hit) return;
      const files = Array.from(event.dataTransfer?.files || []);
      const file = files.find((f) => f && String(f.type || "").startsWith("image/"));
      if (!file) return;
      blockEvent(event);
      try {
        const uploadInfo = await uploadImageFile(file);
        applyUploadedImageSelection(hit.node, uploadInfo);
      } catch (error) {
        console.error(`[PanoramaRectify] ${UI_TEXT.dragDropUploadFailed}:`, error);
      }
    },
    { capture: true, passive: false },
  );

  canvasEl.addEventListener(
    "wheel",
    (event) => {
      const hit = getPreviewHit(event);
      if (!hit) return;
      const handled = hit.widget.mouse(event, hit.localPos, hit.node) === true;
      if (handled) blockEvent(event);
    },
    { capture: true, passive: false },
  );

  canvasInterceptorsInstalled = true;
}

class PanoramaCanvasWidget {
  constructor(node) {
    this.name = "panorama_preview_canvas";
    this.type = "custom";
    this.node = node;
    this.value = "";
    this.options = { serialize: false };
    this.hitArea = [0, 0, 0, 0];
    this.captureRect = [0, 0, 0, 0];
    this.dragging = false;
    this.lastPos = [0, 0];
    this.fovDragging = false;
    this.fovLastPos = [0, 0];
    this.resizing = false;
    this.resizeMode = "";
    this.resizeStartPos = [0, 0];
    this.resizeStartSize = [1024, 1024];
    this.resizeStartRect = [0, 0, 1, 1];
    this.resizeBaseSide = MIN_PREVIEW_BASE_WIDTH;
    this.sourceUrl = null;
    this.sourceImage = new Image();
    this.sourceImage.crossOrigin = "anonymous";
    this.sourceImageLoaded = false;
    this.sourceImage.onload = () => {
      this.sourceImageLoaded = true;
      this._prepareSourcePixels();
      this.setDirty();
    };
    this.sourceImage.onerror = () => {
      this.sourceImageLoaded = false;
      this.setDirty();
    };
    this.sourceCanvas = document.createElement("canvas");
    this.sourceCtx = this.sourceCanvas.getContext("2d", { willReadFrequently: true });
    this.previewCanvas = document.createElement("canvas");
    this.previewCanvas.width = PREVIEW_W;
    this.previewCanvas.height = PREVIEW_H;
    this.previewCtx = this.previewCanvas.getContext("2d");
    this.previewDirty = true;
    this.drawBox = [0, 0, PREVIEW_W, PREVIEW_H];
  }

  _getPreviewSide(width) {
    const fallbackWidth = Number(this.node?.size?.[0]) || PREVIEW_W + 24;
    const safeWidth = Number.isFinite(width) ? width : fallbackWidth;
    return Math.max(80, Math.floor(safeWidth - 24));
  }

  computeSize(width) {
    const side = this._getPreviewSide(width);
    return [width, side + 28];
  }

  setDirty() {
    this.previewDirty = true;
    this.node.setDirtyCanvas(true, false);
  }

  setSourceFromOutput(output) {
    const source = output?.source_images?.[0] || output?.images?.[0] || null;
    const url = imageDataToUrl(source);
    if (!url || url === this.sourceUrl) return;
    this.sourceUrl = url;
    this.sourceImageLoaded = false;
    this.sourceImage.src = url;
  }

  setSourceFromUpload(uploadInfo) {
    const url = imageDataToUrl({
      filename: uploadInfo?.filename || uploadInfo?.name || "",
      subfolder: uploadInfo?.subfolder || "",
      type: uploadInfo?.type || "input",
    });
    if (!url || url === this.sourceUrl) return;
    this.sourceUrl = url;
    this.sourceImageLoaded = false;
    this.sourceImage.src = url;
  }

  _prepareSourcePixels() {
    if (!this.sourceImageLoaded) return;
    const w = this.sourceImage.naturalWidth || this.sourceImage.width;
    const h = this.sourceImage.naturalHeight || this.sourceImage.height;
    if (!w || !h) return;
    this.sourceCanvas.width = w;
    this.sourceCanvas.height = h;
    this.sourceCtx.drawImage(this.sourceImage, 0, 0, w, h);
    this.sourcePixels = this.sourceCtx.getImageData(0, 0, w, h);
  }

  _renderPerspective() {
    if (!this.sourceImageLoaded || !this.sourcePixels) return;

    const yaw = getWidgetNumber(this.node, "yaw", 0.0);
    const pitch = getWidgetNumber(this.node, "pitch", 0.0);
    const hfov = getWidgetNumber(this.node, "hfov", 90.0);

    const srcW = this.sourceCanvas.width;
    const srcH = this.sourceCanvas.height;
    const srcData = this.sourcePixels.data;
    const outW = PREVIEW_W;
    const outH = PREVIEW_H;
    const out = this.previewCtx.createImageData(outW, outH);
    const outData = out.data;

    const yawRad = (yaw * Math.PI) / 180.0;
    const pitchRad = (pitch * Math.PI) / 180.0;
    const hfovRad = (hfov * Math.PI) / 180.0;
    const vfovRad = 2.0 * Math.atan(Math.tan(hfovRad / 2.0) * (outH / outW));

    const cosy = Math.cos(yawRad);
    const siny = Math.sin(yawRad);
    const cosp = Math.cos(pitchRad);
    const sinp = Math.sin(pitchRad);

    for (let j = 0; j < outH; j++) {
      const ny = 1.0 - (2.0 * (j + 0.5)) / outH;
      for (let i = 0; i < outW; i++) {
        const nx = (2.0 * (i + 0.5)) / outW - 1.0;
        let x = nx * Math.tan(hfovRad / 2.0);
        let y = ny * Math.tan(vfovRad / 2.0);
        let z = 1.0;

        const invLen = 1.0 / Math.max(Math.hypot(x, y, z), 1e-8);
        x *= invLen;
        y *= invLen;
        z *= invLen;

        const y1 = y * cosp - z * sinp;
        const z1 = y * sinp + z * cosp;
        y = y1;
        z = z1;

        const x2 = x * cosy + z * siny;
        const z2 = -x * siny + z * cosy;
        x = x2;
        z = z2;

        const lon = Math.atan2(x, z);
        const lat = Math.asin(clamp(y, -1.0, 1.0));
        let u = lon / (2.0 * Math.PI) + 0.5;
        u = u - Math.floor(u);
        const v = 0.5 - lat / Math.PI;

        const sx = clamp(Math.floor(u * srcW), 0, srcW - 1);
        const sy = clamp(Math.floor(v * srcH), 0, srcH - 1);

        const srcIdx = (sy * srcW + sx) * 4;
        const dstIdx = (j * outW + i) * 4;
        outData[dstIdx] = srcData[srcIdx];
        outData[dstIdx + 1] = srcData[srcIdx + 1];
        outData[dstIdx + 2] = srcData[srcIdx + 2];
        outData[dstIdx + 3] = 255;
      }
    }

    this.previewCtx.putImageData(out, 0, 0);
    this.previewDirty = false;
  }

  draw(ctx, node, width, y) {
    const top = y + 6;
    const drawSide = this._getPreviewSide(width);
    const drawW = drawSide;
    const drawH = drawSide;
    const scale = drawW / PREVIEW_W;
    const left = (width - drawW) / 2;
    this.hitArea = [left, top, drawW, drawH];
    this.drawBox = [left, top, drawW, drawH];

    ctx.save();
    ctx.fillStyle = "rgba(40, 40, 40, 0.92)";
    ctx.strokeStyle = "rgba(130, 130, 130, 0.8)";
    ctx.lineWidth = 1;
    ctx.fillRect(left, top, drawW, drawH);
    ctx.strokeRect(left, top, drawW, drawH);

    if (this.previewDirty) this._renderPerspective();

    if (this.sourceImageLoaded) {
      ctx.drawImage(this.previewCanvas, left, top, drawW, drawH);
    } else {
      const hintPadding = Math.max(8, Math.floor(drawW * 0.06));
      const maxHintWidth = Math.max(24, drawW - hintPadding * 2);
      const hintFontSize = clamp(Math.floor(drawW / 28), 9, 12);
      const lineGap = Math.max(2, Math.round(hintFontSize * 0.5));
      const centerX = left + drawW / 2;
      const centerY = top + drawH / 2;
      ctx.fillStyle = "rgba(220, 220, 220, 0.95)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `${hintFontSize}px sans-serif`;
      const hintLine1 = fitText(ctx, UI_TEXT.hintLine1, maxHintWidth);
      const hintLine2 = fitText(ctx, UI_TEXT.hintLine2, maxHintWidth);
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, top, drawW, drawH);
      ctx.clip();
      ctx.fillText(hintLine1, centerX, centerY - (hintFontSize + lineGap) / 2);
      ctx.fillText(hintLine2, centerX, centerY + (hintFontSize + lineGap) / 2);
      ctx.restore();
    }

    const [outputW, outputH] = getEffectiveOutputSize(node);
    const baseSide = Math.max(MIN_PREVIEW_BASE_WIDTH, MIN_PREVIEW_BASE_HEIGHT, outputW, outputH);
    const baseW = baseSide;
    const baseH = baseSide;
    const capW = outputW;
    const capH = outputH;
    const rectW = drawW * (capW / baseW);
    const rectH = drawH * (capH / baseH);
    const rectX = left + (drawW - rectW) / 2;
    const rectY = top + (drawH - rectH) / 2;
    this.captureRect = [rectX, rectY, rectW, rectH];
    ctx.save();
    ctx.strokeStyle = "rgba(80, 220, 255, 0.95)";
    ctx.lineWidth = Math.max(1, scale * 2);
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(rectX, rectY, rectW, rectH);
    ctx.restore();

    if (rectW < drawW || rectH < drawH) {
      ctx.save();
      ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
      ctx.fillRect(left, top, drawW, rectY - top);
      ctx.fillRect(left, rectY + rectH, drawW, top + drawH - (rectY + rectH));
      ctx.fillRect(left, rectY, rectX - left, rectH);
      ctx.fillRect(rectX + rectW, rectY, left + drawW - (rectX + rectW), rectH);
      ctx.restore();
    }

    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    const barPadding = 6;
    const barW = Math.max(80, drawW - barPadding * 2);
    const barX = left + barPadding;
    const barY = top + drawH - 24;
    ctx.fillRect(barX, barY, barW, 18);
    ctx.fillStyle = "rgba(255, 255, 255, 0.96)";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = "11px sans-serif";
    const yaw = getWidgetNumber(node, "yaw", 0).toFixed(1);
    const pitch = getWidgetNumber(node, "pitch", 0).toFixed(1);
    const hfov = getWidgetNumber(node, "hfov", 90).toFixed(1);
    const status = `yaw ${yaw}° | pitch ${pitch}° | hfov ${hfov}° | save ${capW}x${capH}`;
    ctx.fillText(fitText(ctx, status, barW - 8), barX + 4, top + drawH - 15);

    ctx.restore();
  }

  _insidePreview(pos) {
    const [x, y, w, h] = this.hitArea;
    const pad = 2;
    return pos[0] >= x - pad && pos[0] <= x + w + pad && pos[1] >= y - pad && pos[1] <= y + h + pad;
  }

  _getResizeMode(pos) {
    const [x, y, w, h] = this.captureRect;
    if (w <= 0 || h <= 0) return "";
    const px = pos[0];
    const py = pos[1];
    const left = x;
    const right = x + w;
    const top = y;
    const bottom = y + h;

    const nearLeft = Math.abs(px - left) <= RESIZE_HIT_PAD && py >= top - RESIZE_HIT_PAD && py <= bottom + RESIZE_HIT_PAD;
    const nearRight = Math.abs(px - right) <= RESIZE_HIT_PAD && py >= top - RESIZE_HIT_PAD && py <= bottom + RESIZE_HIT_PAD;
    const nearTop = Math.abs(py - top) <= RESIZE_HIT_PAD && px >= left - RESIZE_HIT_PAD && px <= right + RESIZE_HIT_PAD;
    const nearBottom = Math.abs(py - bottom) <= RESIZE_HIT_PAD && px >= left - RESIZE_HIT_PAD && px <= right + RESIZE_HIT_PAD;

    if (nearLeft && nearTop) return "nw";
    if (nearRight && nearTop) return "ne";
    if (nearLeft && nearBottom) return "sw";
    if (nearRight && nearBottom) return "se";
    if (nearLeft) return "w";
    if (nearRight) return "e";
    if (nearTop) return "n";
    if (nearBottom) return "s";
    return "";
  }

  _applyResize(pos, node) {
    const mode = this.resizeMode;
    if (!mode) return;

    const startW = Math.max(2, Number(this.resizeStartSize[0]) || 2);
    const startH = Math.max(2, Number(this.resizeStartSize[1]) || 2);

    let nextW = startW;
    let nextH = startH;
    const drawW = Math.max(1e-6, Number(this.hitArea[2]) || 1);
    const drawH = Math.max(1e-6, Number(this.hitArea[3]) || 1);
    const centerX = Number(this.hitArea[0]) + drawW / 2.0;
    const centerY = Number(this.hitArea[1]) + drawH / 2.0;
    const baseSide = Math.max(
      MIN_PREVIEW_BASE_WIDTH,
      MIN_PREVIEW_BASE_HEIGHT,
      Number(this.resizeBaseSide) || MIN_PREVIEW_BASE_WIDTH,
    );

    // Use absolute distance to center so crossing axes won't get stuck by non-negative limits.
    if (mode.includes("e") || mode.includes("w")) {
      const halfPx = Math.max(1.0, Math.abs(pos[0] - centerX));
      nextW = (2.0 * halfPx * baseSide) / drawW;
    }
    if (mode.includes("n") || mode.includes("s")) {
      const halfPx = Math.max(1.0, Math.abs(pos[1] - centerY));
      nextH = (2.0 * halfPx * baseSide) / drawH;
    }

    nextW = Math.min(baseSide, nextW);
    nextH = Math.min(baseSide, nextH);

    const normW = normalizeOutputSize(nextW);
    const normH = normalizeOutputSize(nextH);
    setWidgetValue(node, SIZE_WIDGET, CUSTOM_SIZE_PRESET);
    setWidgetValue(node, WIDTH_WIDGET, normW);
    setWidgetValue(node, HEIGHT_WIDGET, normH);
    this.setDirty();
  }

  mouse(event, pos, node) {
    if (event.type === "wheel" && this._insidePreview(pos)) {
      const deltaY = Number(event.deltaY ?? 0);
      if (Number.isFinite(deltaY) && deltaY !== 0) {
        const currentFov = getWidgetNumber(node, "hfov", 90.0);
        const nextFov = clamp(currentFov + deltaY * 0.03, 30.0, 150.0);
        setWidgetValue(node, "hfov", nextFov);
        this.setDirty();
      }
      if (typeof event.preventDefault === "function") event.preventDefault();
      if (typeof event.stopPropagation === "function") event.stopPropagation();
      return true;
    }

    if (event.type === "pointerdown" && this._insidePreview(pos)) {
      const btn = Number(event.button ?? 0);
      if (btn === 1) {
        this.fovDragging = true;
        this.fovLastPos = [pos[0], pos[1]];
        if (typeof event.preventDefault === "function") event.preventDefault();
        if (typeof event.stopPropagation === "function") event.stopPropagation();
        return true;
      }
      if (btn !== 0) return false;
      const resizeMode = this._getResizeMode(pos);
      if (resizeMode) {
        this.resizing = true;
        this.resizeMode = resizeMode;
        this.resizeStartPos = [pos[0], pos[1]];
        this.resizeStartSize = getEffectiveOutputSize(node);
        this.resizeStartRect = [...this.captureRect];
        const drawW = Math.max(1e-6, Number(this.hitArea[2]) || 1);
        const drawH = Math.max(1e-6, Number(this.hitArea[3]) || 1);
        const rectW = Math.max(1e-6, Number(this.resizeStartRect[2]) || 1);
        const rectH = Math.max(1e-6, Number(this.resizeStartRect[3]) || 1);
        const baseFromW = (drawW * this.resizeStartSize[0]) / rectW;
        const baseFromH = (drawH * this.resizeStartSize[1]) / rectH;
        this.resizeBaseSide = Math.max(
          MIN_PREVIEW_BASE_WIDTH,
          MIN_PREVIEW_BASE_HEIGHT,
          baseFromW,
          baseFromH,
        );
        if (typeof event.preventDefault === "function") event.preventDefault();
        if (typeof event.stopPropagation === "function") event.stopPropagation();
        return true;
      }
      this.dragging = true;
      this.lastPos = [pos[0], pos[1]];
      if (typeof event.preventDefault === "function") event.preventDefault();
      if (typeof event.stopPropagation === "function") event.stopPropagation();
      return true;
    }
    if (event.type === "pointerup" || event.type === "pointercancel") {
      if (this.fovDragging) {
        this.fovDragging = false;
        return true;
      }
      if (this.resizing) {
        this.resizing = false;
        this.resizeMode = "";
        return true;
      }
      this.dragging = false;
      return false;
    }
    if (event.type === "pointermove" && this.fovDragging) {
      const buttons = Number(event.buttons ?? 4);
      if ((buttons & 4) === 0) {
        this.fovDragging = false;
        return false;
      }
      const dy = pos[1] - this.fovLastPos[1];
      this.fovLastPos = [pos[0], pos[1]];
      const currentFov = getWidgetNumber(node, "hfov", 90.0);
      const nextFov = clamp(currentFov + dy * 0.25, 30.0, 150.0);
      setWidgetValue(node, "hfov", nextFov);
      this.setDirty();
      if (typeof event.preventDefault === "function") event.preventDefault();
      if (typeof event.stopPropagation === "function") event.stopPropagation();
      return true;
    }
    if (event.type === "pointermove" && this.resizing) {
      const buttons = Number(event.buttons ?? 1);
      if ((buttons & 1) === 0) {
        this.resizing = false;
        this.resizeMode = "";
        return false;
      }
      this._applyResize(pos, node);
      if (typeof event.preventDefault === "function") event.preventDefault();
      if (typeof event.stopPropagation === "function") event.stopPropagation();
      return true;
    }
    if (event.type === "pointermove" && this.dragging) {
      const buttons = Number(event.buttons ?? 1);
      if ((buttons & 1) === 0) {
        this.dragging = false;
        return false;
      }

      const dx = pos[0] - this.lastPos[0];
      const dy = pos[1] - this.lastPos[1];
      this.lastPos = [pos[0], pos[1]];

      const yaw = getWidgetNumber(node, "yaw", 0.0);
      const pitch = getWidgetNumber(node, "pitch", 0.0);
      setWidgetValue(node, "yaw", normalizeAngleDeg(yaw - dx * 0.28));
      setWidgetValue(node, "pitch", normalizeAngleDeg(pitch + dy * 0.2));
      this.setDirty();
      if (typeof event.preventDefault === "function") event.preventDefault();
      if (typeof event.stopPropagation === "function") event.stopPropagation();
      return true;
    }
    return false;
  }
}

app.registerExtension({
  name: "ComfyUI.360Panoramas.Preview",
  async setup() {
    installCanvasInterceptors();
    installUploadFetchHook();
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== TARGET_NODE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    const onDrawBackground = nodeType.prototype.onDrawBackground;
    const onConfigure = nodeType.prototype.configure;

    nodeType.prototype.configure = function () {
      const result = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      normalizeAngleWidgets(this);
      applySizePreset(this);
      return result;
    };

    nodeType.prototype.onDrawBackground = function () {
      this.imgs = [];
      this.imageIndex = 0;
      this.overIndex = null;
      const result = onDrawBackground ? onDrawBackground.apply(this, arguments) : undefined;
      this.imgs = [];
      this.imageIndex = 0;
      this.overIndex = null;
      return result;
    };

    nodeType.prototype.onNodeCreated = function () {
      const result = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      installCanvasInterceptors();

      this.imgs = [];
      this.imageIndex = 0;
      this.overIndex = null;

      if (!this.__pano_preview_widget) {
        const previewWidget = new PanoramaCanvasWidget(this);
        this.addCustomWidget(previewWidget);
        this.__pano_preview_widget = previewWidget;

        for (const key of ["yaw", "pitch", "hfov", "image", SIZE_WIDGET, WIDTH_WIDGET, HEIGHT_WIDGET]) {
          const w = findWidget(this, key);
          if (!w) continue;
          const oldCb = w.callback;
          w.callback = (...args) => {
            if (typeof oldCb === "function") oldCb.apply(w, args);
            if (key === SIZE_WIDGET) {
              applySizePreset(this);
            }
            previewWidget.setDirty();
          };
        }

        applySizePreset(this);
        normalizeAngleWidgets(this);
        setTimeout(() => applySizePreset(this), 0);
        setTimeout(() => normalizeAngleWidgets(this), 0);
        this.setSize(this.computeSize());
      }

      return result;
    };

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (output) {
      if (onExecuted) onExecuted.apply(this, arguments);
      this.imgs = [];
      this.imageIndex = 0;
      this.overIndex = null;
      if (this.__pano_preview_widget) {
        this.__pano_preview_widget.setSourceFromOutput(output);
        this.__pano_preview_widget.setDirty();
      }
    };
  },
});
