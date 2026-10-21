import React, { useEffect, useRef, useState } from 'react';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import {
  Image,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
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
  type SkImage,
  type SkSurface,
} from '@shopify/react-native-skia';
import { createSynchronizable, scheduleOnRN } from 'react-native-worklets';
import { saveEncodedPhotoToLibrary } from './src/utils/saveEncodedPhotoToLibrary';
import { getLatestPhotoUri } from './src/utils/getLatestPhotoUri';
import Archive from './src/screens/Archive';
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
const PUSH_PULL_STOPS = [
  { value: -1, label: '-1' },
  { value: 0, label: 'BOX' },
  { value: 1, label: '+1' },
  { value: 2, label: '+2' },
] as const;
const aspectRatios = ['3:4', '6:7', '1:1', '16:9'] as const;
type AspectRatio = (typeof aspectRatios)[number];

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
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
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
  const shutterAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: shutterScale.value }],
  }));
  const [commandDialMode, setCommandDialMode] = useState<
    'EV' | 'FOCUS' | 'DEV' | 'OPTICS'
  >('EV');
  const [activeGlassOverlay, setActiveGlassOverlay] = useState<
    'film' | 'aspect' | 'mx' | null
  >(null);
  const [opticsIndex, setOpticsIndex] = useState(0);
  const commandDialOpacity = useSharedValue(0.18);
  const commandDialAnimatedStyle = useAnimatedStyle(() => ({
    opacity: commandDialOpacity.value,
  }));
  const windPromptOpacity = useSharedValue(0);
  const windPromptAnimatedStyle = useAnimatedStyle(() => ({
    opacity: windPromptOpacity.value,
  }));
  const commandDialTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const glassOverlayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commandDialStartValue = useRef(0);
  const commandDialLastHaptic = useRef(0);
  const windGestureConsumed = useRef(false);
  const viewfinderSize = useRef({ width: 0, height: 0 });
  const zoomDeviceRef = useRef(device);
  const [exposure, setExposure] = useState<number>(0);
  const lastHapticEV = useRef<number>(0);
  const { hasPermission, canRequestPermission, requestPermission } =
    useCameraPermission();
  const captureRequested = React.useMemo(
    () => createSynchronizable(false, { fixedType: true }),
    [],
  );
  const firstExposureImage = React.useMemo(
    () => createSynchronizable<SkImage | null>(null),
    [],
  );
  const firstExposureRequested = React.useMemo(
    () => createSynchronizable(false, { fixedType: true }),
    [],
  );
  const finalExposureRequested = React.useMemo(
    () => createSynchronizable(false, { fixedType: true }),
    [],
  );
  const clearFirstExposureRequested = React.useMemo(
    () => createSynchronizable(false, { fixedType: true }),
    [],
  );
  const firstExposureAvailable = React.useMemo(
    () => createSynchronizable(false, { fixedType: true }),
    [],
  );
  const liveMxMix = React.useMemo(
    () => createSynchronizable(0),
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
  const focusLastHapticValue = useRef(0.5);
  const [meterPoint, setMeterPoint] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [activeZoneLabel, setActiveZoneLabel] = useState('--');
  const activeZone = useSharedValue<string>('--');
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('3:4');
  const [mxMode, setMxMode] = useState(false);
  const [isAwaitingSecondExposure, setIsAwaitingSecondExposure] =
    useState(false);
  const [grainEnabled, setGrainEnabled] = useState(true);
  const [halationEnabled, setHalationEnabled] = useState(true);
  const [vignetteEnabled, setVignetteEnabled] = useState(true);
  const [latestPhotoUri, setLatestPhotoUri] = useState<string | null>(null);
  const [archiveVisible, setArchiveVisible] = useState(false);
  const [photosTaken, setPhotosTaken] = useState(0);
  const statusTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const minExposure = device ? Math.max(-2, device.minExposureBias) : -2;
  const maxExposure = device ? Math.min(2, device.maxExposureBias) : 2;
  const boundedExposure = Math.min(
    maxExposure,
    Math.max(minExposure, exposure),
  );
  const commandDialModeRef = useRef(commandDialMode);
  commandDialModeRef.current = commandDialMode;
  const boundedExposureRef = useRef(boundedExposure);
  boundedExposureRef.current = boundedExposure;
  const pushPullRef = useRef(pushPull);
  pushPullRef.current = pushPull;
  const opticsIndexRef = useRef(opticsIndex);
  opticsIndexRef.current = opticsIndex;
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
        const savedPhotoUri = await saveEncodedPhotoToLibrary(base64Data, {
          stock:
            FILM_STOCKS.find((profile) => profile.id === filmProfile)?.name ??
            String(filmProfile),
          focalLength: lens,
          ev: boundedExposure,
          developedTimestamp: new Date().toISOString(),
        });
        setLatestPhotoUri(savedPhotoUri);
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
    setIsAwaitingSecondExposure(false);
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
          const clearPending = clearFirstExposureRequested.getBlocking();
          let previousFrame = firstExposureImage.getBlocking();
          if (clearPending) {
            clearFirstExposureRequested.setBlocking(false);
            firstExposureImage.setBlocking(null);
            firstExposureAvailable.setBlocking(false);
            previousFrame?.dispose();
            previousFrame = null;
          }
          const firstCapture = firstExposureRequested.getBlocking();
          const finalCapture = finalExposureRequested.getBlocking();
          const singleCapture = captureRequested.getBlocking();
          const mxMix = previousFrame ? liveMxMix.getBlocking() : 0;
          const screenImageShader = frameTexture.makeShaderOptions(
            TileMode.Clamp,
            TileMode.Clamp,
            FilterMode.Linear,
            MipmapMode.None,
          );
          const previousImageShader = previousFrame
            ? previousFrame.makeShaderOptions(
                TileMode.Clamp,
                TileMode.Clamp,
                FilterMode.Linear,
                MipmapMode.None,
              )
            : frameTexture.makeShaderOptions(
                TileMode.Clamp,
                TileMode.Clamp,
                FilterMode.Linear,
                MipmapMode.None,
              );
          let screenShader: SkShader | undefined;
          let screenPaint: SkPaint | undefined;
          let firstFrameSurface: SkSurface | null = null;

          try {
            const screenUniforms = [
              previousFrame?.width() ?? width,
              previousFrame?.height() ?? height,
              mxMix,
              width,
              height,
              filmProfile,
              grainEnabled ? 0.35 : 0,
              halationEnabled ? 0.65 : 0,
              dynamicSeed,
              boundedExposure,
              vignetteEnabled ? 0.9 : 0,
              manualFocusActive ? 1.0 : 0.0,
              focusDistance,
              meterPoint ? meterPoint.x * width : 0,
              meterPoint ? meterPoint.y * height : 0,
              pushPull,
            ];
            screenShader = filmEffect.makeShaderWithChildren(
              screenUniforms,
              [screenImageShader, previousImageShader],
            );
            screenPaint = Skia.Paint();
            screenPaint.setShader(screenShader);
            canvas.drawRect(
              Skia.XYWHRect(0, 0, width, height),
              screenPaint,
            );

            if (firstCapture) {
              firstExposureRequested.setBlocking(false);
              firstFrameSurface = Skia.Surface.MakeOffscreen(
                width,
                height,
              );
              if (!firstFrameSurface) {
                throw new Error('Unable to hold the first MX exposure.');
              }
              firstFrameSurface
                .getCanvas()
                .drawRect(Skia.XYWHRect(0, 0, width, height), screenPaint);
              firstFrameSurface.flush();
              const firstSnapshot = firstFrameSurface.makeImageSnapshot();
              const oldFrame = firstExposureImage.getBlocking();
              firstExposureImage.setBlocking(firstSnapshot);
              firstExposureAvailable.setBlocking(true);
              liveMxMix.setBlocking(0.35);
              if (oldFrame && oldFrame !== firstSnapshot) oldFrame.dispose();
            }

            if (singleCapture || finalCapture) {
              captureRequested.setBlocking(false);
              finalExposureRequested.setBlocking(false);

              let surface: SkSurface | null = null;
              let snapshot: SkImage | undefined;
              let highResImageShader: SkShader | undefined;
              let highResPreviousImageShader: SkShader | undefined;
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
                const highResUniforms = [
                  previousFrame?.width() ?? width,
                  previousFrame?.height() ?? height,
                  finalCapture && previousFrame ? 1 : mxMix,
                  width,
                  height,
                  filmProfile,
                  grainEnabled ? 0.35 : 0,
                  halationEnabled ? 0.65 : 0,
                  dynamicSeed,
                  boundedExposure,
                  vignetteEnabled ? 0.9 : 0,
                  manualFocusActive ? 1.0 : 0.0,
                  focusDistance,
                  meterPoint ? meterPoint.x * width : 0,
                  meterPoint ? meterPoint.y * height : 0,
                  pushPull,
                ];

                highResImageShader = frameTexture.makeShaderOptions(
                  TileMode.Clamp,
                  TileMode.Clamp,
                  FilterMode.Linear,
                  MipmapMode.None,
                );
                highResPreviousImageShader = previousFrame
                  ? previousFrame.makeShaderOptions(
                      TileMode.Clamp,
                      TileMode.Clamp,
                      FilterMode.Linear,
                      MipmapMode.None,
                    )
                  : frameTexture.makeShaderOptions(
                      TileMode.Clamp,
                      TileMode.Clamp,
                      FilterMode.Linear,
                      MipmapMode.None,
                    );
                highResShader = filmEffect.makeShaderWithChildren(
                  highResUniforms,
                  [highResImageShader, highResPreviousImageShader],
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
                firstExposureRequested.setBlocking(false);
                captureRequested.setBlocking(false);
                finalExposureRequested.setBlocking(false);
                clearFirstExposureRequested.setBlocking(true);
                firstExposureAvailable.setBlocking(false);
                liveMxMix.setBlocking(0);
                const heldFrame = firstExposureImage.getBlocking();
                firstExposureImage.setBlocking(null);
                heldFrame?.dispose();
                scheduleOnRN(failCapture, `Capture failed: ${error}`);
              } finally {
                snapshot?.dispose();
                surface?.dispose();
                offscreenPaint?.dispose();
                highResShader?.dispose();
                highResImageShader?.dispose();
                highResPreviousImageShader?.dispose();
              }
            }
          } catch (error: unknown) {
            firstExposureRequested.setBlocking(false);
            captureRequested.setBlocking(false);
            finalExposureRequested.setBlocking(false);
            clearFirstExposureRequested.setBlocking(true);
            firstExposureAvailable.setBlocking(false);
            liveMxMix.setBlocking(0);
            const heldFrame = firstExposureImage.getBlocking();
            firstExposureImage.setBlocking(null);
            heldFrame?.dispose();
            scheduleOnRN(failCapture, `Capture failed: ${error}`);
          } finally {
            screenPaint?.dispose();
            screenShader?.dispose();
            screenImageShader.dispose();
            previousImageShader.dispose();
            firstFrameSurface?.dispose();
          }
        });
      } catch (error: unknown) {
        firstExposureRequested.setBlocking(false);
        captureRequested.setBlocking(false);
        finalExposureRequested.setBlocking(false);
        clearFirstExposureRequested.setBlocking(true);
        firstExposureAvailable.setBlocking(false);
        liveMxMix.setBlocking(0);
        const heldFrame = firstExposureImage.getBlocking();
        firstExposureImage.setBlocking(null);
        heldFrame?.dispose();
        scheduleOnRN(failCapture, `Capture failed: ${error}`);
      } finally {
        frame.dispose();
      }
    },
    [
      captureRequested,
      firstExposureImage,
      firstExposureRequested,
      finalExposureRequested,
      clearFirstExposureRequested,
      firstExposureAvailable,
      liveMxMix,
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
      const heldFrame = firstExposureImage.getBlocking();
      firstExposureImage.setBlocking(null);
      heldFrame?.dispose();
    },
    [firstExposureImage],
  );

  useEffect(
    () => () => {
      if (statusTimeout.current) clearTimeout(statusTimeout.current);
      if (commandDialTimer.current) clearTimeout(commandDialTimer.current);
      if (glassOverlayTimer.current) clearTimeout(glassOverlayTimer.current);
    },
    [],
  );

  useEffect(() => {
    windPromptOpacity.value = isWound
      ? withTiming(0, { duration: 180 })
      : withRepeat(withTiming(0.9, { duration: 900 }), -1, true);
  }, [isWound, windPromptOpacity]);

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

  useEffect(() => {
    if (!hasPermission) return undefined;

    let isMounted = true;
    void getLatestPhotoUri()
      .then((uri) => {
        if (isMounted && uri) setLatestPhotoUri(uri);
      })
      .catch((error: unknown) => {
        if (isMounted) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : 'Unable to load the latest camera-roll photo.',
          );
        }
      });

    return () => {
      isMounted = false;
    };
  }, [hasPermission]);

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
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid)
      .then(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light))
      .catch((error: unknown) => {
        console.warn('Unable to play film-advance ratchet feedback.', error);
      });
  }, []);

  const windPanResponder = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_, gestureState) => {
          const startX = gestureState.x0;
          const startY = gestureState.y0;
          const isBelowMidpoint = startY >= screenHeight * 0.5;
          const isCommandControl =
            startX >= screenWidth - 220 &&
            startY >= screenHeight - 480 &&
            startY <= screenHeight - 200;
          const isBottomControl = startY >= screenHeight - 205;
          return (
            !isWoundRef.current &&
            isBelowMidpoint &&
            !isCommandControl &&
            !isBottomControl &&
            gestureState.dx > 15 &&
            Math.abs(gestureState.dx) > Math.abs(gestureState.dy)
          );
        },
        onPanResponderGrant: () => {
          windGestureConsumed.current = true;
        },
        onPanResponderRelease: (_, gestureState) => {
          if (gestureState.dx > 70) advanceFilm();
          windGestureConsumed.current = false;
        },
        onPanResponderTerminate: () => {
          windGestureConsumed.current = false;
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [advanceFilm, screenHeight, screenWidth],
  );

  const handleShutter = () => {
    if (!device || !hasPermission || isCapturing || !isWoundRef.current) return;

    if (mxMode) {
      if (!isAwaitingSecondExposure) {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(
          (error: unknown) => {
            console.warn('Unable to play MX shutter haptic feedback.', error);
          },
        );
        clearFirstExposureRequested.setBlocking(true);
        firstExposureAvailable.setBlocking(false);
        liveMxMix.setBlocking(0);
        firstExposureRequested.setBlocking(true);
        setIsAwaitingSecondExposure(true);
        setErrorMessage(null);
        setStatusMessage('FIRST EXPOSURE HELD · REFRAME AND PRESS AGAIN');
        return;
      }

      if (!firstExposureAvailable.getBlocking()) {
        setStatusMessage('HOLD THE FIRST EXPOSURE · READYING MEMORY');
        return;
      }

      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(
        (error: unknown) => {
          console.warn('Unable to play final MX shutter haptic feedback.', error);
        },
      );
      if (statusTimeout.current) clearTimeout(statusTimeout.current);
      setIsCapturing(true);
      setIsAwaitingSecondExposure(false);
      setErrorMessage(null);
      setStatusMessage('BLENDING DOUBLE EXPOSURE…');
      liveMxMix.setBlocking(1);
      finalExposureRequested.setBlocking(true);
      return;
    }

    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(
      (error: unknown) => {
        console.warn('Unable to play shutter haptic feedback.', error);
      },
    );
    liveMxMix.setBlocking(0);
    void takePhoto();
  };

  const selectAspectRatio = (ratio: AspectRatio) => {
    void Haptics.selectionAsync().catch((error: unknown) => {
      console.warn('Unable to play aspect-ratio selection haptic feedback.', error);
    });
    setAspectRatio(ratio);
  };

  const handleCancelMx = () => {
    void Haptics.notificationAsync(
      Haptics.NotificationFeedbackType.Warning,
    ).catch((error: unknown) => {
      console.warn('Unable to play MX cancellation haptic feedback.', error);
    });
    clearFirstExposureRequested.setBlocking(true);
    firstExposureRequested.setBlocking(false);
    finalExposureRequested.setBlocking(false);
    captureRequested.setBlocking(false);
    firstExposureAvailable.setBlocking(false);
    liveMxMix.setBlocking(0);
    setIsAwaitingSecondExposure(false);
    setMxMode(false);
    setStatusMessage(null);
  };

  const toggleMxMode = () => {
    if (mxMode || isAwaitingSecondExposure) {
      handleCancelMx();
      return;
    }
    void Haptics.selectionAsync().catch((error: unknown) => {
      console.warn('Unable to play MX mode haptic feedback.', error);
    });
    setMxMode(true);
  };

  const selectExposure = React.useCallback((value: number) => {
    if (!device) return;
    const newEV = Math.round(
      Math.min(maxExposure, Math.max(minExposure, value)) * 10,
    ) / 10;
    if (Math.abs(newEV - lastHapticEV.current) >= 0.1) {
      void Haptics.selectionAsync().catch((error: unknown) => {
        console.warn('Unable to play exposure detent haptic feedback.', error);
      });
    }
    lastHapticEV.current = newEV;
    setExposure(newEV);
  }, [device, maxExposure, minExposure]);
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
  const revealCommandDial = React.useCallback(() => {
    if (commandDialTimer.current) clearTimeout(commandDialTimer.current);
    commandDialOpacity.value = withTiming(1, { duration: 120 });
    commandDialTimer.current = setTimeout(() => {
      commandDialOpacity.value = withTiming(0.18, { duration: 500 });
    }, 1800);
  }, [commandDialOpacity]);
  const openGlassOverlay = (overlay: 'film' | 'aspect' | 'mx') => {
    if (glassOverlayTimer.current) clearTimeout(glassOverlayTimer.current);
    setActiveGlassOverlay(overlay);
    glassOverlayTimer.current = setTimeout(() => {
      setActiveGlassOverlay(null);
    }, 1800);
  };
  const closeGlassOverlay = () => {
    if (glassOverlayTimer.current) clearTimeout(glassOverlayTimer.current);
    setActiveGlassOverlay(null);
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
  const selectPushPull = React.useCallback((value: number) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid).catch(
      (error: unknown) => {
        console.warn('Unable to play development dial haptic feedback.', error);
      },
    );
    setPushPull(value);
  }, []);
  const toggleEffect = (
    setEnabled: (update: (enabled: boolean) => boolean) => void,
  ) => {
    void Haptics.selectionAsync().catch((error: unknown) => {
      console.warn('Unable to play effect toggle haptic feedback.', error);
    });
    setEnabled((enabled) => !enabled);
  };
  const opticLabels = ['HALATION', 'GRAIN', 'VIGNETTE'] as const;
  const toggleSelectedOptic = () => {
    if (opticsIndex === 0) toggleEffect(setHalationEnabled);
    else if (opticsIndex === 1) toggleEffect(setGrainEnabled);
    else toggleEffect(setVignetteEnabled);
    revealCommandDial();
  };
  const getCommandDialValue = () => {
    switch (commandDialMode) {
      case 'EV':
        return `EV ${boundedExposure >= 0 ? '+' : ''}${boundedExposure.toFixed(1)}`;
      case 'FOCUS':
        return `${manualFocusActive ? 'MF' : 'AF'} ${focusDistance.toFixed(2)}`;
      case 'DEV':
        return pushPull === 0 ? 'BOX' : `${pushPull > 0 ? '+' : ''}${pushPull}`;
      default: {
        const enabled =
          opticsIndex === 0
            ? halationEnabled
            : opticsIndex === 1
              ? grainEnabled
              : vignetteEnabled;
        return `${opticLabels[opticsIndex]} ${enabled ? 'ON' : 'OFF'}`;
      }
    }
  };
  const commandDialPosition =
    commandDialMode === 'EV'
      ? ((boundedExposure + 2) / 4) * 100
      : commandDialMode === 'FOCUS'
        ? focusDistance * 100
        : commandDialMode === 'DEV'
          ? ((PUSH_PULL_STOPS.findIndex((stop) => stop.value === pushPull) || 0) /
              (PUSH_PULL_STOPS.length - 1)) *
            100
          : (opticsIndex / (opticLabels.length - 1)) * 100;
  const commandDialPanResponder = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_, gestureState) =>
          Math.abs(gestureState.dy) > 4 &&
          Math.abs(gestureState.dy) > Math.abs(gestureState.dx),
        onPanResponderGrant: () => {
          commandDialLastHaptic.current = 0;
          const mode = commandDialModeRef.current;
          if (mode === 'EV') {
            commandDialStartValue.current = boundedExposureRef.current;
          } else if (mode === 'FOCUS') {
            commandDialStartValue.current = focusDistanceRef.current;
            setManualFocusActive(true);
          } else if (mode === 'DEV') {
            commandDialStartValue.current = PUSH_PULL_STOPS.findIndex(
              (stop) => stop.value === pushPullRef.current,
            );
          } else {
            commandDialStartValue.current = opticsIndexRef.current;
          }
          revealCommandDial();
        },
        onPanResponderMove: (_, gestureState) => {
          const delta = -gestureState.dy;
          const mode = commandDialModeRef.current;
          if (mode === 'EV') {
            const next = Math.round(
              (commandDialStartValue.current + delta * 0.01) * 10,
            ) / 10;
            selectExposure(next);
          } else if (mode === 'FOCUS') {
            updateFocusDistance(commandDialStartValue.current + delta * 0.005);
          } else if (mode === 'DEV') {
            const nextIndex = Math.max(
              0,
              Math.min(
                PUSH_PULL_STOPS.length - 1,
                Math.round(commandDialStartValue.current + delta / 42),
              ),
            );
            const nextValue = PUSH_PULL_STOPS[nextIndex].value;
            if (nextIndex !== commandDialLastHaptic.current) {
              commandDialLastHaptic.current = nextIndex;
              selectPushPull(nextValue);
            }
          } else {
            const nextIndex = Math.max(
              0,
              Math.min(
                opticLabels.length - 1,
                Math.round(commandDialStartValue.current + delta / 48),
              ),
            );
            if (nextIndex !== opticsIndexRef.current) {
              opticsIndexRef.current = nextIndex;
              setOpticsIndex(nextIndex);
              void Haptics.selectionAsync().catch((error: unknown) => {
                console.warn('Unable to play optics detent haptic feedback.', error);
              });
            }
          }
          revealCommandDial();
        },
        onPanResponderRelease: revealCommandDial,
        onPanResponderTerminate: revealCommandDial,
      }),
    [revealCommandDial, selectExposure, selectPushPull, updateFocusDistance],
  );
  const selectCommandDialMode = (
    mode: 'EV' | 'FOCUS' | 'DEV' | 'OPTICS',
  ) => {
    if (mode === 'FOCUS' && commandDialMode === 'FOCUS') {
      setManualFocusActive((active) => !active);
    } else if (mode === 'FOCUS') {
      setManualFocusActive(true);
    }
    setCommandDialMode(mode);
    void Haptics.selectionAsync().catch((error: unknown) => {
      console.warn('Unable to play command dial mode haptic feedback.', error);
    });
    revealCommandDial();
  };
  const targetRatioNum = getAspectRatioValue(aspectRatio);
  const screenRatio = screenWidth / Math.max(1, screenHeight);
  const cropWidth =
    screenRatio > targetRatioNum ? screenHeight * targetRatioNum : screenWidth;
  const cropHeight =
    screenRatio > targetRatioNum ? screenHeight : screenWidth / targetRatioNum;
  const matteLeft = Math.max(0, (screenWidth - cropWidth) / 2);
  const matteTop = Math.max(0, (screenHeight - cropHeight) / 2);

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
      style={styles.glassRoot}
      onLayout={(event) => {
        viewfinderSize.current = {
          width: event.nativeEvent.layout.width,
          height: event.nativeEvent.layout.height,
        };
      }}
      {...windPanResponder.panHandlers}
    >
      <StatusBar style="light" />
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
        style={StyleSheet.absoluteFill}
        onPress={(event) => {
          if (windGestureConsumed.current) return;
          const { width, height } = viewfinderSize.current;
          if (width <= 0 || height <= 0) return;
          setMeterPoint({
            x: Math.min(
              0.999,
              Math.max(0.001, event.nativeEvent.locationX / width),
            ),
            y: Math.min(
              0.999,
              Math.max(0.001, event.nativeEvent.locationY / height),
            ),
          });
          setActiveZoneLabel('METERING...');
          activeZone.value = 'METERING...';
          meterSampleRequested.setBlocking(true);
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(
            (error: unknown) => {
              console.warn('Unable to play spot-meter haptic feedback.', error);
            },
          );
        }}
      />
      {matteTop > 0 ? (
        <View
          pointerEvents="none"
          style={[
            styles.glassMatte,
            { top: 0, left: 0, right: 0, height: matteTop },
          ]}
        />
      ) : null}
      {matteTop > 0 ? (
        <View
          pointerEvents="none"
          style={[
            styles.glassMatte,
            { bottom: 0, left: 0, right: 0, height: matteTop },
          ]}
        />
      ) : null}
      {matteLeft > 0 ? (
        <View
          pointerEvents="none"
          style={[
            styles.glassMatte,
            { top: matteTop, bottom: matteTop, left: 0, width: matteLeft },
          ]}
        />
      ) : null}
      {matteLeft > 0 ? (
        <View
          pointerEvents="none"
          style={[
            styles.glassMatte,
            { top: matteTop, bottom: matteTop, right: 0, width: matteLeft },
          ]}
        />
      ) : null}
      <View
        pointerEvents="none"
        style={[
          styles.glassFrameline,
          { left: matteLeft, top: matteTop, width: cropWidth, height: cropHeight },
        ]}
      />
      {meterPoint ? (
        <View
          pointerEvents="none"
          style={[
            styles.meterReticle,
            {
              left: meterPoint.x * screenWidth - 17,
              top: meterPoint.y * screenHeight - 17,
            },
          ]}
        >
          <View style={styles.meterReticleCircle} />
          <View style={styles.meterReticleHorizontal} />
          <View style={styles.meterReticleVertical} />
        </View>
      ) : null}

      <View pointerEvents="box-none" style={styles.ghostHud}>
        <View style={styles.ghostHudTopRow}>
          <Text style={styles.ghostText}>
            FRAME {String(photosTaken + 1).padStart(2, '0')}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Reset exposure to zero"
            onPress={() => selectExposure(0)}
          >
            <Text numberOfLines={1} style={styles.ghostText}>
              {activeZoneLabel === '--'
                ? 'ZONE V'
                : activeZoneLabel.split(' (')[0]}{' '}
              | EV {boundedExposure >= 0 ? '+' : ''}
              {boundedExposure.toFixed(1)}
            </Text>
          </Pressable>
        </View>
        <View style={styles.ghostPills}>
          <Pressable
            style={styles.ghostPill}
            onPress={() => openGlassOverlay('film')}
          >
            <Text numberOfLines={1} style={styles.ghostPillText}>
              {`[ ${activeFilm?.name ?? 'FILM'} \u25BE ]`}
            </Text>
          </Pressable>
          <Pressable
            style={styles.ghostPill}
            onPress={() => openGlassOverlay('aspect')}
          >
            <Text style={styles.ghostPillText}>[ {aspectRatio} ]</Text>
          </Pressable>
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: mxMode }}
            style={[
              styles.ghostPill,
              mxMode && styles.ghostPillActive,
            ]}
            onPress={() => openGlassOverlay('mx')}
          >
            <Text style={styles.ghostPillText}>
              [ MX{isAwaitingSecondExposure ? ' - 2ND' : ''} ]
            </Text>
          </Pressable>
        </View>
      </View>

      {activeGlassOverlay ? (
        <View pointerEvents="box-none" style={styles.glassPopupLayer}>
          <View style={styles.glassPopup}>
            <View style={styles.glassPopupHeader}>
              <Text style={styles.glassPopupTitle}>
                {activeGlassOverlay === 'film'
                  ? 'FILM STOCK'
                  : activeGlassOverlay === 'aspect'
                    ? 'FRAME LINES'
                    : 'MX DOUBLE EXPOSURE'}
              </Text>
              <Pressable
                accessibilityLabel="Close selection"
                onPress={closeGlassOverlay}
              >
                <Text style={styles.ghostText}>CLOSE X</Text>
              </Pressable>
            </View>
            {activeGlassOverlay === 'film' ? (
              <View style={styles.glassChoiceGrid}>
                {FILM_STOCKS.map((stock) => (
                  <Pressable
                    key={stock.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: filmProfile === stock.id }}
                    style={[
                      styles.glassChoice,
                      filmProfile === stock.id && styles.glassChoiceActive,
                    ]}
                    onPress={() => {
                      selectFilmProfile(stock.id);
                      closeGlassOverlay();
                    }}
                  >
                    <Text style={styles.glassChoiceText}>{stock.name}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {activeGlassOverlay === 'aspect' ? (
              <View style={styles.glassChoiceGrid}>
                {aspectRatios.map((ratio) => (
                  <Pressable
                    key={ratio}
                    accessibilityRole="button"
                    accessibilityState={{ selected: aspectRatio === ratio }}
                    style={[
                      styles.glassChoice,
                      aspectRatio === ratio && styles.glassChoiceActive,
                    ]}
                    onPress={() => {
                      selectAspectRatio(ratio);
                      closeGlassOverlay();
                    }}
                  >
                    <Text style={styles.glassChoiceText}>{ratio}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {activeGlassOverlay === 'mx' ? (
              <View style={styles.mxPopupActions}>
                <Text style={styles.glassPopupHint}>
                  {isAwaitingSecondExposure
                    ? 'FIRST FRAME HELD - PRESS AGAIN FOR THE FINAL EXPOSURE'
                    : 'LAYER TWO EXPOSURES ON ONE NEGATIVE'}
                </Text>
                <Pressable
                  accessibilityRole="switch"
                  accessibilityState={{ checked: mxMode }}
                  disabled={isCapturing}
                  style={[
                    styles.glassChoice,
                    mxMode && styles.glassChoiceActive,
                  ]}
                  onPress={() => {
                    toggleMxMode();
                    closeGlassOverlay();
                  }}
                >
                  <Text style={styles.glassChoiceText}>
                    {isAwaitingSecondExposure
                      ? 'CANCEL MX'
                      : mxMode
                        ? 'DISABLE MX'
                        : 'ENABLE MX'}
                  </Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        </View>
      ) : null}

      <Animated.View pointerEvents="box-none" style={[styles.commandDial, commandDialAnimatedStyle]}>
        <View style={styles.commandDialReadout}>
          <Text numberOfLines={1} style={styles.commandDialValue}>
            {getCommandDialValue()}
          </Text>
        </View>
        <Pressable
          accessibilityRole="adjustable"
          accessibilityLabel={`${commandDialMode} command dial`}
          accessibilityValue={{ text: getCommandDialValue() }}
          onPress={() =>
            commandDialMode === 'OPTICS'
              ? toggleSelectedOptic()
              : revealCommandDial()
          }
          style={styles.commandDialTrack}
          {...commandDialPanResponder.panHandlers}
        >
          <View pointerEvents="none" style={styles.commandDialRail} />
          {Array.from({ length: 13 }, (_, index) => (
            <View
              key={index}
              pointerEvents="none"
              style={[
                styles.commandDialTick,
                index % 3 === 0 && styles.commandDialMajorTick,
                { top: `${(index / 12) * 100}%` },
              ]}
            />
          ))}
          <View
            pointerEvents="none"
            style={[
              styles.commandDialMarker,
              { top: `${Math.max(0, Math.min(100, commandDialPosition))}%` },
            ]}
          />
        </Pressable>
      </Animated.View>
      <View style={styles.commandModeRow}>
        {(['EV', 'FOCUS', 'DEV', 'OPTICS'] as const).map((mode) => (
          <Pressable
            key={mode}
            accessibilityRole="button"
            accessibilityState={{ selected: commandDialMode === mode }}
            style={[
              styles.commandModePill,
              commandDialMode === mode && styles.commandModePillActive,
            ]}
            onPress={() => selectCommandDialMode(mode)}
          >
            <Text style={styles.commandModeText}>[ {mode} ]</Text>
          </Pressable>
        ))}
      </View>
      {commandDialMode === 'OPTICS' ? (
        <Pressable
          style={styles.opticsQuickToggle}
          onPress={toggleSelectedOptic}
        >
          <Text style={styles.opticsQuickToggleText}>
            TAP DIAL TO TOGGLE {opticLabels[opticsIndex]}
          </Text>
        </Pressable>
      ) : null}
      {errorMessage || statusMessage ? (
        <View pointerEvents="none" style={styles.glassNotice}>
          <Text style={errorMessage ? styles.glassErrorText : styles.ghostText}>
            {errorMessage ?? statusMessage}
          </Text>
        </View>
      ) : null}
      {!isWound ? (
        <Animated.Text
          pointerEvents="none"
          style={[styles.windPrompt, windPromptAnimatedStyle]}
        >
          [ SWIPE RIGHT TO WIND ]
        </Animated.Text>
      ) : null}

      <TouchableOpacity
        accessibilityLabel="Open photo archive"
        accessibilityRole="button"
        onPress={() => setArchiveVisible(true)}
        style={styles.floatingArchiveThumb}
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
      <View style={styles.floatingLensTurret}>
        {(['0.5x', '1x', '2x', '5x'] as const).map((lensOption) => (
          <Pressable
            key={lensOption}
            accessibilityRole="button"
            accessibilityLabel={`Select ${lensOption} lens`}
            accessibilityState={{ selected: lens === lensOption }}
            onPress={() => selectLens(lensOption)}
            style={[
              styles.floatingLensDetent,
              lens === lensOption && styles.floatingLensDetentActive,
            ]}
          >
            <Text
              style={[
                styles.floatingLensText,
                lens === lensOption && styles.floatingLensTextActive,
              ]}
            >
              {lensOption}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.floatingShutterAssembly}>
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
            shutterScale.value = withSpring(0.86, {
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
            styles.titaniumShutter,
            (!isWound || isCapturing) && styles.titaniumShutterLocked,
          ]}
        >
          <Animated.View
            style={[styles.titaniumShutterCore, shutterAnimatedStyle]}
          />
        </Pressable>
      </View>
      <Modal
        visible={archiveVisible}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setArchiveVisible(false)}
      >
        <Archive
          onClose={() => setArchiveVisible(false)}
        />
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  glassRoot: {
    ...StyleSheet.absoluteFill,
    overflow: 'hidden',
    backgroundColor: '#08080a',
  },
  glassMatte: {
    position: 'absolute',
    zIndex: 2,
    backgroundColor: 'rgba(8, 8, 10, 0.58)',
  },
  glassFrameline: {
    position: 'absolute',
    zIndex: 3,
    borderWidth: 1,
    borderColor: 'rgba(255, 180, 70, 0.35)',
  },
  meterReticle: {
    position: 'absolute',
    zIndex: 4,
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  meterReticleCircle: {
    width: 18,
    height: 18,
    borderWidth: 1,
    borderColor: '#ffb000',
    borderRadius: 9,
  },
  meterReticleHorizontal: {
    position: 'absolute',
    width: 34,
    height: 1,
    backgroundColor: '#ffb000',
  },
  meterReticleVertical: {
    position: 'absolute',
    width: 1,
    height: 34,
    backgroundColor: '#ffb000',
  },
  ghostHud: {
    position: 'absolute',
    zIndex: 5,
    top: 68,
    left: 18,
    right: 18,
    gap: 11,
  },
  ghostHudTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
  },
  ghostText: {
    color: '#ffb000',
    fontFamily: 'Menlo',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textShadowColor: 'rgba(0,0,0,0.85)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
  ghostPills: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  ghostPill: {
    maxWidth: '58%',
    minHeight: 30,
    justifyContent: 'center',
    paddingHorizontal: 9,
    borderWidth: 1,
    borderColor: 'rgba(255, 176, 0, 0.38)',
    borderRadius: 16,
    backgroundColor: 'rgba(8, 8, 10, 0.28)',
  },
  ghostPillActive: {
    borderColor: '#ffb000',
    backgroundColor: 'rgba(255, 176, 0, 0.18)',
  },
  ghostPillText: {
    color: '#ff9f1c',
    fontFamily: 'Menlo',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.5,
    textShadowColor: 'rgba(0,0,0,0.85)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
  glassPopupLayer: {
    ...StyleSheet.absoluteFill,
    zIndex: 10,
    alignItems: 'center',
    paddingTop: 150,
  },
  glassPopup: {
    width: '88%',
    maxWidth: 380,
    padding: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 176, 0, 0.38)',
    borderRadius: 16,
    backgroundColor: 'rgba(8, 8, 10, 0.78)',
  },
  glassPopupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 13,
  },
  glassPopupTitle: {
    color: '#ffb000',
    fontFamily: 'Menlo',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.5,
    textShadowColor: 'rgba(0,0,0,0.85)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
  glassChoiceGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  glassChoice: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: 11,
    borderWidth: 1,
    borderColor: 'rgba(255, 176, 0, 0.3)',
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  glassChoiceActive: {
    borderColor: '#ffb000',
    backgroundColor: 'rgba(255, 176, 0, 0.2)',
  },
  glassChoiceText: {
    color: '#ffe3ab',
    fontFamily: 'Menlo',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  mxPopupActions: {
    alignItems: 'flex-start',
    gap: 14,
  },
  glassPopupHint: {
    color: '#e7d2ae',
    fontFamily: 'Menlo',
    fontSize: 10,
    lineHeight: 16,
  },
  commandDial: {
    position: 'absolute',
    zIndex: 6,
    right: 12,
    bottom: 282,
    width: 94,
    height: 166,
    alignItems: 'center',
    gap: 8,
  },
  commandDialReadout: {
    maxWidth: 94,
    paddingHorizontal: 5,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: 'rgba(8,8,10,0.38)',
  },
  commandDialValue: {
    color: '#ffb000',
    fontFamily: 'Menlo',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.4,
    textShadowColor: 'rgba(0,0,0,0.85)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
  commandDialTrack: {
    width: 54,
    flex: 1,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 176, 0, 0.34)',
    borderRadius: 20,
    backgroundColor: 'rgba(8,8,10,0.34)',
  },
  commandDialRail: {
    position: 'absolute',
    top: 8,
    bottom: 8,
    left: 26,
    width: 1,
    backgroundColor: 'rgba(255, 176, 0, 0.45)',
  },
  commandDialTick: {
    position: 'absolute',
    right: 9,
    width: 9,
    height: 1,
    backgroundColor: 'rgba(255, 224, 173, 0.62)',
  },
  commandDialMajorTick: {
    right: 5,
    width: 13,
    height: 2,
    backgroundColor: '#ffb000',
  },
  commandDialMarker: {
    position: 'absolute',
    left: 16,
    width: 23,
    height: 3,
    borderRadius: 2,
    backgroundColor: '#fff0cc',
    shadowColor: '#ffb000',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 6,
  },
  commandModeRow: {
    position: 'absolute',
    zIndex: 7,
    right: 8,
    bottom: 240,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  commandModePill: {
    minHeight: 28,
    justifyContent: 'center',
    paddingHorizontal: 5,
    borderWidth: 1,
    borderColor: 'rgba(255, 176, 0, 0.3)',
    borderRadius: 14,
    backgroundColor: 'rgba(8,8,10,0.36)',
  },
  commandModePillActive: {
    borderColor: '#ffb000',
    backgroundColor: 'rgba(255,176,0,0.17)',
  },
  commandModeText: {
    color: '#ffb000',
    fontFamily: 'Menlo',
    fontSize: 8,
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.85)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
  opticsQuickToggle: {
    position: 'absolute',
    zIndex: 6,
    right: 9,
    bottom: 211,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: 'rgba(8,8,10,0.38)',
  },
  opticsQuickToggleText: {
    color: '#ffb000',
    fontFamily: 'Menlo',
    fontSize: 7,
    letterSpacing: 0.3,
  },
  glassNotice: {
    position: 'absolute',
    zIndex: 8,
    top: 124,
    left: 16,
    right: 16,
    alignItems: 'center',
    padding: 7,
    borderRadius: 8,
    backgroundColor: 'rgba(8,8,10,0.46)',
  },
  glassErrorText: {
    color: '#ff7770',
    fontFamily: 'Menlo',
    fontSize: 10,
    textAlign: 'center',
  },
  windPrompt: {
    position: 'absolute',
    zIndex: 6,
    left: 16,
    right: 16,
    bottom: 229,
    color: '#ffb000',
    fontFamily: 'Menlo',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.1,
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 7,
  },
  floatingArchiveThumb: {
    position: 'absolute',
    zIndex: 8,
    left: 16,
    bottom: 42,
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255, 208, 136, 0.8)',
    borderRadius: 8,
    backgroundColor: 'rgba(8,8,10,0.55)',
  },
  floatingLensTurret: {
    position: 'absolute',
    zIndex: 8,
    bottom: 142,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    padding: 5,
    borderWidth: 1,
    borderColor: 'rgba(255, 176, 0, 0.35)',
    borderRadius: 24,
    backgroundColor: 'rgba(8,8,10,0.42)',
  },
  floatingLensDetent: {
    minWidth: 48,
    minHeight: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
  },
  floatingLensDetentActive: {
    borderWidth: 1,
    borderColor: 'rgba(255, 176, 0, 0.75)',
    backgroundColor: 'rgba(255, 176, 0, 0.2)',
  },
  floatingLensText: {
    color: '#fff0d5',
    fontFamily: 'Menlo',
    fontSize: 10,
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 5,
  },
  floatingLensTextActive: {
    color: '#ffb000',
  },
  floatingShutterAssembly: {
    position: 'absolute',
    zIndex: 8,
    bottom: 38,
    alignSelf: 'center',
  },
  titaniumShutter: {
    width: 78,
    height: 78,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 39,
    borderWidth: 5,
    borderTopColor: '#ffffff',
    borderLeftColor: '#d9dce0',
    borderRightColor: '#747b84',
    borderBottomColor: '#555b63',
    backgroundColor: '#aeb4bc',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 9 },
    shadowOpacity: 0.68,
    shadowRadius: 13,
    elevation: 12,
  },
  titaniumShutterCore: {
    width: 51,
    height: 51,
    borderRadius: 26,
    borderWidth: 4,
    borderTopColor: '#ff8179',
    borderLeftColor: '#b9262c',
    borderRightColor: '#651116',
    borderBottomColor: '#3e0a0e',
    backgroundColor: '#a9151c',
  },
  titaniumShutterLocked: {
    opacity: 0.42,
  },
  messageContainer: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#08080a',
  },
  message: {
    color: '#f0e6d2',
    fontSize: 16,
    textAlign: 'center',
  },
  galleryImage: {
    width: '100%',
    height: '100%',
  },
  galleryPlaceholder: {
    color: '#ffb000',
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1,
  },
  error: {
    color: '#ff7770',
    padding: 8,
    textAlign: 'center',
    fontSize: 11,
  },
});