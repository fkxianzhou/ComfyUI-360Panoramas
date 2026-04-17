import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET_NODE = "PanoramaRectify";
const PREVIEW_W = 360;
const PREVIEW_H = 360;
const MIN_PREVIEW_BASE_WIDTH = 1536;
const MIN_PREVIEW_BASE_HEIGHT = 1536;
let canvasInterceptorsInstalled = false;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
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

function blockEvent(event) {
  if (typeof event.preventDefault === "function") event.preventDefault();
  if (typeof event.stopPropagation === "function") event.stopPropagation();
  if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
}

function installCanvasInterceptors() {
  if (canvasInterceptorsInstalled) return;
  const canvasEl = app?.canvas?.canvas;
  if (!canvasEl) return;

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
    this.dragging = false;
    this.lastPos = [0, 0];
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
      const hintLine1 = fitText(ctx, "运行一次节点后可在此拖拽预览", maxHintWidth);
      const hintLine2 = fitText(ctx, "左键拖动调整 yaw/pitch，滚轮缩放 hfov", maxHintWidth);
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, top, drawW, drawH);
      ctx.clip();
      ctx.fillText(hintLine1, centerX, centerY - (hintFontSize + lineGap) / 2);
      ctx.fillText(hintLine2, centerX, centerY + (hintFontSize + lineGap) / 2);
      ctx.restore();
    }

    const outputW = Math.max(2, getWidgetNumber(node, "output_width", 1024));
    const outputH = Math.max(2, getWidgetNumber(node, "output_height", 1024));
    const baseSide = Math.max(MIN_PREVIEW_BASE_WIDTH, MIN_PREVIEW_BASE_HEIGHT, outputW, outputH);
    const baseW = baseSide;
    const baseH = baseSide;
    const capW = outputW;
    const capH = outputH;
    const rectW = drawW * (capW / baseW);
    const rectH = drawH * (capH / baseH);
    const rectX = left + (drawW - rectW) / 2;
    const rectY = top + (drawH - rectH) / 2;
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
    return pos[0] >= x && pos[0] <= x + w && pos[1] >= y && pos[1] <= y + h;
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
      if (btn !== 0) return false;
      this.dragging = true;
      this.lastPos = [pos[0], pos[1]];
      if (typeof event.preventDefault === "function") event.preventDefault();
      if (typeof event.stopPropagation === "function") event.stopPropagation();
      return true;
    }
    if (event.type === "pointerup" || event.type === "pointercancel") {
      this.dragging = false;
      return false;
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
      setWidgetValue(node, "yaw", clamp(yaw - dx * 0.28, -180.0, 180.0));
      setWidgetValue(node, "pitch", clamp(pitch + dy * 0.2, -89.0, 89.0));
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
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== TARGET_NODE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    const onDrawBackground = nodeType.prototype.onDrawBackground;

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

        for (const key of ["yaw", "pitch", "hfov", "output_width", "output_height"]) {
          const w = findWidget(this, key);
          if (!w) continue;
          const oldCb = w.callback;
          w.callback = (...args) => {
            if (typeof oldCb === "function") oldCb.apply(w, args);
            previewWidget.setDirty();
          };
        }

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
