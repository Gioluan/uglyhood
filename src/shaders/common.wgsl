export struct Cam {
  center: vec2f,
  viewport: vec2f,
  scale: f32,
  aspect: f32,
  time: f32,
  hover: i32,
  mask: u32,
  zoomPx: f32,
  pad: vec2f,
}

export fn palette(t: u32) -> vec3f {
  switch t {
    case 0u: { return vec3f(1.0, 0.82, 0.40); }   // CASHCAT gold
    case 1u: { return vec3f(1.0, 0.37, 0.64); }   // BUN pink
    case 2u: { return vec3f(0.75, 0.92, 0.82); }  // USDG mint white
    case 3u: { return vec3f(0.35, 0.66, 1.0); }   // WETH blue
    case 4u: { return vec3f(0.18, 0.95, 1.0); }   // GIGA cyan
    case 5u: { return vec3f(1.0, 0.36, 0.12); }   // PONS hot orange
    default: { return vec3f(0.8); }
  }
}

export fn toClip(w: vec2f, center: vec2f, scale: f32, aspect: f32) -> vec2f {
  return (w - center) * scale * vec2f(1.0 / aspect, 1.0);
}

export fn hash1(n: u32) -> f32 {
  var x = n * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  x = (x >> 22u) ^ x;
  return f32(x) / 4294967295.0;
}
