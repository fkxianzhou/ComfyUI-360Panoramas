import math
import os

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

import folder_paths
from comfy_api.latest import ComfyAPI, ComfyExtension, io, ui

api = ComfyAPI()
MIN_PREVIEW_BASE_WIDTH = 1536
MIN_PREVIEW_BASE_HEIGHT = 1536
CUSTOM_SIZE_PRESET = "Custom"
SIZE_PRESETS: dict[str, tuple[int, int]] = {
    "1:1 (1024x1024)": (1024, 1024),
    "2:1 (2048x1024)": (2048, 1024),
    "4:3 (1600x1200)": (1600, 1200),
    "16:9 (1920x1080)": (1920, 1080),
    "21:9 (2520x1080)": (2520, 1080),
    "9:16 (1080x1920)": (1080, 1920),
    "3:4 (1200x1600)": (1200, 1600),
    "1:2 (1024x2048)": (1024, 2048),
    "1:1 (2048x2048)": (2048, 2048),
}
DEFAULT_SIZE_PRESET = "1:1 (1024x1024)"


def _warn(message: str) -> None:
    logger = getattr(api, "logger", None)
    if logger and hasattr(logger, "warning"):
        logger.warning(message)
    else:
        print(message)


def _to_nchw(images: torch.Tensor) -> torch.Tensor:
    if images.ndim != 4:
        raise ValueError("Expected image tensor shape [B, H, W, C].")
    return images.movedim(-1, 1)


def _to_bhwc(images: torch.Tensor) -> torch.Tensor:
    if images.ndim != 4:
        raise ValueError("Expected image tensor shape [B, C, H, W].")
    return images.movedim(1, -1)


def _build_sampling_grid(
    out_w: int,
    out_h: int,
    yaw_deg: float,
    pitch_deg: float,
    hfov_deg: float,
    device: torch.device,
) -> torch.Tensor:
    yaw = math.radians(yaw_deg)
    pitch = math.radians(pitch_deg)
    hfov = math.radians(hfov_deg)
    vfov = 2.0 * math.atan(math.tan(hfov / 2.0) * (out_h / out_w))

    xs = torch.linspace(-1.0, 1.0, out_w, device=device)
    ys = torch.linspace(-1.0, 1.0, out_h, device=device)
    yy, xx = torch.meshgrid(ys, xs, indexing="ij")

    x = xx * math.tan(hfov / 2.0)
    y = -yy * math.tan(vfov / 2.0)
    z = torch.ones_like(x)

    dirs = torch.stack([x, y, z], dim=-1)
    dirs = dirs / torch.norm(dirs, dim=-1, keepdim=True).clamp_min(1e-8)

    cosy = math.cos(yaw)
    siny = math.sin(yaw)
    cosp = math.cos(pitch)
    sinp = math.sin(pitch)

    rot_yaw = torch.tensor(
        [[cosy, 0.0, siny], [0.0, 1.0, 0.0], [-siny, 0.0, cosy]],
        dtype=torch.float32,
        device=device,
    )
    rot_pitch = torch.tensor(
        [[1.0, 0.0, 0.0], [0.0, cosp, -sinp], [0.0, sinp, cosp]],
        dtype=torch.float32,
        device=device,
    )
    rot = rot_yaw @ rot_pitch

    world = dirs @ rot.T
    world_x = world[..., 0]
    world_y = world[..., 1].clamp(-1.0, 1.0)
    world_z = world[..., 2]

    lon = torch.atan2(world_x, world_z)
    lat = torch.asin(world_y)

    u = torch.remainder(lon / (2.0 * math.pi) + 0.5, 1.0)
    v = 0.5 - (lat / math.pi)

    grid_x = u * 2.0 - 1.0
    grid_y = v * 2.0 - 1.0
    return torch.stack([grid_x, grid_y], dim=-1)


def _resolve_output_size(
    size_preset: str,
    output_width: int,
    output_height: int,
) -> tuple[int, int]:
    if size_preset != CUSTOM_SIZE_PRESET:
        preset_size = SIZE_PRESETS.get(size_preset)
        if preset_size is not None:
            return preset_size
        _warn(f"PanoramaRectify: Unknown size preset '{size_preset}', fallback to custom size.")
    return int(output_width), int(output_height)


def _list_input_images() -> list[str]:
    input_dir = folder_paths.get_input_directory()
    files = [f for f in os.listdir(input_dir) if os.path.isfile(os.path.join(input_dir, f))]
    return sorted(folder_paths.filter_files_content_types(files, ["image"]))


def _load_image_from_combo(image_name: str | None) -> torch.Tensor | None:
    name = (image_name or "").strip()
    if not name:
        return None
    if not folder_paths.exists_annotated_filepath(name):
        _warn(f"PanoramaRectify: combo image not found: {name}")
        return None
    image_path = folder_paths.get_annotated_filepath(name)
    with Image.open(image_path) as img:
        image = img.convert("RGB")
        np_image = np.array(image, dtype=np.float32) / 255.0
    return torch.from_numpy(np_image).unsqueeze(0)


def equirectangular_to_perspective(
    images: torch.Tensor,
    yaw_deg: float,
    pitch_deg: float,
    hfov_deg: float,
    out_w: int,
    out_h: int,
) -> torch.Tensor:
    images_f = images.float()
    input_nchw = _to_nchw(images_f)

    grid = _build_sampling_grid(
        out_w=out_w,
        out_h=out_h,
        yaw_deg=yaw_deg,
        pitch_deg=pitch_deg,
        hfov_deg=hfov_deg,
        device=images.device,
    ).unsqueeze(0)
    grid = grid.expand(images.shape[0], -1, -1, -1)

    sampled = F.grid_sample(
        input_nchw,
        grid,
        mode="bilinear",
        padding_mode="border",
        align_corners=False,
    )
    return _to_bhwc(sampled).clamp(0.0, 1.0)


class PanoramaRectify(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        input_images = _list_input_images()
        return io.Schema(
            node_id="PanoramaRectify",
            display_name="Panorama Rectify",
            category="image/panorama",
            inputs=[
                io.Image.Input(
                    "panorama",
                    tooltip="Input equirectangular panorama image (2:1 aspect ratio is recommended).",
                    optional=True,
                ),
                io.Combo.Input(
                    "size_preset",
                    options=[*SIZE_PRESETS.keys(), CUSTOM_SIZE_PRESET],
                    default=DEFAULT_SIZE_PRESET,
                ),
                io.Int.Input("output_width", default=1024, min=128, max=4096, step=2),
                io.Int.Input("output_height", default=1024, min=128, max=4096, step=2),
                io.Float.Input("yaw", default=0.0, min=-1000000.0, max=1000000.0, step=0.1),
                io.Float.Input("pitch", default=0.0, min=-1000000.0, max=1000000.0, step=0.1),
                io.Float.Input("hfov", default=90.0, min=30.0, max=150.0, step=0.1),
                io.Combo.Input(
                    "image",
                    options=input_images,
                    default=input_images[0] if input_images else "",
                    upload=io.UploadType.image,
                    image_folder=io.FolderType.input,
                    extra_dict={"image_upload": True},
                ),
            ],
            outputs=[io.Image.Output("image")],
        )

    @classmethod
    async def execute(
        cls,
        panorama: torch.Tensor | None = None,
        image: str | None = None,
        yaw: float = 0.0,
        pitch: float = 0.0,
        hfov: float = 90.0,
        size_preset: str = DEFAULT_SIZE_PRESET,
        output_width: int = 1024,
        output_height: int = 1024,
    ):
        if panorama is None:
            panorama = _load_image_from_combo(image)
            if panorama is None:
                raise ValueError("PanoramaRectify: No panorama input linked and no selected uploaded image.")

        resolved_width, resolved_height = _resolve_output_size(
            size_preset=size_preset,
            output_width=output_width,
            output_height=output_height,
        )
        _, h, w, _ = panorama.shape
        if w != h * 2:
            _warn(
                f"PanoramaRectify: Input ratio is {w}:{h}, not standard 2:1; still processing as equirectangular."
            )

        await api.execution.set_progress(1, 3, preview_image=panorama[:1])
        base_side = max(
            MIN_PREVIEW_BASE_WIDTH,
            MIN_PREVIEW_BASE_HEIGHT,
            int(resolved_width),
            int(resolved_height),
        )
        base_w = base_side
        base_h = base_side
        projected = equirectangular_to_perspective(
            images=panorama,
            yaw_deg=yaw,
            pitch_deg=pitch,
            hfov_deg=hfov,
            out_w=base_w,
            out_h=base_h,
        )
        await api.execution.set_progress(2, 3, preview_image=projected[:1])

        cap_w = max(2, min(int(resolved_width), base_w))
        cap_h = max(2, min(int(resolved_height), base_h))
        x0 = max(0, (base_w - cap_w) // 2)
        y0 = max(0, (base_h - cap_h) // 2)
        captured = projected[:, y0:y0 + cap_h, x0:x0 + cap_w, :]

        source_preview = ui.PreviewImage(panorama[:1], cls=cls).as_dict().get("images", [])
        projected_preview = ui.PreviewImage(projected[:1], cls=cls).as_dict().get("images", [])

        ui_data = {
            "source_images": source_preview,
            "preview_images": projected_preview,
            "capture_box": {
                "x": x0,
                "y": y0,
                "width": cap_w,
                "height": cap_h,
                "base_width": base_w,
                "base_height": base_h,
            },
        }
        await api.execution.set_progress(3, 3)
        return io.NodeOutput(captured, ui=ui_data)


class PanoramaExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [PanoramaRectify]


async def comfy_entrypoint() -> PanoramaExtension:
    return PanoramaExtension()
