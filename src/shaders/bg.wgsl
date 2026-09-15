// Static backdrop: near-black with a faint green grid and vignette. No motion here on purpose.
struct BgParams { viewport: vec2f, center: vec2f, scale: f32, aspect: f32 }
@group(0) @binding(0) var<uniform> bg: BgParams;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let clip = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let world = clip * vec2f(bg.aspect, 1.0) / bg.scale + bg.center;
  let g = abs(fract(world * 0.5) - 0.5) * 2.0;
  let line = 1.0 - smoothstep(0.0, 0.06 / max(bg.scale, 0.02), min(g.x, g.y));
  let vign = 1.0 - 0.55 * length(uv - 0.5);
  let base = vec3f(0.027, 0.035, 0.051) * vign;
  return vec4f(base + vec3f(0.0, 0.78, 0.02) * line * 0.045, 1.0);
}
