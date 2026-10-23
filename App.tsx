import React, { useEffect, useRef, useState } from 'react';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import {
  Image,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Haptics from 'expo-haptics';
import {
  useCameraDevice,
  useCameraPermission,
  type CameraDevice,
} from 'react-native-vision-camera';
import {
  SkiaCamera,
  type SkiaCameraProps,
} from 'react-native-vision-camera-skia';
import {
  FilterMode,
  ImageFormat,
  MipmapMode,
  Skia,
  TileMode,
  AlphaType,
  ColorType,
  type SkPaint,
  type SkShader,
  type SkSurface,
} from '@shopify/react-native-skia';
import { createSynchronizable, scheduleOnRN } from 'react-native-worklets';
import { saveEncodedPhotoToLibrary } from './src/utils/saveEncodedPhotoToLibrary';
import Archive, { type ArchivePhoto } from './src/screens/Archive';
import {
  createFilmRuntimeEffect,
  type FilmProfile,
} from './src/shaders/filmShader';

const FILM_STOCKS: { id: FilmProfile; name: string }[] = [
  { id: 0, name: 'PORTRA 400' },
  { id: 1, name: 'CLASSIC CHROME' },
  { id: 2, name: 'LEICA M' },
  { id: 3, name: 'CINESTILL 800T' },
  { id: 4, name: 'CLASSIC NEG' },
  { id: 5, name: 'TRI-X 400' },
  { id: 6, name: 'ACROS 100' },
  { id: 7, name: 'EKTACHROME' },
  { id: 8, name: 'AGFA VISTA' },
];
const FILM_DX_COLORS: Record<FilmProfile, { backgroundColor: string; textColor: string }> = {
  0: { backgroundColor: '#f2cf38', textColor: '#17130a' },
  1: { backgroundColor: '#a8b7ad', textColor: '#101613' },
  2: { backgroundColor: '#bd2525', textColor: '#fff4e4' },
  3: { backgroundColor: '#d8ad45', textColor: '#17130a' },
  4: { backgroundColor: '#73945a', textColor: '#10150c' },
  5: { backgroundColor: '#f0eee5', textColor: '#111111' },
  6: { backgroundColor: '#d9d7c9', textColor: '#111111' },
  7: { backgroundColor: '#4f78ad', textColor: '#f5f5f7' },
  8: { backgroundColor: '#dc7942', textColor: '#17100c' },
};
const exposureStops = [-2, -1, 0, 1, 2] as const;
const PUSH_PULL_STOPS = [
  { value: -1, label: '-1' },
  { value: 0, label: 'BOX' },
  { value: 1, label: '+1' },
  { value: 2, label: '+2' },
] as const;
const aspectRatios = ['3:4', '6:7', '1:1', '16:9'] as const;
type AspectRatio = (typeof aspectRatios)[number];
type FilmShaderUniformValues = {
  width: number;
  height: number;
  filmProfile: number;
  grain: number;
  halation: number;
  seed: number;
  exposure: number;
  vignette: number;
  manualFocus: number;
  focusDistance: number;
  meterX: number;
  meterY: number;
  pushPull: number;
};

const FILM_SHADER_UNIFORM_COUNT = 11;
const FILM_SHADER_VALUE_FLOAT_COUNT = 13;
const FILM_SHADER_RUNTIME_FLOAT_COUNT = 16;

function buildShaderUniforms(
  effect: ReturnType<typeof createFilmRuntimeEffect>,
  values: FilmShaderUniformValues,
): number[] {
  'worklet';

  const uniformCount = effect.getUniformCount();
  const expectedFloatCount = effect.getUniformFloatCount();
  if (
    uniformCount !== FILM_SHADER_UNIFORM_COUNT ||
    expectedFloatCount !== FILM_SHADER_RUNTIME_FLOAT_COUNT
  ) {
    throw new Error(
      `Film shader layout changed (uniforms: ${uniformCount}, floats: ${expectedFloatCount}); update buildShaderUniforms to match the SkSL declarations.`,
    );
  }

  // Fill by Skia's slots so any reserved layout padding stays zero.
  const uniforms = new Array<number>(expectedFloatCount).fill(0);
  const seenUniforms = new Array<boolean>(uniformCount).fill(false);
  let assignedFloatCount = 0;

  for (let index = 0; index < uniformCount; index += 1) {
    const name = effect.getUniformName(index);
    const uniform = effect.getUniform(index);
    let uniformValues: number[];
    let schemaIndex: number;

    switch (name) {
      case 'u_resolution':
        uniformValues = [values.width, values.height];
        schemaIndex = 0;
        break;
      case 'u_profile':
        uniformValues = [values.filmProfile];
        schemaIndex = 1;
        break;
      case 'u_grain':
        uniformValues = [values.grain];
        schemaIndex = 2;
        break;
      case 'u_halation':
        uniformValues = [values.halation];
        schemaIndex = 3;
        break;
      case 'u_seed':
        uniformValues = [values.seed];
        schemaIndex = 4;
        break;
      case 'u_exposure':
        uniformValues = [values.exposure];
        schemaIndex = 5;
        break;
      case 'u_vignette':
        uniformValues = [values.vignette];
        schemaIndex = 6;
        break;
      case 'u_manualFocus':
        uniformValues = [values.manualFocus];
        schemaIndex = 7;
        break;
      case 'u_focusDistance':
        uniformValues = [values.focusDistance];
        schemaIndex = 8;
        break;
      case 'u_meterPoint':
        uniformValues = [values.meterX, values.meterY];
        schemaIndex = 9;
        break;
      case 'u_pushPull':
        uniformValues = [values.pushPull];
        schemaIndex = 10;
        break;
      default:
        throw new Error(`Film shader uniform "${name}" has no value mapping.`);
    }

    if (seenUniforms[schemaIndex]) {
      throw new Error(`Film shader uniform "${name}" is declared more than once.`);
    }
    seenUniforms[schemaIndex] = true;

    if (uniform.columns * uniform.rows !== uniformValues.length) {
      throw new Error(
        `Film shader uniform "${name}" expects ${uniform.columns * uniform.rows} values; received ${uniformValues.length}.`,
      );
    }
    if (
      uniform.slot < 0 ||
      uniform.slot + uniformValues.length > uniforms.length
    ) {
      throw new Error(`Film shader uniform "${name}" has an invalid float slot.`);
    }

    for (let valueIndex = 0; valueIndex < uniformValues.length; valueIndex += 1) {
      uniforms[uniform.slot + valueIndex] = uniformValues[valueIndex];
    }
    assignedFloatCount += uniformValues.length;
  }

  for (let index = 0; index < seenUniforms.length; index += 1) {
    if (!seenUniforms[index]) {
      throw new Error(`Film shader uniform mapping ${index} was not applied.`);
    }
  }
  if (assignedFloatCount !== FILM_SHADER_VALUE_FLOAT_COUNT) {
    throw new Error(
      `Film shader values contain ${assignedFloatCount} floats; expected ${FILM_SHADER_VALUE_FLOAT_COUNT}.`,
    );
  }
  if (uniforms.length !== expectedFloatCount) {
    throw new Error(
      `Film shader uniforms contain ${uniforms.length} floats; expected ${expectedFloatCount}.`,
    );
  }

  return uniforms;
}

function getAspectRatioValue(ratio: AspectRatio): number {
  'worklet';

  switch (ratio) {
    case '6:7':
      return 6 / 7;
    case '1:1':
      return 1;
    case '16:9':
      return 16 / 9;
    default:
      return 3 / 4;
  }
}

function getZoneReadout(zone: number): string {
  'worklet';

  switch (zone) {
    case 0:
      return 'ZONE 0 (PURE BLACK)';
    case 1:
      return 'ZONE I';
    case 2:
      return 'ZONE II';
    case 3:
      return 'ZONE III (SHADOW DETAIL)';
    case 4:
      return 'ZONE IV';
    case 5:
      return 'ZONE V (MIDTONE)';
    case 6:
      return 'ZONE VI';
    case 7:
      return 'ZONE VII';
    case 8:
      return 'ZONE VIII (HIGHLIGHT)';
    case 9:
      return 'ZONE IX';
    default:
      return 'ZONE X (PURE WHITE)';
  }
}

function getNeutralZoomFactor(device: CameraDevice | undefined): number {
  if (!device) return 1;

  if ('neutralZoomFactor' in device) {
    const neutralZoomFactor = device.neutralZoomFactor;
    if (
      typeof neutralZoomFactor === 'number' &&
      Number.isFinite(neutralZoomFactor) &&
      neutralZoomFactor > 0
    ) {
      return neutralZoomFactor;
    }
  }

  if ('neutralZoom' in device) {
    const neutralZoom = device.neutralZoom;
    if (
      typeof neutralZoom === 'number' &&
      Number.isFinite(neutralZoom) &&
      neutralZoom > 0
    ) {
      return neutralZoom;
    }
  }

  return device.minZoom < 1 ? 1 : 2;
}

function clampZoom(zoom: number, device: CameraDevice): number {
  return Math.min(device.maxZoom, Math.max(device.minZoom, zoom));
}

export default function RealOrCamera() {
  const [lens, setLens] = useState<'0.5x' | '1x' | '2x' | '5x'>('1x');
  const multiLensDevice = useCameraDevice('back', {
    physicalDevices: ['ultra-wide-angle', 'wide-angle', 'telephoto'],
  });
  const defaultBackDevice = useCameraDevice('back');
  const device = multiLensDevice ?? defaultBackDevice;
  const minZ = device?.minZoom ?? 1;
  const neutralZ = getNeutralZoomFactor(device);
  const zoomLevels = {
    '0.5x': device ? clampZoom(minZ, device) : minZ,
    '1x': device ? clampZoom(neutralZ, device) : neutralZ,
    '2x': device ? clampZoom(neutralZ * 2, device) : neutralZ * 2,
    '5x': device ? clampZoom(neutralZ * 5, device) : neutralZ * 5,
  };
  const zoom1x = zoomLevels['1x'];
  const [zoom, setZoom] = useState(zoom1x);
  const animatedZoom = useSharedValue(zoom);
  const shutterScale = useSharedValue(1);
  const [isWound, setIsWound] = useState(true);
  const isWoundRef = useRef(true);
  const leverProgress = useSharedValue(0);
  const [leverTrackWidth, setLeverTrackWidth] = useState(0);
  const leverTrackWidthRef = useRef(0);
  const shutterAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: shutterScale.value }],
  }));
  const leverAnimatedStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX:
          leverProgress.value * Math.max(0, leverTrackWidth - 36),
      },
    ],
  }));
  const zoomDeviceRef = useRef(device);
  const [exposure, setExposure] = useState<number>(0);
  const exposureTouchStart = useRef<{ x: number; y: number } | null>(null);
  const exposureStartY = useRef<number | null>(null);
  const exposureStartValue = useRef(0);
  const lastHapticEV = useRef<number>(0);
  const { hasPermission, canRequestPermission, requestPermission } =
    useCameraPermission();
  const captureRequested = React.useMemo(
    () => createSynchronizable(false, { fixedType: true }),
    [],
  );
  const meterSampleRequested = React.useMemo(
    () => createSynchronizable(false, { fixedType: true }),
    [],
  );
  const filmEffect = React.useMemo(() => createFilmRuntimeEffect(), []);
  const targetResolution = React.useMemo(() => {
    const resolutions = device?.getSupportedResolutions('stream') ?? [];
    return resolutions.reduce<(typeof resolutions)[number] | undefined>(
      (largest, resolution) => {
        if (
          !largest ||
          resolution.width * resolution.height >
            largest.width * largest.height
        ) {
          return resolution;
        }
        return largest;
      },
      undefined,
    );
  }, [device]);
  const [isCapturing, setIsCapturing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [filmProfile, setFilmProfile] = useState<FilmProfile>(0);
  const [pushPull, setPushPull] = useState(0);
  const [manualFocusActive, setManualFocusActive] = useState(false);
  const [focusDistance, setFocusDistance] = useState(0.5);
  const focusDistanceRef = useRef(0.5);
  const focusStartValue = useRef(0.5);
  const focusSliderWidth = useRef(0);
  const focusLastHapticValue = useRef(0.5);
  const [meterPoint, setMeterPoint] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [activeZoneLabel, setActiveZoneLabel] = useState('--');
  const activeZone = useSharedValue<string>('--');
  const viewfinderSize = useRef({ width: 0, height: 0 });
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('3:4');
  const [grainEnabled, setGrainEnabled] = useState(true);
  const [halationEnabled, setHalationEnabled] = useState(true);
  const [vignetteEnabled, setVignetteEnabled] = useState(true);
  const [capturedFrames, setCapturedFrames] = useState<ArchivePhoto[]>([]);
  const [archiveVisible, setArchiveVisible] = useState(false);
  const [photosTaken, setPhotosTaken] = useState(0);
  const latestPhotoUri = capturedFrames[0]?.uri ?? null;
  const statusTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const minExposure = device ? Math.max(-2, device.minExposureBias) : -2;
  const maxExposure = device ? Math.min(2, device.maxExposureBias) : 2;
  const boundedExposure = Math.min(
    maxExposure,
    Math.max(minExposure, exposure),
  );
  const activeFilm = FILM_STOCKS.find((profile) => profile.id === filmProfile);
  useEffect(() => {
    if (!device) return;
    if (zoomDeviceRef.current !== device) {
      zoomDeviceRef.current = device;
      setZoom(zoom1x);
      animatedZoom.value = zoom1x;
      return;
    }
    animatedZoom.value = withTiming(zoom, { duration: 350 });
  }, [animatedZoom, device, zoom, zoom1x]);

  const saveProcessedPhoto = React.useCallback(
    async (base64Data: string) => {
      try {
        const developedTimestamp = new Date().toISOString();
        const stock =
          FILM_STOCKS.find((profile) => profile.id === filmProfile)?.name ??
          String(filmProfile);
        const savedPhotoUri = await saveEncodedPhotoToLibrary(base64Data, {
          stock,
          focalLength: lens,
          ev: boundedExposure,
          developedTimestamp,
        });
        const capturedFrame: ArchivePhoto = {
          id: savedPhotoUri,
          uri: savedPhotoUri,
          createdAt: new Date(developedTimestamp),
          stock,
          focalLength: lens,
          ev: boundedExposure,
          developedTimestamp,
        };
        setCapturedFrames((previousFrames) => [
          capturedFrame,
          ...previousFrames,
        ]);
        setPhotosTaken((count) => count + 1);
        isWoundRef.current = false;
        setIsWound(false);
        setStatusMessage('Saved to camera roll');
        statusTimeout.current = setTimeout(() => setStatusMessage(null), 2200);
      } catch (error: unknown) {
        setStatusMessage(null);
        setErrorMessage(
          error instanceof Error ? error.message : 'Unable to save photo.',
        );
      } finally {
        setIsCapturing(false);
      }
    },
    [boundedExposure, filmProfile, lens],
  );

  const failCapture = React.useCallback((message: string) => {
    setStatusMessage(null);
    setErrorMessage(message);
    setIsCapturing(false);
  }, []);

  const setMeterReadout = React.useCallback((readout: string) => {
    setActiveZoneLabel(readout);
    if (readout === 'METER ERROR') {
      setStatusMessage('SPOT METER SAMPLE UNAVAILABLE');
    }
  }, []);

  const renderFilmFrame = React.useCallback<SkiaCameraProps['onFrame']>(
    (frame, render) => {
      'worklet';

      try {
        render(({ canvas, frameTexture }) => {
          const width = frameTexture.width();
          const height = frameTexture.height();
          const dynamicSeed = (frame.timestamp / 1000) % 10000;
          if (meterSampleRequested.getBlocking() && meterPoint) {
            meterSampleRequested.setBlocking(false);
            const sampleX = Math.min(
              width - 1,
              Math.max(0, Math.floor(meterPoint.x * width)),
            );
            const sampleY = Math.min(
              height - 1,
              Math.max(0, Math.floor(meterPoint.y * height)),
            );
            try {
              const meterPixel = frameTexture.readPixels(sampleX, sampleY, {
                alphaType: AlphaType.Unpremul,
                colorType: ColorType.RGBA_8888,
                width: 1,
                height: 1,
              });
              if (!meterPixel || meterPixel.length < 3) {
                activeZone.value = 'METER ERROR';
                scheduleOnRN(setMeterReadout, 'METER ERROR');
              } else {
                const red = Math.pow(meterPixel[0] / 255, 2.2);
                const green = Math.pow(meterPixel[1] / 255, 2.2);
                const blue = Math.pow(meterPixel[2] / 255, 2.2);
                const luminance =
                  0.2126 * red + 0.7152 * green + 0.0722 * blue;
                const zone = Math.min(
                  10,
                  Math.max(0, Math.round(luminance * 10)),
                );
                const zoneReadout = getZoneReadout(zone);
                activeZone.value = zoneReadout;
                scheduleOnRN(setMeterReadout, zoneReadout);
              }
            } catch (error: unknown) {
              meterSampleRequested.setBlocking(false);
              activeZone.value = 'METER ERROR';
              console.warn('Unable to read the spot-meter pixel.', error);
              scheduleOnRN(setMeterReadout, 'METER ERROR');
            }
          }
          const singleCapture = captureRequested.getBlocking();
          const screenImageShader = frameTexture.makeShaderOptions(
            TileMode.Clamp,
            TileMode.Clamp,
            FilterMode.Linear,
            MipmapMode.None,
          );
          let screenShader: SkShader | undefined;
          let screenPaint: SkPaint | undefined;

          try {
            const screenUniforms = buildShaderUniforms(filmEffect, {
              width,
              height,
              filmProfile,
              grain: grainEnabled ? 0.35 : 0,
              halation: halationEnabled ? 0.65 : 0,
              seed: dynamicSeed,
              exposure: boundedExposure,
              vignette: vignetteEnabled ? 0.9 : 0,
              manualFocus: manualFocusActive ? 1.0 : 0.0,
              focusDistance,
              meterX: meterPoint ? meterPoint.x * width : 0,
              meterY: meterPoint ? meterPoint.y * height : 0,
              pushPull,
            });
            screenShader = filmEffect.makeShaderWithChildren(
              screenUniforms,
              [screenImageShader],
            );
            screenPaint = Skia.Paint();
            screenPaint.setShader(screenShader);
            canvas.drawRect(
              Skia.XYWHRect(0, 0, width, height),
              screenPaint,
            );

            if (singleCapture) {
              captureRequested.setBlocking(false);

              let surface: SkSurface | null = null;
              let snapshot: ReturnType<SkSurface['makeImageSnapshot']> | undefined;
              let highResImageShader: SkShader | undefined;
              let highResShader: SkShader | undefined;
              let offscreenPaint: SkPaint | undefined;
              try {
                const isLandscape =
                  frame.orientation === 'left' || frame.orientation === 'right';
                const outputWidth = isLandscape ? height : width;
                const outputHeight = isLandscape ? width : height;
                const targetRatio = getAspectRatioValue(aspectRatio);
                let cropWidth = outputWidth;
                let cropHeight = outputHeight;
                if (outputWidth / outputHeight > targetRatio) {
                  cropWidth = outputHeight * targetRatio;
                } else {
                  cropHeight = outputWidth / targetRatio;
                }
                const cropX = (outputWidth - cropWidth) / 2;
                const cropY = (outputHeight - cropHeight) / 2;
                const highResUniforms = buildShaderUniforms(filmEffect, {
                  width,
                  height,
                  filmProfile,
                  grain: grainEnabled ? 0.35 : 0,
                  halation: halationEnabled ? 0.65 : 0,
                  seed: dynamicSeed,
                  exposure: boundedExposure,
                  vignette: vignetteEnabled ? 0.9 : 0,
                  manualFocus: manualFocusActive ? 1.0 : 0.0,
                  focusDistance,
                  meterX: meterPoint ? meterPoint.x * width : 0,
                  meterY: meterPoint ? meterPoint.y * height : 0,
                  pushPull,
                });

                highResImageShader = frameTexture.makeShaderOptions(
                  TileMode.Clamp,
                  TileMode.Clamp,
                  FilterMode.Linear,
                  MipmapMode.None,
                );
                highResShader = filmEffect.makeShaderWithChildren(
                  highResUniforms,
                  [highResImageShader],
                );
                offscreenPaint = Skia.Paint();
                offscreenPaint.setShader(highResShader);

                surface = Skia.Surface.MakeOffscreen(outputWidth, outputHeight);
                if (!surface) {
                  throw new Error('Unable to create the high-resolution capture surface.');
                }

                const offscreenCanvas = surface.getCanvas();
                offscreenCanvas.save();
                try {
                  offscreenCanvas.translate(outputWidth / 2, outputHeight / 2);
                  if (frame.isMirrored) {
                    offscreenCanvas.scale(-1, 1);
                  }

                  let rotation = 0;
                  if (frame.orientation === 'right') {
                    rotation = 90;
                  } else if (frame.orientation === 'down') {
                    rotation = 180;
                  } else if (frame.orientation === 'left') {
                    rotation = 270;
                  }
                  const counterRotation = ((-rotation % 360) + 360) % 360;
                  offscreenCanvas.rotate(counterRotation, 0, 0);
                  if (isLandscape) {
                    offscreenCanvas.translate(
                      -outputHeight / 2,
                      -outputWidth / 2,
                    );
                  } else {
                    offscreenCanvas.translate(
                      -outputWidth / 2,
                      -outputHeight / 2,
                    );
                  }
                  offscreenCanvas.drawRect(
                    Skia.XYWHRect(0, 0, width, height),
                    offscreenPaint,
                  );
                } finally {
                  offscreenCanvas.restore();
                }

                snapshot = surface.makeImageSnapshot(
                  Skia.XYWHRect(cropX, cropY, cropWidth, cropHeight),
                );
                const base64Data = snapshot.encodeToBase64(ImageFormat.JPEG, 100);
                if (!base64Data) {
                  throw new Error('Unable to encode the processed camera frame.');
                }

                scheduleOnRN(saveProcessedPhoto, base64Data);
              } catch (error: unknown) {
                captureRequested.setBlocking(false);
                scheduleOnRN(failCapture, `Capture failed: ${error}`);
              } finally {
                snapshot?.dispose();
                surface?.dispose();
                offscreenPaint?.dispose();
                highResShader?.dispose();
                highResImageShader?.dispose();
              }
            }
          } catch (error: unknown) {
            captureRequested.setBlocking(false);
            scheduleOnRN(failCapture, `Capture failed: ${error}`);
          } finally {
            screenPaint?.dispose();
            screenShader?.dispose();
            screenImageShader.dispose();
          }
        });
      } catch (error: unknown) {
        captureRequested.setBlocking(false);
        scheduleOnRN(failCapture, `Capture failed: ${error}`);
      } finally {
        frame.dispose();
      }
    },
    [
      captureRequested,
      aspectRatio,
      failCapture,
      filmEffect,
      filmProfile,
      grainEnabled,
      halationEnabled,
      boundedExposure,
      vignetteEnabled,
      manualFocusActive,
      focusDistance,
      meterPoint,
      meterSampleRequested,
      activeZone,
      setMeterReadout,
      pushPull,
      saveProcessedPhoto,
    ],
  );

  useEffect(
    () => () => {
      if (statusTimeout.current) clearTimeout(statusTimeout.current);
    },
    [],
  );

  useEffect(() => {
    if (!hasPermission && canRequestPermission) {
      void requestPermission().catch((error: unknown) => {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : 'Unable to request camera permission.',
        );
      });
    }
  }, [canRequestPermission, hasPermission, requestPermission]);

  const takePhoto = () => {
    if (!device || !hasPermission || isCapturing || !isWoundRef.current) return;

    if (statusTimeout.current) clearTimeout(statusTimeout.current);
    setIsCapturing(true);
    setErrorMessage(null);
    setStatusMessage('Capturing high-resolution frame…');
    captureRequested.setBlocking(true);
  };

  const advanceFilm = React.useCallback(() => {
    if (isWoundRef.current) return;
    isWoundRef.current = true;
    setIsWound(true);
    leverProgress.value = withSpring(0, { damping: 14, stiffness: 180 });
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid).catch(
      (error: unknown) => {
        console.warn('Unable to play film-advance ratchet feedback.', error);
      },
    );
  }, [leverProgress]);

  const filmAdvancePanResponder = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_, gestureState) =>
          !isWoundRef.current &&
          gestureState.dx > 8 &&
          Math.abs(gestureState.dx) > Math.abs(gestureState.dy),
        onPanResponderGrant: () => {
          leverProgress.value = 0;
        },
        onPanResponderMove: (_, gestureState) => {
          const availableTravel = Math.max(1, leverTrackWidthRef.current - 36);
          leverProgress.value = Math.min(
            1,
            Math.max(0, gestureState.dx / availableTravel),
          );
        },
        onPanResponderRelease: (_, gestureState) => {
          const availableTravel = Math.max(1, leverTrackWidthRef.current - 36);
          if (gestureState.dx / availableTravel >= 0.9) {
            advanceFilm();
          } else {
            leverProgress.value = withSpring(0, {
              damping: 14,
              stiffness: 180,
            });
          }
        },
        onPanResponderTerminate: () => {
          leverProgress.value = withSpring(0, {
            damping: 14,
            stiffness: 180,
          });
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [advanceFilm, leverProgress],
  );

  const handleShutter = () => {
    if (!device || !hasPermission || isCapturing || !isWoundRef.current) return;

    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(
      (error: unknown) => {
        console.warn('Unable to play shutter haptic feedback.', error);
      },
    );
    void takePhoto();
  };

  const selectAspectRatio = (ratio: AspectRatio) => {
    void Haptics.selectionAsync().catch((error: unknown) => {
      console.warn('Unable to play aspect-ratio selection haptic feedback.', error);
    });
    setAspectRatio(ratio);
  };

  const updateExposureFromDrag = (pageY: number) => {
    if (exposureStartY.current === null || !device) return;

    const nextExposure =
      exposureStartValue.current - (pageY - exposureStartY.current) / 80;
    const clampedExposure = Math.min(
      maxExposure,
      Math.max(minExposure, nextExposure),
    );
    const newEV = Math.round(clampedExposure * 10) / 10;
    if (Math.abs(newEV - lastHapticEV.current) >= 0.1) {
      void Haptics.selectionAsync().catch((error: unknown) => {
        console.warn('Unable to play exposure detent haptic feedback.', error);
      });
      lastHapticEV.current = newEV;
    }
    setExposure(newEV);
  };

  const selectExposure = (value: number) => {
    if (!device) return;
    const newEV = Math.round(
      Math.min(maxExposure, Math.max(minExposure, value)) * 10,
    ) / 10;
    lastHapticEV.current = newEV;
    setExposure(newEV);
  };
  const updateFocusDistance = React.useCallback((value: number) => {
    const nextFocusDistance = Math.min(1, Math.max(0, value));
    focusDistanceRef.current = nextFocusDistance;
    setFocusDistance(nextFocusDistance);

    if (Math.abs(nextFocusDistance - focusLastHapticValue.current) >= 0.05) {
      focusLastHapticValue.current = nextFocusDistance;
      void Haptics.selectionAsync().catch((error: unknown) => {
        console.warn('Unable to play manual-focus detent feedback.', error);
      });
    }
  }, []);
  const focusPanResponder = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => manualFocusActive,
        onMoveShouldSetPanResponder: (_, gestureState) =>
          manualFocusActive &&
          Math.abs(gestureState.dx) > 4 &&
          Math.abs(gestureState.dx) > Math.abs(gestureState.dy),
        onPanResponderGrant: () => {
          focusStartValue.current = focusDistanceRef.current;
        },
        onPanResponderMove: (_, gestureState) => {
          const rangeWidth = Math.max(1, focusSliderWidth.current);
          updateFocusDistance(
            focusStartValue.current + gestureState.dx / rangeWidth,
          );
        },
      }),
    [manualFocusActive, updateFocusDistance],
  );
  const toggleManualFocus = () => {
    void Haptics.selectionAsync().catch((error: unknown) => {
      console.warn('Unable to play focus mode selection feedback.', error);
    });
    setManualFocusActive((active) => !active);
  };
  const selectLens = (lensOption: typeof lens) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid).catch((error: unknown) => {
      console.warn('Unable to play lens selection haptic feedback.', error);
    });
    setLens(lensOption);
    setZoom(zoomLevels[lensOption]);
  };
  const selectFilmProfile = (profile: FilmProfile) => {
    void Haptics.selectionAsync().catch((error: unknown) => {
      console.warn('Unable to play film selection haptic feedback.', error);
    });
    setFilmProfile(profile);
  };
  const selectPushPull = (value: number) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid).catch(
      (error: unknown) => {
        console.warn('Unable to play development dial haptic feedback.', error);
      },
    );
    setPushPull(value);
  };
  const toggleEffect = (
    setEnabled: (update: (enabled: boolean) => boolean) => void,
  ) => {
    void Haptics.selectionAsync().catch((error: unknown) => {
      console.warn('Unable to play effect toggle haptic feedback.', error);
    });
    setEnabled((enabled) => !enabled);
  };
  const selectedExposureStop = exposureStops.reduce((nearest, stop) =>
    Math.abs(stop - boundedExposure) < Math.abs(nearest - boundedExposure)
      ? stop
      : nearest,
  );
  const targetRatioNum = getAspectRatioValue(aspectRatio);
  const bladeHeightPercent = Math.max(
    0,
    ((1 - 0.75 / targetRatioNum) / 2) * 100,
  );

  if (!hasPermission) {
    return (
      <View style={styles.messageContainer}>
        <StatusBar style="light" />
        <Text style={styles.message}>
          {canRequestPermission
            ? 'Requesting camera permission…'
            : 'Camera access is disabled. Enable it in your device settings to continue.'}
        </Text>
        {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.messageContainer}>
        <StatusBar style="light" />
        <Text style={styles.message}>No back camera found.</Text>
      </View>
    );
  }

  return (
    <View
      style={styles.container}
      onTouchStart={(event) => {
        exposureTouchStart.current = {
          x: event.nativeEvent.pageX,
          y: event.nativeEvent.pageY,
        };
      }}
      onMoveShouldSetResponder={(event) => {
        const touchStart = exposureTouchStart.current;
        if (!touchStart) return false;
        const dx = event.nativeEvent.pageX - touchStart.x;
        const dy = event.nativeEvent.pageY - touchStart.y;
        return Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx);
      }}
      onResponderGrant={(event) => {
        exposureStartY.current =
          exposureTouchStart.current?.y ?? event.nativeEvent.pageY;
        exposureStartValue.current = boundedExposure;
      }}
      onResponderMove={(event) =>
        updateExposureFromDrag(event.nativeEvent.pageY)
      }
      onResponderRelease={() => {
        exposureStartY.current = null;
        exposureTouchStart.current = null;
      }}
      onResponderTerminate={() => {
        exposureStartY.current = null;
        exposureTouchStart.current = null;
      }}
    >
      <StatusBar style="light" />
      <View style={styles.topPlate}>
        <View style={styles.brandMark}>
          <View style={styles.brandDot} />
          <Text style={styles.brandText}>REALOR</Text>
          <Text style={[styles.brandEdition, styles.etchedLabel]}>
            RANGEFINDER · 35
          </Text>
        </View>
        <View style={styles.lcdPanel}>
          <Text style={styles.lcdReadout}>
            {isWound ? `[ ${24 - (photosTaken % 24)} EXP ]` : '[ UNWOUND ]'}
          </Text>
          <View style={styles.lcdDivider} />
          <View
            style={[
              styles.dxWindow,
              { backgroundColor: FILM_DX_COLORS[filmProfile].backgroundColor },
            ]}
          >
            <Text
              style={[
                styles.dxWindowText,
                { color: FILM_DX_COLORS[filmProfile].textColor },
              ]}
            >
              {activeFilm?.name ?? 'FILM'}
            </Text>
          </View>
          <View
            style={styles.batteryBadge}
            accessibilityLabel="Battery indicator"
          >
            <View style={styles.batteryCell} />
            <View style={styles.batteryCell} />
            <View style={styles.batteryCell} />
          </View>
          <Text style={styles.lcdReadout}>
            EV {boundedExposure >= 0 ? '+' : ''}{boundedExposure.toFixed(1)}
          </Text>
          <Animated.Text
            accessibilityLabel={`Spot meter ${activeZoneLabel}`}
            numberOfLines={1}
            style={styles.zoneReadout}
          >
            {activeZoneLabel}
          </Animated.Text>
        </View>
      </View>

      <View style={styles.viewfinderContainer}>
        <View
          style={styles.viewfinder}
          onLayout={(event) => {
            viewfinderSize.current = {
              width: event.nativeEvent.layout.width,
              height: event.nativeEvent.layout.height,
            };
          }}
        >
          <SkiaCamera
            style={StyleSheet.absoluteFill}
            device={device}
            isActive={!archiveVisible}
            allowHapticsAndSystemSoundsPlayback
            zoom={animatedZoom}
            constraints={[{ photoHDR: false }]}
            targetResolution={targetResolution}
            onFrame={renderFilmFrame}
            onError={(error) => setErrorMessage(error.message)}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Spot meter; tap to sample the scene"
            onPress={(event) => {
              const { width, height } = viewfinderSize.current;
              if (width <= 0 || height <= 0) return;
              const x = Math.min(
                0.999,
                Math.max(0.001, event.nativeEvent.locationX / width),
              );
              const y = Math.min(
                0.999,
                Math.max(0.001, event.nativeEvent.locationY / height),
              );
              setMeterPoint({ x, y });
              setActiveZoneLabel('METERING…');
              activeZone.value = 'METERING…';
              meterSampleRequested.setBlocking(true);
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(
                (error: unknown) => {
                  console.warn('Unable to play spot-meter haptic feedback.', error);
                },
              );
            }}
            style={StyleSheet.absoluteFill}
          />
          {bladeHeightPercent > 0 ? (
            <>
              <View
                pointerEvents="none"
                style={[
                  styles.matteBlade,
                  { top: 0, height: `${bladeHeightPercent}%` },
                ]}
              />
              <View
                pointerEvents="none"
                style={[
                  styles.matteBlade,
                  { bottom: 0, height: `${bladeHeightPercent}%` },
                ]}
              />
            </>
          ) : null}
          <View pointerEvents="none" style={styles.framelineCorners}>
            <View style={[styles.framelineCorner, styles.framelineTopLeft]} />
            <View style={[styles.framelineCorner, styles.framelineTopRight]} />
            <View style={[styles.framelineCorner, styles.framelineBottomLeft]} />
            <View style={[styles.framelineCorner, styles.framelineBottomRight]} />
          </View>
          <View pointerEvents="none" style={styles.viewfinderTopLine}>
            <Text style={styles.viewfinderLabel}>FRAME 01</Text>
            <View style={styles.liveDot} />
          </View>
          <View
            style={styles.exposureIndicator}
            accessibilityLabel={`Exposure ${boundedExposure >= 0 ? '+' : ''}${boundedExposure.toFixed(1)} EV`}
          >
            <Text style={styles.exposureValue}>
              EV {boundedExposure >= 0 ? '+' : ''}{boundedExposure.toFixed(1)}
            </Text>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Reset exposure to zero"
              onPress={() => selectExposure(0)}
              style={styles.exposureReset}
            >
              <Text style={styles.exposureResetText}>RESET</Text>
            </TouchableOpacity>
            <View style={styles.exposureScale}>
              {exposureStops.map((stop) => {
                const isSelected = selectedExposureStop === stop;
                const label = `${stop > 0 ? '+' : ''}${stop}`;
                return (
                  <TouchableOpacity
                    key={stop}
                    accessibilityRole="button"
                    accessibilityLabel={`Set exposure to ${label} EV`}
                    accessibilityState={{ selected: isSelected }}
                    onPress={() => selectExposure(stop)}
                    style={styles.exposureTickButton}
                  >
                    <Text
                      style={[
                        styles.exposureTickLabel,
                        isSelected && styles.exposureTickLabelSelected,
                      ]}
                    >
                      {label}
                    </Text>
                    <View
                      style={[
                        styles.exposureTick,
                        isSelected && styles.exposureTickSelected,
                      ]}
                    />
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
          <View pointerEvents="none" style={styles.viewfinderBottomLine}>
            <Text style={styles.viewfinderLabel}>
              {manualFocusActive
                ? `MF · ${focusDistance.toFixed(2)}`
                : 'AF · AE LOCK'}
            </Text>
            <Text style={styles.viewfinderLabel}>{lens}</Text>
          </View>
        </View>
      </View>

      <View style={styles.controls}>
        {errorMessage ? (
          <Text style={styles.error} accessibilityRole="alert">
            {errorMessage}
          </Text>
        ) : null}
        {statusMessage ? (
          <Text style={styles.status} accessibilityRole="status">
            {statusMessage}
          </Text>
        ) : null}
        <View style={styles.controlSection}>
          <Text style={[styles.sectionLabel, styles.etchedLabel]}>FILM STOCK</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.filmScroller}
            contentContainerStyle={styles.filmOptions}
          >
            {FILM_STOCKS.map((stock) => {
              const isSelected = filmProfile === stock.id;
              return (
                <Pressable
                  key={stock.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isSelected }}
                  onPress={() => selectFilmProfile(stock.id)}
                  style={({ pressed }) => [
                    styles.buttonInactive,
                    styles.filmButton,
                    isSelected && styles.filmButtonActive,
                    pressed && styles.controlButtonPressed,
                  ]}
                >
                  <Text
                    style={[
                      styles.textInactive,
                      isSelected && styles.filmTextActive,
                      styles.filmText,
                    ]}
                  >
                    {stock.name}
                  </Text>
                  {isSelected ? <View style={styles.activeIndicator} /> : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
        <View style={styles.developmentRow}>
          <Text style={[styles.sectionLabel, styles.etchedLabel]}>
            DEVELOPMENT
          </Text>
          <View style={styles.developmentSelector}>
            {PUSH_PULL_STOPS.map((stop) => {
              const isSelected = pushPull === stop.value;
              return (
                <Pressable
                  key={stop.value}
                  accessibilityRole="button"
                  accessibilityLabel={
                    stop.value === -1
                      ? 'Pull one stop'
                      : stop.value === 0
                        ? 'Box speed, normal development'
                        : `Push ${stop.value} stop${stop.value > 1 ? 's' : ''}`
                  }
                  accessibilityState={{ selected: isSelected }}
                  onPress={() => selectPushPull(stop.value)}
                  style={({ pressed }) => [
                    styles.developmentButton,
                    isSelected && styles.developmentButtonActive,
                    pressed && styles.controlButtonPressed,
                  ]}
                >
                  <Text
                    style={[
                      styles.developmentButtonText,
                      isSelected && styles.developmentButtonTextActive,
                    ]}
                  >
                    {stop.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
        <View style={styles.focusControlSection}>
          <View style={styles.focusControlHeader}>
            <Text style={[styles.sectionLabel, styles.etchedLabel]}>
              LENS FOCUS RING
            </Text>
            <Pressable
              accessibilityRole="switch"
              accessibilityLabel={`Manual focus ${manualFocusActive ? 'on' : 'off'}`}
              accessibilityState={{ checked: manualFocusActive }}
              onPress={toggleManualFocus}
              style={({ pressed }) => [
                styles.focusModeButton,
                manualFocusActive && styles.focusModeButtonActive,
                pressed && styles.controlButtonPressed,
              ]}
            >
              <Text
                style={[
                  styles.focusModeText,
                  manualFocusActive && styles.focusModeTextActive,
                ]}
              >
                FOCUS: {manualFocusActive ? 'MAN' : 'AUTO'}
              </Text>
            </Pressable>
          </View>
          {manualFocusActive ? (
            <View style={styles.focusSliderRow}>
              <Text style={styles.focusEndpoint}>MACRO</Text>
              <View
                accessible
                accessibilityRole="adjustable"
                accessibilityLabel="Manual focus distance"
                accessibilityValue={{
                  min: 0,
                  max: 1,
                  now: focusDistance,
                  text: focusDistance.toFixed(2),
                }}
                onLayout={(event) => {
                  focusSliderWidth.current = event.nativeEvent.layout.width;
                }}
                style={styles.focusSliderTrack}
                {...focusPanResponder.panHandlers}
              >
                <View pointerEvents="none" style={styles.focusSliderGroove} />
                <View
                  pointerEvents="none"
                  style={[
                    styles.focusSliderFill,
                    { width: `${focusDistance * 100}%` },
                  ]}
                />
                <View
                  pointerEvents="none"
                  style={[
                    styles.focusSliderThumb,
                    { left: `${focusDistance * 100}%` },
                  ]}
                />
              </View>
              <Text style={styles.focusEndpoint}>∞</Text>
            </View>
          ) : null}
        </View>
        <View style={styles.captureOptions}>
          <Text style={styles.captureOptionLabel}>MATTE</Text>
          <View style={styles.ratioOptions}>
            {aspectRatios.map((ratio) => {
              const isSelected = aspectRatio === ratio;
              return (
                <Pressable
                  key={ratio}
                  accessibilityRole="button"
                  accessibilityLabel={`Set crop ratio ${ratio}`}
                  accessibilityState={{ selected: isSelected }}
                  onPress={() => selectAspectRatio(ratio)}
                  style={({ pressed }) => [
                    styles.ratioButton,
                    isSelected && styles.ratioButtonActive,
                    pressed && styles.controlButtonPressed,
                  ]}
                >
                  <Text
                    style={[
                      styles.ratioButtonText,
                      isSelected && styles.ratioButtonTextActive,
                    ]}
                  >
                    {ratio}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
        <View style={styles.effectOptions}>
          <View style={styles.effectSwitch}>
            <Text style={styles.effectEtching}>HLTN</Text>
            <Pressable
              accessibilityLabel={`Halation ${halationEnabled ? 'on' : 'off'}`}
              accessibilityRole="switch"
              accessibilityState={{ checked: halationEnabled }}
              onPress={() => toggleEffect(setHalationEnabled)}
              style={({ pressed }) => [
                styles.effectButton,
                pressed && styles.controlButtonPressed,
              ]}
            >
              <View
                style={[
                  styles.effectLed,
                  halationEnabled ? styles.effectLedActive : styles.effectLedInactive,
                ]}
              />
            </Pressable>
          </View>
          <View style={styles.effectSwitch}>
            <Text style={styles.effectEtching}>GRN</Text>
            <Pressable
              accessibilityLabel={`Grain ${grainEnabled ? 'on' : 'off'}`}
              accessibilityRole="switch"
              accessibilityState={{ checked: grainEnabled }}
              onPress={() => toggleEffect(setGrainEnabled)}
              style={({ pressed }) => [
                styles.effectButton,
                pressed && styles.controlButtonPressed,
              ]}
            >
              <View
                style={[
                  styles.effectLed,
                  grainEnabled ? styles.effectLedActive : styles.effectLedInactive,
                ]}
              />
            </Pressable>
          </View>
          <View style={styles.effectSwitch}>
            <Text style={styles.effectEtching}>VGNT</Text>
            <Pressable
              accessibilityLabel={`Vignette ${vignetteEnabled ? 'on' : 'off'}`}
              accessibilityRole="switch"
              accessibilityState={{ checked: vignetteEnabled }}
              onPress={() => toggleEffect(setVignetteEnabled)}
              style={({ pressed }) => [
                styles.effectButton,
                pressed && styles.controlButtonPressed,
              ]}
            >
              <View
                style={[
                  styles.effectLed,
                  vignetteEnabled ? styles.effectLedActive : styles.effectLedInactive,
                ]}
              />
            </Pressable>
          </View>
        </View>
        <View style={styles.bottomDeck}>
          <TouchableOpacity
            accessibilityLabel="Open photo archive"
            accessibilityRole="button"
            onPress={() => setArchiveVisible(true)}
            style={styles.galleryThumbnail}
          >
            {latestPhotoUri ? (
              <Image
                source={{ uri: latestPhotoUri }}
                resizeMode="cover"
                style={styles.galleryImage}
              />
            ) : (
              <Text style={styles.galleryPlaceholder}>ROLL</Text>
            )}
          </TouchableOpacity>
          <View style={styles.lensCluster}>
            <Text style={[styles.sectionLabel, styles.etchedLabel]}>
              FOCAL LENGTH
            </Text>
            <View style={styles.lensSelector}>
              {(['0.5x', '1x', '2x', '5x'] as const).map((lensOption) => {
                const isSelected = lens === lensOption;
                return (
                  <Pressable
                    key={lensOption}
                    accessibilityRole="button"
                    accessibilityLabel={`Select ${lensOption} lens`}
                    accessibilityState={{ selected: isSelected }}
                    onPress={() => selectLens(lensOption)}
                    style={({ pressed }) => [
                      styles.buttonInactive,
                      styles.lensButtonLayout,
                      isSelected && styles.buttonActive,
                      pressed && styles.controlButtonPressed,
                    ]}
                  >
                    <Text
                      style={[
                        styles.textInactive,
                        isSelected && styles.textActive,
                      ]}
                    >
                      {lensOption}
                    </Text>
                    {isSelected ? <View style={styles.activeIndicator} /> : null}
                  </Pressable>
                );
              })}
            </View>
          </View>
          <View style={styles.deckSpacer} />
        </View>
      </View>
      <View style={styles.shutterAssembly}>
        <View style={styles.advanceLeverRow}>
          <Text style={[styles.meterLabel, styles.etchedLabel]}>
            FILM ADVANCE
          </Text>
          <View
            accessible
            accessibilityLabel={
              isWound
                ? 'Film advanced, shutter ready'
                : 'Swipe right to advance film and wind shutter'
            }
            accessibilityRole="button"
            onAccessibilityTap={advanceFilm}
            onLayout={(event) => {
              const width = event.nativeEvent.layout.width;
              leverTrackWidthRef.current = width;
              setLeverTrackWidth(width);
            }}
            style={styles.advanceTrack}
            {...filmAdvancePanResponder.panHandlers}
          >
            <View pointerEvents="none" style={styles.advanceTrackGroove} />
            <Animated.View
              pointerEvents="none"
              style={[
                styles.advanceThumb,
                isWound && styles.advanceThumbReady,
                leverAnimatedStyle,
              ]}
            />
            <Text pointerEvents="none" style={styles.advanceTrackLabel}>
              {isWound ? '[ READY ]' : 'SWIPE  →'}
            </Text>
          </View>
        </View>
        <View style={styles.shutterDeck}>
          <Text style={[styles.meterLabel, styles.etchedLabel]}>
            {isWound ? 'BULB' : '[ UNWOUND ]'}
          </Text>
          <Pressable
            accessibilityLabel="Take photo"
            accessibilityRole="button"
            disabled={isCapturing || !isWound}
            onPressIn={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(
                (error: unknown) => {
                  console.warn('Unable to play half-press haptic feedback.', error);
                },
              );
              shutterScale.value = withSpring(0.84, {
                damping: 14,
                stiffness: 320,
              });
            }}
            onPressOut={() => {
              shutterScale.value = withSpring(1, {
                damping: 10,
                stiffness: 260,
              });
            }}
            onPress={handleShutter}
            style={[
              styles.shutterOuter,
              (isCapturing || !isWound) && styles.shutterDisabled,
            ]}
          >
            <Animated.View
              style={[styles.shutterInner, shutterAnimatedStyle]}
            />
          </Pressable>
          <Text style={[styles.meterLabel, styles.etchedLabel]}>AUTO</Text>
        </View>
      </View>
      <Modal
        visible={archiveVisible}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setArchiveVisible(false)}
      >
        <Archive
          capturedFrames={capturedFrames}
          onClose={() => setArchiveVisible(false)}
        />
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#121212',
    paddingTop: 44,
    paddingBottom: 4,
    paddingHorizontal: 8,
  },
  messageContainer: {
    flex: 1,
    backgroundColor: '#121212',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  message: {
    color: '#e5e5ea',
    fontSize: 16,
    textAlign: 'center',
  },
  topPlate: {
    minHeight: 56, // SHRUNK from 76
    paddingHorizontal: 20,
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: '#38383a',
    borderBottomWidth: 1,
    borderBottomColor: '#050505',
    backgroundColor: '#1c1c1e',
  },
  brandMark: {
    alignItems: 'flex-start',
  },
  brandDot: {
    width: 6,
    height: 6,
    marginBottom: 2,
    borderRadius: 3,
    backgroundColor: '#d32f2f',
  },
  brandText: {
    color: '#e5e5ea',
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 2,
  },
  brandEdition: {
    marginTop: 2,
    color: '#8e8e93',
    fontSize: 6,
    fontWeight: '700',
    letterSpacing: 1,
  },
  lcdPanel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: '#373737',
    borderRadius: 5,
    backgroundColor: '#10100d',
  },
  lcdReadout: {
    color: '#ff9500',
    fontSize: 9,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.5,
  },
  zoneReadout: {
    maxWidth: 92,
    flexShrink: 1,
    color: '#d4af37',
    fontSize: 6,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.25,
  },
  lcdDivider: {
    width: 1,
    height: 16,
    backgroundColor: '#54401f',
  },
  dxWindow: {
    maxWidth: 96,
    paddingVertical: 3,
    paddingHorizontal: 5,
    borderTopWidth: 1,
    borderTopColor: '#ffffff80',
    borderBottomWidth: 2,
    borderBottomColor: '#00000088',
    borderRadius: 2,
  },
  dxWindowText: {
    fontSize: 7,
    fontWeight: '900',
    letterSpacing: 0.35,
  },
  lcdBadge: {
    maxWidth: 90,
    color: '#ffbf58',
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  batteryBadge: {
    width: 17,
    height: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 2,
    borderWidth: 1,
    borderColor: '#ff9500',
    borderRadius: 2,
  },
  batteryCell: {
    flex: 1,
    height: 4,
    backgroundColor: '#ff9500',
  },
  viewfinderContainer: {
    width: '100%',
    aspectRatio: 0.75,
    maxHeight: '46%',
    alignSelf: 'center',
    borderWidth: 2,
    borderColor: '#2c2c2e',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#050505',
  },
  viewfinder: {
    flex: 1,
    overflow: 'hidden',
    backgroundColor: '#050505',
  },
  matteBlade: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 5,
    backgroundColor: '#050505',
  },
  framelineCorners: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    margin: 38,
  },
  framelineCorner: {
    position: 'absolute',
    width: 18,
    height: 18,
    borderColor: '#ffffffbb',
  },
  framelineTopLeft: {
    top: 0,
    left: 0,
    borderTopWidth: 1,
    borderLeftWidth: 1,
  },
  framelineTopRight: {
    top: 0,
    right: 0,
    borderTopWidth: 1,
    borderRightWidth: 1,
  },
  framelineBottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 1,
    borderLeftWidth: 1,
  },
  framelineBottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 1,
    borderRightWidth: 1,
  },
  viewfinderTopLine: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 24,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#090909bb',
  },
  viewfinderBottomLine: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 24,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#090909bb',
  },
  viewfinderLabel: {
    color: '#e5e5ea',
    fontSize: 7,
    fontWeight: '700',
    letterSpacing: 1,
    textShadowColor: 'rgba(255,255,255,0.12)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 1,
  },
  etchedLabel: {
    textShadowColor: 'rgba(255,255,255,0.12)',
    textShadowOffset: { width: 0, height: 1 },
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#d32f2f',
  },
  controls: {
    width: '100%',
    paddingHorizontal: 12,
    paddingTop: 1,
    paddingBottom: 1,
    backgroundColor: '#1c1c1e',
    borderTopWidth: 1,
    borderTopColor: '#38383a',
  },
  controlSection: {
    width: '100%',
    alignItems: 'center',
    marginBottom: 1,      // Tightened margins
  },
  developmentRow: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
    paddingHorizontal: 8,
    // ... rest of styles
  },
  developmentSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    padding: 2,
    borderWidth: 1,
    borderColor: '#090909',
    borderRadius: 5,
    backgroundColor: '#101011',
  },
  developmentButton: {
    minWidth: 36,
    minHeight: 24,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
    borderWidth: 1,
    borderTopColor: '#4d4d50',
    borderLeftColor: '#39393c',
    borderRightColor: '#080808',
    borderBottomWidth: 2,
    borderBottomColor: '#080808',
    borderRadius: 3,
    backgroundColor: '#252527',
  },
  developmentButtonActive: {
    borderTopColor: '#fff0b3',
    borderLeftColor: '#d4af37',
    borderRightColor: '#665019',
    borderBottomColor: '#4c3a12',
    backgroundColor: '#8a6b24',
  },
  developmentButtonText: {
    color: '#a7a7ad',
    fontSize: 7,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  developmentButtonTextActive: {
    color: '#fff7dd',
  },
  focusControlSection: {
    width: '100%',
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginBottom: 2,
    // ... rest of styles
  },
  focusControlHeader: {
    minHeight: 26,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  focusModeButton: {
    minWidth: 80,
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderTopColor: '#525256',
    borderLeftColor: '#414145',
    borderRightColor: '#080808',
    borderBottomWidth: 2,
    borderBottomColor: '#080808',
    borderRadius: 4,
    backgroundColor: '#252527',
  },
  focusModeButtonActive: {
    borderTopColor: '#e5ca8a',
    borderLeftColor: '#b89042',
    backgroundColor: '#3b301e',
  },
  focusModeText: {
    color: '#a7a7ad',
    fontSize: 7,
    fontWeight: '900',
    letterSpacing: 0.9,
  },
  focusModeTextActive: {
    color: '#d4af37',
  },
  focusSliderRow: {
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 2,
  },
  focusEndpoint: {
    width: 32,
    color: '#8e8e93',
    fontSize: 7,
    fontWeight: '800',
    letterSpacing: 0.5,
    textAlign: 'center',
  },
  focusSliderTrack: {
    flex: 1,
    height: 24,
    justifyContent: 'center',
  },
  focusSliderGroove: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 4,
    borderWidth: 1,
    borderColor: '#080808',
    borderRadius: 2,
    backgroundColor: '#3a3a3c',
  },
  focusSliderFill: {
    position: 'absolute',
    left: 0,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#8a6b24',
  },
  focusSliderThumb: {
    position: 'absolute',
    width: 16,
    height: 20,
    marginLeft: -8,
    borderWidth: 1,
    borderTopColor: '#f2dc9b',
    borderLeftColor: '#c9a347',
    borderRightColor: '#3f3217',
    borderBottomWidth: 2,
    borderBottomColor: '#080808',
    borderRadius: 3,
    backgroundColor: '#a8842f',
    elevation: 3,
  },
  captureOptions: {
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
    paddingHorizontal: 2,
  },
  captureOptionLabel: {
    color: '#8e8e93',
    fontSize: 7,
    fontWeight: '800',
    letterSpacing: 1.3,
  },
  ratioOptions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  ratioButton: {
    minWidth: 34,
    minHeight: 26,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
    borderWidth: 1,
    borderTopWidth: 1,
    borderBottomWidth: 2,
    borderTopColor: '#535357',
    borderBottomColor: '#080808',
    borderLeftColor: '#414145',
    borderRightColor: '#080808',
    borderRadius: 4,
    backgroundColor: '#252527',
  },
  ratioButtonActive: {
    borderTopColor: '#ffffff',
    borderBottomColor: '#56565a',
    borderLeftColor: '#f5f5f7',
    borderRightColor: '#77777b',
    backgroundColor: '#d4d4d6',
  },
  ratioButtonText: {
    color: '#c7c7cc',
    fontSize: 8,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  ratioButtonTextActive: {
    color: '#121212',
  },
  sectionLabel: {
    marginBottom: 4,
    color: '#8e8e93',
    fontSize: 7,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
  status: {
    color: '#ffbf58',
    marginBottom: 4,
    fontSize: 9,
    fontWeight: '700',
    textAlign: 'center',
  },
  filmScroller: {
    width: '100%',
    flexGrow: 0,
  },
  filmOptions: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 3,
    borderWidth: 1,
    borderColor: '#454547',
    borderRadius: 7,
    backgroundColor: '#111112',
  },
  buttonInactive: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 5,
    borderTopWidth: 1,
    borderBottomWidth: 2,
    borderTopColor: '#535357',
    borderBottomColor: '#080808',
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderLeftColor: '#414145',
    borderRightColor: '#080808',
    backgroundColor: '#29292b',
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  buttonActive: {
    borderTopColor: '#ffd27a',
    borderBottomColor: '#6e3d00',
    borderLeftColor: '#ff9500',
    borderRightColor: '#6e3d00',
    backgroundColor: '#3a2b15',
  },
  filmButton: {
    borderTopColor: '#f5f5f7',
    paddingHorizontal: 8,
    borderBottomColor: '#080808',
    borderLeftColor: '#414145',
    borderRightColor: '#080808',
    backgroundColor: '#252527',
    marginHorizontal: 2,
  },
  filmButtonActive: {
    backgroundColor: '#d4d4d6',
    borderTopColor: '#ffffff',
    borderBottomColor: '#56565a',
    borderLeftColor: '#f5f5f7',
    borderRightColor: '#77777b',
  },
  filmText: {
    fontSize: 8,
    letterSpacing: 0.3,
  },
  filmTextActive: {
    color: '#121212',
  },
  textInactive: {
    color: '#c7c7cc',
    fontSize: 9,
    fontWeight: '700',
  },
  textActive: {
    color: '#ffbf58',
  },
  effectOptions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 16,
    marginBottom: 4,
  },
  effectSwitch: {
    alignItems: 'center',
    gap: 3,
  },
  effectEtching: {
    color: '#6e6e73',
    fontSize: 7,
    fontWeight: '700',
    letterSpacing: 1,
  },
  effectButton: {
    width: 36, // SHRUNK from 44
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    borderWidth: 1,
    borderTopColor: '#4d4d50',
    borderLeftColor: '#39393c',
    borderRightColor: '#090909',
    borderBottomColor: '#080808',
    backgroundColor: '#171719',
    elevation: 3,
  },
  effectLed: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  effectLedActive: {
    backgroundColor: '#ff9500',
    shadowColor: '#ff9500',
    shadowOpacity: 0.8,
    shadowRadius: 4,
    elevation: 4,
  },
  effectLedInactive: {
    backgroundColor: '#3a3a3c',
    borderWidth: 1,
    borderColor: '#242426',
  },
  lensSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 0,
    padding: 3,
    borderWidth: 1,
    borderColor: '#454547',
    borderRadius: 16,
    backgroundColor: '#111112',
  },
  lensButtonLayout: {
    minWidth: 42,
    justifyContent: 'center',
    borderRadius: 12,
    borderTopColor: '#77777b',
    borderLeftColor: '#555557',
    paddingHorizontal: 6,
  },
  activeIndicator: {
    width: 4,
    height: 4,
    marginLeft: 4,
    borderRadius: 2,
    backgroundColor: '#ff9500',
    shadowColor: '#ff9500',
    shadowOpacity: 0.9,
    shadowRadius: 3,
    elevation: 3,
  },
  controlButtonPressed: {
    transform: [{ translateY: 2 }],
    borderBottomWidth: 1,
  },
  exposureIndicator: {
    position: 'absolute',
    right: 8,
    top: '34%',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 6,
    borderWidth: 1,
    borderColor: '#ffffff33',
    borderRadius: 6,
    backgroundColor: '#111111d9',
  },
  exposureValue: {
    color: '#ff9500',
    fontSize: 9,
    fontWeight: '800',
    fontFamily: 'Courier',
    fontVariant: ['tabular-nums'],
  },
  exposureReset: {
    marginTop: 3,
    paddingVertical: 3,
    paddingHorizontal: 5,
    borderRadius: 3,
    backgroundColor: '#ffffff18',
  },
  exposureResetText: {
    color: '#c7c7cc',
    fontSize: 6,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  exposureScale: {
    marginTop: 4,
    alignItems: 'center',
  },
  exposureTickButton: {
    width: 36,
    height: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 5,
  },
  exposureTickLabel: {
    minWidth: 12,
    color: '#c7c7cc',
    fontSize: 8,
    fontFamily: 'Courier',
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
  exposureTickLabelSelected: {
    color: '#ff9500',
    fontWeight: '900',
  },
  exposureTick: {
    width: 8,
    height: 1,
    backgroundColor: '#c7c7cc',
  },
  exposureTickSelected: {
    width: 12,
    height: 2,
    backgroundColor: '#ff9500',
  },
  bottomDeck: {
    minHeight: 46, // SHRUNK from 65
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    backgroundColor: '#151516',
    borderTopWidth: 1,
    borderTopColor: '#080808',
  },
  galleryThumbnail: {
    width: 40, // SHRUNK from 48
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderRadius: 4,
    borderWidth: 2,
    borderTopColor: '#f1f1f3',
    borderLeftColor: '#b8b8ba',
    borderRightColor: '#777779',
    borderBottomColor: '#777779',
    backgroundColor: '#28282a',
  },
  galleryImage: {
    width: '100%',
    height: '100%',
  },
  galleryPlaceholder: {
    color: '#ff9500',
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1,
  },
  lensCluster: {
    alignItems: 'center',
  },
  deckSpacer: {
    width: 40,
  },
  shutterAssembly: {
    backgroundColor: '#1c1c1e',
  },
  advanceLeverRow: {
    minHeight: 36, // SHRUNK from 44
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: '#38383a',
    paddingHorizontal: 16,
    backgroundColor: '#171719',
  },
  advanceTrack: {
    width: 140, // SHRUNK
    height: 24, // SHRUNK
    justifyContent: 'center',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#080808',
    borderRadius: 12,
    backgroundColor: '#101011',
  },
  advanceTrackGroove: {
    position: 'absolute',
    left: 10,
    right: 10,
    height: 2,
    borderRadius: 1,
    backgroundColor: '#3a3a3c',
  },
  advanceThumb: {
    position: 'absolute',
    left: 2,
    width: 20,
    height: 18,
    borderWidth: 1,
    borderTopColor: '#858589',
    borderLeftColor: '#626266',
    borderRightColor: '#161618',
    borderBottomColor: '#080808',
    borderRadius: 9,
    backgroundColor: '#48484a',
    elevation: 3,
  },
  advanceThumbReady: {
    backgroundColor: '#79602f',
    borderTopColor: '#c9a45c',
  },
  advanceTrackLabel: {
    position: 'absolute',
    alignSelf: 'center',
    color: '#8e8e93',
    fontSize: 6,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  shutterDeck: {
    height: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    borderTopWidth: 1,
    borderTopColor: '#38383a',
    backgroundColor: '#1c1c1e',
  },
  meterLabel: {
    color: '#8e8e93',
    fontSize: 7,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
  shutterOuter: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2c2c2e',
  },
  shutterInner: {
    width: 42, // SHRUNK from 50
    height: 42,
    borderRadius: 21,
    borderWidth: 3,
    borderTopColor: '#8d1d1d',
    borderLeftColor: '#b82828',
    borderRightColor: '#631616',
    borderBottomColor: '#551212',
    backgroundColor: '#d32f2f',
  },
  shutterDisabled: {
    opacity: 0.5,
  },
  error: {
    color: '#f2f2f7',
    backgroundColor: '#9f2020',
    padding: 8,
    marginBottom: 6,
    textAlign: 'center',
    fontSize: 10,
  },
});