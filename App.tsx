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
  Pressable,
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

const filmProfiles: { label: string; value: FilmProfile }[] = [
  { label: 'KODAK 400', value: 0 },
  { label: 'FUJI CHROME', value: 1 },
  { label: 'LEICA M', value: 2 },
];
const exposureStops = [-2, -1, 0, 1, 2] as const;
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
  const shutterAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: shutterScale.value }],
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
  const [grainEnabled, setGrainEnabled] = useState(true);
  const [halationEnabled, setHalationEnabled] = useState(true);
  const [vignetteEnabled, setVignetteEnabled] = useState(true);
  const [latestPhotoUri, setLatestPhotoUri] = useState<string | null>(null);
  const [archiveVisible, setArchiveVisible] = useState(false);
  const [photosTaken, setPhotosTaken] = useState(0);
  const captureDetails = useRef({ filmProfile, exposure });
  const statusTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const minExposure = device ? Math.max(-2, device.minExposureBias) : -2;
  const maxExposure = device ? Math.min(2, device.maxExposureBias) : 2;
  const boundedExposure = Math.min(
    maxExposure,
    Math.max(minExposure, exposure),
  );
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

  const saveProcessedPhoto = React.useCallback(async (base64Data: string) => {
    try {
      const savedPhotoUri = await saveEncodedPhotoToLibrary(base64Data);
      setLatestPhotoUri(savedPhotoUri);
      setPhotosTaken((count) => count + 1);
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
  }, []);

  const failCapture = React.useCallback((message: string) => {
    setStatusMessage(null);
    setErrorMessage(message);
    setIsCapturing(false);
  }, []);

  const renderFilmFrame = React.useCallback<SkiaCameraProps['onFrame']>(
    (frame, render) => {
      'worklet';

      try {
        render(({ canvas, frameTexture }) => {
          const width = frameTexture.width();
          const height = frameTexture.height();
          const screenImageShader = frameTexture.makeShaderOptions(
            TileMode.Clamp,
            TileMode.Clamp,
            FilterMode.Linear,
            MipmapMode.None,
          );
          let screenShader: SkShader | undefined;
          let screenPaint: SkPaint | undefined;

          try {
            const screenUniforms = [
              width,
              height,
              filmProfile,
              grainEnabled ? 0.35 : 0,
              halationEnabled ? 0.65 : 0,
              vignetteEnabled ? 0.9 : 0,
              17,
            ];
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

            if (captureRequested.getBlocking()) {
              captureRequested.setBlocking(false);

              let surface: SkSurface | null = null;
              let snapshot: SkImage | undefined;
              let highResImageShader: SkShader | undefined;
              let highResShader: SkShader | undefined;
              let offscreenPaint: SkPaint | undefined;
              try {
                const isLandscape =
                  frame.orientation === 'left' || frame.orientation === 'right';
                const outputWidth = isLandscape ? height : width;
                const outputHeight = isLandscape ? width : height;
                const highResUniforms = [
                  width,
                  height,
                  filmProfile,
                  grainEnabled ? 0.35 : 0,
                  halationEnabled ? 0.65 : 0,
                  vignetteEnabled ? 0.9 : 0,
                  17,
                ];

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

                snapshot = surface.makeImageSnapshot();
                const base64Data = snapshot.encodeToBase64(ImageFormat.JPEG, 100);
                if (!base64Data) {
                  throw new Error('Unable to encode the processed camera frame.');
                }

                scheduleOnRN(saveProcessedPhoto, base64Data);
              } catch (error: unknown) {
                scheduleOnRN(
                  failCapture,
                  error instanceof Error ? error.message : 'Unable to capture photo.',
                );
              } finally {
                snapshot?.dispose();
                surface?.dispose();
                offscreenPaint?.dispose();
                highResShader?.dispose();
                highResImageShader?.dispose();
              }
            }
          } finally {
            screenPaint?.dispose();
            screenShader?.dispose();
            screenImageShader.dispose();
          }
        });
      } finally {
        frame.dispose();
      }
    },
    [
      captureRequested,
      failCapture,
      filmEffect,
      filmProfile,
      grainEnabled,
      halationEnabled,
      vignetteEnabled,
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

  const takePhoto = async () => {
    if (!device || !hasPermission || isCapturing) return;

    captureDetails.current = { filmProfile, exposure: boundedExposure };
    if (statusTimeout.current) clearTimeout(statusTimeout.current);
    setIsCapturing(true);
    setErrorMessage(null);
    setStatusMessage('Capturing high-resolution frame…');
    captureRequested.setBlocking(true);
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
  const selectLens = (lensOption: typeof lens) => {
    void Haptics.selectionAsync().catch((error: unknown) => {
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
          <Text style={styles.lcdReadout}>[ {24 - (photosTaken % 24)} EXP ]</Text>
          <View style={styles.lcdDivider} />
          <Text style={styles.lcdBadge}>
            {filmProfiles.find((profile) => profile.value === filmProfile)?.label ??
              'FILM'}
          </Text>
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
        </View>
      </View>

      <View style={styles.viewfinderContainer}>
        <View style={styles.viewfinder}>
          <SkiaCamera
            style={StyleSheet.absoluteFill}
            device={device}
            isActive={!archiveVisible}
            allowHapticsAndSystemSoundsPlayback
            zoom={animatedZoom}
            exposure={boundedExposure}
            constraints={[{ photoHDR: false }]}
            targetResolution={targetResolution}
            onFrame={renderFilmFrame}
            onError={(error) => setErrorMessage(error.message)}
          />
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
            <Text style={styles.viewfinderLabel}>AF · AE LOCK</Text>
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
          <View style={styles.filmOptions}>
            {filmProfiles.map((profile) => {
              const isSelected = filmProfile === profile.value;
              return (
                <Pressable
                  key={profile.value}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isSelected }}
                  onPress={() => selectFilmProfile(profile.value)}
                  style={({ pressed }) => [
                    styles.buttonInactive,
                    styles.filmButton,
                    isSelected && styles.buttonActive,
                    pressed && styles.controlButtonPressed,
                  ]}
                >
                  <Text
                    style={[
                      styles.textInactive,
                      isSelected && styles.textActive,
                      styles.filmText,
                    ]}
                  >
                    {profile.label}
                  </Text>
                  {isSelected ? <View style={styles.activeIndicator} /> : null}
                </Pressable>
              );
            })}
          </View>
        </View>
        <View style={styles.effectOptions}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ checked: halationEnabled }}
            onPress={() => toggleEffect(setHalationEnabled)}
            style={({ pressed }) => [
              styles.buttonInactive,
              styles.effectButtonLayout,
              halationEnabled && styles.buttonActive,
              pressed && styles.controlButtonPressed,
            ]}
          >
            <Text
              style={[
                styles.textInactive,
                halationEnabled && styles.textActive,
              ]}
            >
              Halation {halationEnabled ? 'On' : 'Off'}
            </Text>
            {halationEnabled ? <View style={styles.activeIndicator} /> : null}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ checked: grainEnabled }}
            onPress={() => toggleEffect(setGrainEnabled)}
            style={({ pressed }) => [
              styles.buttonInactive,
              styles.effectButtonLayout,
              grainEnabled && styles.buttonActive,
              pressed && styles.controlButtonPressed,
            ]}
          >
            <Text
              style={[
                styles.textInactive,
                grainEnabled && styles.textActive,
              ]}
            >
              Grain {grainEnabled ? 'On' : 'Off'}
            </Text>
            {grainEnabled ? <View style={styles.activeIndicator} /> : null}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ checked: vignetteEnabled }}
            onPress={() => toggleEffect(setVignetteEnabled)}
            style={({ pressed }) => [
              styles.buttonInactive,
              styles.effectButtonLayout,
              vignetteEnabled && styles.buttonActive,
              pressed && styles.controlButtonPressed,
            ]}
          >
            <Text
              style={[
                styles.textInactive,
                vignetteEnabled && styles.textActive,
              ]}
            >
              Vignette {vignetteEnabled ? 'On' : 'Off'}
            </Text>
            {vignetteEnabled ? <View style={styles.activeIndicator} /> : null}
          </Pressable>
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
      <View style={styles.shutterDeck}>
        <Text style={[styles.meterLabel, styles.etchedLabel]}>BULB</Text>
        <Pressable
          accessibilityLabel="Take photo"
          accessibilityRole="button"
          disabled={isCapturing}
          onPressIn={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(
              (error: unknown) => {
                console.warn('Unable to play shutter haptic feedback.', error);
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
          onPress={() => void takePhoto()}
          style={[styles.shutterOuter, isCapturing && styles.shutterDisabled]}
        >
          <Animated.View
            style={[styles.shutterInner, shutterAnimatedStyle]}
          />
        </Pressable>
        <Text style={[styles.meterLabel, styles.etchedLabel]}>AUTO</Text>
      </View>
      <Modal
        visible={archiveVisible}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setArchiveVisible(false)}
      >
        <Archive
          onClose={() => setArchiveVisible(false)}
          filmStock={
            filmProfiles.find((profile) => profile.value === filmProfile)?.label ??
            'LEICA M COLOR'
          }
          lens={lens}
          exposure={boundedExposure}
        />
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#121212',
    paddingTop: 8,
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
    minHeight: 76,
    paddingHorizontal: 20,
    paddingVertical: 10,
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
    width: 7,
    height: 7,
    marginBottom: 4,
    borderRadius: 4,
    backgroundColor: '#d32f2f',
  },
  brandText: {
    color: '#e5e5ea',
    fontSize: 17,
    fontWeight: '900',
    letterSpacing: 2,
  },
  brandEdition: {
    marginTop: 3,
    color: '#8e8e93',
    fontSize: 7,
    fontWeight: '700',
    letterSpacing: 1,
  },
  lcdPanel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: '#373737',
    borderRadius: 5,
    backgroundColor: '#10100d',
  },
  lcdReadout: {
    color: '#ff9500',
    fontSize: 10,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.5,
  },
  lcdDivider: {
    width: 1,
    height: 18,
    backgroundColor: '#54401f',
  },
  lcdBadge: {
    maxWidth: 90,
    color: '#ffbf58',
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  batteryBadge: {
    width: 19,
    height: 11,
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
    height: 5,
    backgroundColor: '#ff9500',
  },
  viewfinderContainer: {
    flex: 1,
    width: '100%',
    maxHeight: '58%',
    aspectRatio: 0.75,
    alignSelf: 'center',
    borderWidth: 4,
    borderTopColor: '#050505',
    borderLeftColor: '#050505',
    borderBottomColor: '#38383a',
    borderRightColor: '#38383a',
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: '#050505',
  },
  viewfinder: {
    flex: 1,
    overflow: 'hidden',
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
    height: 30,
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
    height: 30,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#090909bb',
  },
  viewfinderLabel: {
    color: '#e5e5ea',
    fontSize: 8,
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
    paddingHorizontal: 18,
    paddingTop: 8,
    paddingBottom: 4,
    backgroundColor: '#1c1c1e',
    borderTopWidth: 1,
    borderTopColor: '#38383a',
  },
  controlSection: {
    alignItems: 'center',
    marginBottom: 8,
  },
  sectionLabel: {
    marginBottom: 6,
    color: '#8e8e93',
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1.5,
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
  status: {
    color: '#ffbf58',
    marginBottom: 6,
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
  },
  filmOptions: {
    flexDirection: 'row',
    justifyContent: 'center',
    padding: 4,
    borderWidth: 1,
    borderColor: '#454547',
    borderRadius: 9,
    backgroundColor: '#111112',
  },
  buttonInactive: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 6,
    borderTopWidth: 1.5,
    borderBottomWidth: 4,
    borderTopColor: '#535357',
    borderBottomColor: '#080808',
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderLeftColor: '#414145',
    borderRightColor: '#080808',
    backgroundColor: '#29292b',
    paddingVertical: 9,
    paddingHorizontal: 10,
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
    borderBottomColor: '#77777b',
    borderLeftColor: '#b8b8ba',
    borderRightColor: '#77777b',
    backgroundColor: '#c7c7cc',
    marginHorizontal: 2,
  },
  filmText: {
    fontSize: 9,
    letterSpacing: 0.3,
  },
  textInactive: {
    color: '#c7c7cc',
    fontSize: 10,
    fontWeight: '700',
  },
  textActive: {
    color: '#ffbf58',
  },
  effectOptions: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginBottom: 8,
  },
  effectButtonLayout: {
    minHeight: 34,
    paddingVertical: 6,
    paddingHorizontal: 7,
    marginHorizontal: 3,
  },
  lensSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    padding: 4,
    borderWidth: 1,
    borderColor: '#454547',
    borderRadius: 20,
    backgroundColor: '#111112',
  },
  lensButtonLayout: {
    minWidth: 48,
    justifyContent: 'center',
    borderRadius: 16,
    borderTopColor: '#77777b',
    borderLeftColor: '#555557',
    paddingHorizontal: 8,
  },
  activeIndicator: {
    width: 5,
    height: 5,
    marginLeft: 5,
    borderRadius: 3,
    backgroundColor: '#ff9500',
    shadowColor: '#ff9500',
    shadowOpacity: 0.9,
    shadowRadius: 4,
    elevation: 3,
  },
  controlButtonPressed: {
    transform: [{ translateY: 2 }],
    borderBottomWidth: 2,
  },
  exposureIndicator: {
    position: 'absolute',
    right: 8,
    top: '34%',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 7,
    borderWidth: 1,
    borderColor: '#ffffff33',
    borderRadius: 8,
    backgroundColor: '#111111d9',
  },
  exposureValue: {
    color: '#ff9500',
    fontSize: 10,
    fontWeight: '800',
    fontFamily: 'Courier',
    fontVariant: ['tabular-nums'],
  },
  exposureReset: {
    marginTop: 4,
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderRadius: 4,
    backgroundColor: '#ffffff18',
  },
  exposureResetText: {
    color: '#c7c7cc',
    fontSize: 7,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  exposureScale: {
    marginTop: 5,
    alignItems: 'center',
  },
  exposureTickButton: {
    width: 44,
    height: 27,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 6,
  },
  exposureTickLabel: {
    minWidth: 15,
    color: '#c7c7cc',
    fontSize: 9,
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
    width: 10,
    height: 1,
    backgroundColor: '#c7c7cc',
  },
  exposureTickSelected: {
    width: 15,
    height: 2,
    backgroundColor: '#ff9500',
  },
  bottomDeck: {
    minHeight: 65,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    backgroundColor: '#151516',
    borderTopWidth: 1,
    borderTopColor: '#080808',
  },
  galleryThumbnail: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderRadius: 5,
    borderWidth: 2,
    borderTopColor: '#f1f1f3',
    borderLeftColor: '#b8b8ba',
    borderRightColor: '#777779',
    borderBottomColor: '#777779',
    backgroundColor: '#28282a',
  },
  lensCluster: {
    alignItems: 'center',
  },
  deckSpacer: {
    width: 48,
  },
  shutterDeck: {
    minHeight: 88,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    borderTopWidth: 1,
    borderTopColor: '#38383a',
    backgroundColor: '#1c1c1e',
  },
  meterLabel: {
    color: '#8e8e93',
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
  shutterOuter: {
    width: 74,
    height: 74,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 37,
    borderWidth: 3,
    borderTopColor: '#ffffff',
    borderBottomColor: '#8e8e93',
    borderLeftColor: '#c7c7cc',
    borderRightColor: '#8e8e93',
    backgroundColor: '#e5e5ea',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.55,
    shadowRadius: 8,
    elevation: 10,
  },
  shutterInner: {
    width: 50,
    height: 50,
    borderRadius: 25,
    borderWidth: 4,
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
    fontSize: 11,
  },
});
