# ComfyUI-360Panoramas

`ComfyUI-360Panoramas` 提供一个将等距柱状全景图（Equirectangular）转换为透视图的自定义节点，并内置可交互预览。

## 功能特性

- 提供 `PanoramaRectify` 节点，将 2:1 全景图投影为透视图。
- 支持通过 `yaw`、`pitch`、`hfov` 控制观察方向与视角。
- 提供 `size_preset` 标准尺寸比例选项，选择 `Custom` 时可手动输入宽高。
- 支持自定义输出分辨率（`output_width` / `output_height`）。
- 节点内置实时预览：左键拖动调整 `yaw/pitch`，滚轮缩放 `hfov`。

## 环境要求

- ComfyUI（推荐新版）
- Python 运行环境（由 ComfyUI 提供）
- PyTorch（由 ComfyUI 运行时提供）

## 安装方式

将仓库克隆到 ComfyUI 的 `custom_nodes` 目录：

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/fkxianzhou/ComfyUI-360Panoramas.git
```

如果你使用便携版 ComfyUI，请使用对应 Python 安装依赖：

```bash
python -m pip install -r ComfyUI/custom_nodes/ComfyUI-360Panoramas/requirements.txt
```

## 节点说明

### 节点名

- `PanoramaRectify`

### 输入参数

- `panorama`：输入全景图（建议 2:1 比例）。
- `yaw`：水平旋转角，范围 `[-180, 180]`。
- `pitch`：俯仰角，范围 `[-89, 89]`。
- `hfov`：水平视场角，范围 `[30, 150]`。
- `size_preset`：尺寸预设，支持常用比例与 `Custom`。
- `output_width`：输出宽度，范围 `[128, 4096]`。
- `output_height`：输出高度，范围 `[128, 4096]`。

### 输出

- `image`：透视投影后的图像。

## 预览交互

- 左键拖动：调整 `yaw / pitch`
- 鼠标滚轮：缩放 `hfov`

## 许可证

本项目使用 MIT License，见 `LICENSE`。
