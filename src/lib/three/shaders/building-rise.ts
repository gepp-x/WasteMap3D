import * as THREE from "three";

/**
 * Building material: MeshStandardMaterial (vertex colours, PBR lighting, shadows) patched with
 * onBeforeCompile so buildings rise out of the ground in an outward ripple:
 *
 *   k = smoothstep(0, 1, uRise · 1.6 − aDist · 0.6)      transformed.y *= k
 *
 * plus a subtle, uniform-driven tint toward the selected area's modelled risk class colour
 * (lerped on the GPU side, so scenario playback never rebuilds the merged geometry).
 */

export interface BuildingUniforms {
  uRise: { value: number };
  uTint: { value: THREE.Color };
  uTintAmount: { value: number };
}

export function createBuildingMaterial() {
  const uniforms: BuildingUniforms = {
    uRise: { value: 0 },
    uTint: { value: new THREE.Color("#46d98b") },
    uTintAmount: { value: 0 },
  };
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.82,
    metalness: 0.06,
    envMapIntensity: 0,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uRise = uniforms.uRise;
    shader.uniforms.uTint = uniforms.uTint;
    shader.uniforms.uTintAmount = uniforms.uTintAmount;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aDist;\nuniform float uRise;")
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nfloat riseK = smoothstep(0.0, 1.0, clamp(uRise * 1.6 - aDist * 0.6, 0.0, 1.0));\ntransformed.y *= max(riseK, 0.001);",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uTint;\nuniform float uTintAmount;")
      .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, uTint * 0.6, uTintAmount);");
  };
  material.customProgramCacheKey = () => "ui-building-rise-v1";
  return { material, uniforms };
}
