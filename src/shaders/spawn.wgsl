// Drops newly seen wallets into the simulation state at a given position.
struct SP { count: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<uniform> sp: SP;
@group(0) @binding(1) var<storage, read> list: array<vec4f>;        // slot, x, y, unused
@group(0) @binding(2) var<storage, read_write> state: array<vec4f>;  // xy position, zw velocity

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= sp.count) { return; }
  let e = list[id.x];
  state[u32(e.x)] = vec4f(e.y, e.z, 0.0, 0.0);
}
