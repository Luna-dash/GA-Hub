# GA-Hub brand images

The current logo comes from the user upload `e2d9d3e87afb429e867c8a3fc7373949.jpg` (SHA-256 `7e746a62d8bdb820652eff396f2213519fceda1e8137b875077f2df1236575e7`). The original 2048×2048 JPEG is deliberately not stored in the repository.

- `gahub-logo-background.png`: 512×512 reference image with the original dark green background and composition.
- `gahub-logo-transparent.png`: 512×512 transparent master, with background and spiral gaps removed, edge matte corrected, and the subject cropped tightly to the square canvas. Keep this intentional master even though it is not directly imported by the UI.
- `gahub-icon.png`: 128×128 sidebar image, derived from the transparent master with a small inset for the circular sidebar container.

`src-tauri/icons/icon.ico` supplies the desktop executable/window icon. It and `webui/public/favicon.ico` contain 16/24/32/48/64/128/256 pixel frames, with no added padding. `favicon-192.png` and the 512px image embedded in `favicon.svg` use the same transparent subject. Update the favicon query version in `webui/index.html` when replacing the artwork.

The taskbar icon is embedded at desktop build time; updating these files does not change an already running desktop executable. Build the desktop through `scripts/build_all.py` after exiting the application.
