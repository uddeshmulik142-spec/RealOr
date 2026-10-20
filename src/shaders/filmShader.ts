import { Skia } from '@shopify/react-native-skia';

export type FilmProfile = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface FilmShaderSettings {
  profile: FilmProfile;
  grain: number;
  halation: number;
  exposure: number;
  vignette: number;
  seed?: number;
}

export const filmShaderSource = `
uniform shader image;
uniform shader u_previousFrame;
uniform float2 u_prevResolution;
uniform float u_mxMix;
uniform float2 u_resolution;
uniform float u_profile;
uniform float u_grain;
uniform float u_halation;
uniform float u_seed;
uniform float u_exposure;
uniform float u_vignette;
uniform float u_manualFocus;
uniform float u_focusDistance;
uniform float2 u_meterPoint;
uniform float u_pushPull;

float hash(float2 p) {
  p = fract(p * float2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}

float3 toLinear(float3 c) {
  return pow(max(c, float3(0.0)), float3(2.2));
}

float3 toSRGB(float3 c) {
  return pow(max(c, float3(0.0)), float3(1.0 / 2.2));
}

float3 filmDensityCurve(float3 x, float toe, float shoulder) {
  float3 a = float3(toe);
  float3 b = float3(shoulder);
  return (x * (x + a)) / (x * (x + a) + b);
}

half4 main(float2 xy) {
  float2 uv = xy / u_resolution;

  float2 centerOffset = uv - 0.5;
  float aberrationStrength = 0.0035;
  float2 redCoord = xy + centerOffset * aberrationStrength * u_resolution;
  float2 blueCoord = xy - centerOffset * aberrationStrength * u_resolution;

  float rChannel = toLinear(image.eval(redCoord).rgb).r;
  float gChannel = toLinear(image.eval(xy).rgb).g;
  float bChannel = toLinear(image.eval(blueCoord).rgb).b;
  float3 center = float3(rChannel, gChannel, bChannel);

  center *= pow(2.0, u_exposure);

  float3 n1 = toLinear(image.eval(xy + float2(0.8, 0.0)).rgb);
  float3 n2 = toLinear(image.eval(xy - float2(0.8, 0.0)).rgb);
  float3 n3 = toLinear(image.eval(xy + float2(0.0, 0.8)).rgb);
  float3 n4 = toLinear(image.eval(xy - float2(0.0, 0.8)).rgb);
  float3 linearRGB = center * 0.55 + (n1 + n2 + n3 + n4) * 0.1125;

  if (u_mxMix > 0.01) {
    float2 previousCoord = (xy / u_resolution) * u_prevResolution;
    float3 previousSample = u_previousFrame.eval(previousCoord).rgb;
    linearRGB += toLinear(previousSample) * u_mxMix;
  }

  float radius = max(2.0, min(u_resolution.x, u_resolution.y) * 0.0045);
  float diagonalRadius = radius * 0.70710678;
  float3 h1 = toLinear(image.eval(xy + float2(0.0, -radius)).rgb);
  float3 h2 = toLinear(image.eval(xy + float2(diagonalRadius, -diagonalRadius)).rgb);
  float3 h3 = toLinear(image.eval(xy + float2(radius, 0.0)).rgb);
  float3 h4 = toLinear(image.eval(xy + float2(diagonalRadius, diagonalRadius)).rgb);
  float3 h5 = toLinear(image.eval(xy + float2(0.0, radius)).rgb);
  float3 h6 = toLinear(image.eval(xy + float2(-diagonalRadius, diagonalRadius)).rgb);
  float3 h7 = toLinear(image.eval(xy + float2(-radius, 0.0)).rgb);
  float3 h8 = toLinear(image.eval(xy + float2(-diagonalRadius, -diagonalRadius)).rgb);
  float3 localAvg = (h1 + h2 + h3 + h4 + h5 + h6 + h7 + h8) * 0.125;
  float highlightLum = dot(localAvg, float3(0.2126, 0.7152, 0.0722));
  float halationMultiplier =
    (u_profile > 2.5 && u_profile < 3.5) ? 1.8 : 1.0;
  float halationMask =
    smoothstep(0.55, 1.2, highlightLum) * u_halation * halationMultiplier;
  if (u_profile > 4.5 && u_profile < 6.5) {
    linearRGB += float3(1.0) * halationMask * 0.45;
  } else {
    linearRGB += float3(1.0, 0.22, 0.02) * halationMask * 0.45;
  }

  if (u_manualFocus > 0.5) {
    float2 focusCenter = u_resolution * 0.5;
    float focusPatchDistance = distance(xy, focusCenter);
    float focusPatchRadius = 65.0;

    if (focusPatchDistance < focusPatchRadius) {
      float splitOffset = (u_focusDistance - 0.5) * 24.0;
      float splitDirection = xy.y < focusCenter.y ? 1.0 : -1.0;
      float2 splitCoord = xy + float2(splitDirection * splitOffset, 0.0);
      float3 splitSample = toLinear(image.eval(splitCoord).rgb);
      linearRGB = mix(linearRGB, splitSample, 0.85);

      if (focusPatchDistance > 63.0 && focusPatchDistance < 65.0) {
        linearRGB += float3(0.9, 0.7, 0.2) * 0.4;
      }
    }
  }

  float contrastModifier = 1.0 + (u_pushPull * 0.15);
  linearRGB = max(
    (linearRGB - float3(0.18)) * contrastModifier + float3(0.18),
    float3(0.0)
  );

  float3 graded = linearRGB;

  if (u_profile < 0.5) {
    graded.r = dot(linearRGB, float3(1.07, 0.03, -0.04));
    graded.g = dot(linearRGB, float3(0.02, 0.99, -0.01));
    graded.b = dot(linearRGB, float3(-0.02, 0.05, 0.85));
    graded = filmDensityCurve(max(graded, 0.0), 0.17, 0.23);
    graded += float3(0.014, 0.010, 0.006);
  } else if (u_profile < 1.5) {
    graded.r = dot(linearRGB, float3(0.93, 0.04, -0.02));
    graded.g = dot(linearRGB, float3(-0.03, 1.06, 0.01));
    graded.b = dot(linearRGB, float3(-0.04, 0.09, 1.03));
    graded = filmDensityCurve(max(graded, 0.0), 0.11, 0.27);
    graded += float3(0.005, 0.011, 0.015);
  } else if (u_profile < 2.5) {
    graded.r = dot(linearRGB, float3(1.09, -0.04, -0.03));
    graded.g = dot(linearRGB, float3(-0.02, 1.01, 0.01));
    graded.b = dot(linearRGB, float3(-0.01, 0.02, 1.03));
    graded = filmDensityCurve(max(graded, 0.0), 0.08, 0.29);
  } else if (u_profile < 3.5) {
    graded.r = dot(linearRGB, float3(0.95, 0.08, -0.03));
    graded.g = dot(linearRGB, float3(-0.02, 1.02, 0.02));
    graded.b = dot(linearRGB, float3(-0.05, 0.12, 1.15));
    graded = filmDensityCurve(max(graded, 0.0), 0.12, 0.22);
    graded += float3(0.0, 0.01, 0.035);
  } else if (u_profile < 4.5) {
    graded.r = dot(linearRGB, float3(0.90, 0.08, -0.02));
    graded.g = dot(linearRGB, float3(-0.05, 1.12, -0.02));
    graded.b = dot(linearRGB, float3(-0.03, 0.04, 0.92));
    graded = filmDensityCurve(max(graded, 0.0), 0.19, 0.21);
    graded += float3(0.008, 0.018, 0.012);
  } else if (u_profile < 5.5) {
    float luma = dot(linearRGB, float3(0.299, 0.587, 0.114));
    graded = float3(luma);
    graded = filmDensityCurve(max(graded, 0.0), 0.22, 0.18);
  } else if (u_profile < 6.5) {
    float luma = dot(linearRGB, float3(0.2126, 0.7152, 0.0722));
    graded = float3(luma);
    graded = filmDensityCurve(max(graded, 0.0), 0.10, 0.28);
  } else if (u_profile < 7.5) {
    graded.r = dot(linearRGB, float3(1.12, -0.05, -0.02));
    graded.g = dot(linearRGB, float3(-0.02, 1.08, -0.02));
    graded.b = dot(linearRGB, float3(-0.04, 0.02, 1.10));
    graded = filmDensityCurve(max(graded, 0.0), 0.06, 0.35);
  } else {
    graded.r = dot(linearRGB, float3(1.15, -0.02, -0.05));
    graded.g = dot(linearRGB, float3(0.01, 1.05, -0.02));
    graded.b = dot(linearRGB, float3(-0.02, 0.02, 0.95));
    graded = filmDensityCurve(max(graded, 0.0), 0.15, 0.25);
    graded += float3(0.02, 0.008, 0.004);
  }

  float3 displayRGB = toSRGB(graded);

  if (u_vignette > 0.05) {
    float distFromCenter = distance(uv, float2(0.5, 0.5));
    float vig = smoothstep(
      0.85,
      0.2,
      distFromCenter * (1.0 + u_vignette * 0.2)
    );
    displayRGB *= mix(1.0 - (u_vignette * 0.35), 1.0, vig);
  }

  float grainAmount =
    u_grain * (1.0 + max(0.0, u_pushPull * 0.6));
  if (u_profile > 4.5 && u_profile < 5.5) grainAmount *= 1.6;
  if (u_profile > 2.5 && u_profile < 3.5) grainAmount *= 1.3;

  float luma = dot(displayRGB, float3(0.299, 0.587, 0.114));
  float midtoneWeight = 4.0 * luma * (1.0 - luma);
  float2 seededXY = xy + float2(u_seed, u_seed * 1.37);
  float coarseGrain = hash(floor(seededXY * 0.55));
  float fineGrain = hash(floor(seededXY * 1.1));
  float grain = mix(coarseGrain, fineGrain, 0.35);
  float n = (grain - 0.5) * grainAmount * midtoneWeight;

  if (u_profile > 4.5 && u_profile < 6.5) {
    displayRGB += float3(n);
  } else {
    displayRGB.r += n * 1.05;
    displayRGB.g += n * 0.95;
    displayRGB.b += n * 1.10;
  }

  if (u_meterPoint.x > 0.0 && u_meterPoint.y > 0.0) {
    float2 meterOffset = xy - u_meterPoint;
    float meterDistance = length(meterOffset);
    float meterAbsX = abs(meterOffset.x);
    float meterAbsY = abs(meterOffset.y);
    bool meterRing = abs(meterDistance - 5.0) < 1.0;
    bool meterCrosshair =
      (meterAbsY < 0.8 && meterAbsX > 7.0 && meterAbsX < 13.0) ||
      (meterAbsX < 0.8 && meterAbsY > 7.0 && meterAbsY < 13.0);
    if (meterRing || meterCrosshair) {
      float meterLuma = dot(displayRGB, float3(0.2126, 0.7152, 0.0722));
      float3 meterColor =
        meterLuma > 0.5 ? float3(0.02) : float3(1.0, 0.7, 0.0);
      displayRGB = mix(displayRGB, meterColor, 0.95);
    }
  }

  return half4(clamp(displayRGB, 0.0, 1.0), 1.0);
}
`;

let cachedFilmRuntimeEffect: ReturnType<typeof Skia.RuntimeEffect.Make> | undefined;

export function createFilmRuntimeEffect() {
  if (cachedFilmRuntimeEffect === undefined) {
    cachedFilmRuntimeEffect = Skia.RuntimeEffect.Make(filmShaderSource);
  }

  if (cachedFilmRuntimeEffect === null) {
    throw new Error('Unable to compile the film shader.');
  }

  return cachedFilmRuntimeEffect;
}
