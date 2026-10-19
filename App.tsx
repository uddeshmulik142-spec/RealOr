import React, { useEffect, useRef, useState } from 'react';
import {
  Image,
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

export default function RealOrCamera() {
  const [lens, setLens] = useState<'0.5x' | '1x' | '2x' | '5x'>('1x');
  const [exposure, setExposure] = useState<number>(0);
  const exposureTouchStart = useRef<{ x: number; y: number } | null>(null);
  const exposureStartY = useRef<number | null>(null);
  const exposureStartValue = useRef(0);
  const device = useCameraDevice('back', {
    physicalDevices:
      lens === '0.5x'
        ? ['ultra-wide-angle']
        : lens === '5x'
          ? ['telephoto']
          : ['wide-angle'],
  });
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
  const statusTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const minExposure = device ? Math.max(-2, device.minExposureBias) : -2;
  const maxExposure = device ? Math.min(2, device.maxExposureBias) : 2;
  const boundedExposure = Math.min(
    maxExposure,
    Math.max(minExposure, exposure),
  );

  const saveProcessedPhoto = React.useCallback(async (base64Data: string) => {
    try {
      const savedPhotoUri = await saveEncodedPhotoToLibrary(base64Data);
      setLatestPhotoUri(savedPhotoUri);
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

    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(
      (error: unknown) => {
        console.warn('Unable to play shutter haptic feedback.', error);
      },
    );
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
    setExposure(Math.round(clampedExposure * 10) / 10);
  };

  const selectExposure = (value: number) => {
    if (!device) return;
    setExposure(Math.min(maxExposure, Math.max(minExposure, value)));
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
        <Text style={styles.message}>No {lens} camera found.</Text>
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
      <SkiaCamera
        key={lens}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive
        exposure={boundedExposure}
        getInitialZoom={() =>
          Math.min(
            device.maxZoom,
            Math.max(device.minZoom, lens === '2x' ? 2 : 1),
          )
        }
        constraints={[{ photoHDR: false }]}
        targetResolution={targetResolution}
        onFrame={renderFilmFrame}
        onError={(error) => setErrorMessage(error.message)}
      />
      <View
        style={styles.exposureIndicator}
        accessibilityLabel={`Exposure ${boundedExposure >= 0 ? '+' : ''}${boundedExposure.toFixed(1)} EV`}
      >
        <View style={styles.exposureHeader}>
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
        </View>
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
        <View style={styles.filmOptions}>
          {filmProfiles.map((profile) => (
            <TouchableOpacity
              key={profile.value}
              accessibilityRole="button"
              accessibilityState={{ selected: filmProfile === profile.value }}
              onPress={() => setFilmProfile(profile.value)}
              style={[
                styles.optionButton,
                filmProfile === profile.value && styles.optionButtonSelected,
              ]}
            >
              <Text
                style={[
                  styles.optionText,
                  filmProfile === profile.value && styles.optionTextSelected,
                ]}
              >
                {profile.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <View style={styles.effectOptions}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityState={{ checked: halationEnabled }}
            onPress={() => setHalationEnabled((enabled) => !enabled)}
            style={[styles.effectButton, halationEnabled && styles.effectButtonSelected]}
          >
            <Text style={styles.effectText}>
              Halation {halationEnabled ? 'On' : 'Off'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityState={{ checked: grainEnabled }}
            onPress={() => setGrainEnabled((enabled) => !enabled)}
            style={[styles.effectButton, grainEnabled && styles.effectButtonSelected]}
          >
            <Text style={styles.effectText}>Grain {grainEnabled ? 'On' : 'Off'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityState={{ checked: vignetteEnabled }}
            onPress={() => setVignetteEnabled((enabled) => !enabled)}
            style={[
              styles.effectButton,
              vignetteEnabled && styles.effectButtonSelected,
            ]}
          >
            <Text style={styles.effectText}>
              Vignette {vignetteEnabled ? 'On' : 'Off'}
            </Text>
          </TouchableOpacity>
        </View>
        <View style={styles.lensSelector}>
          {(['0.5x', '1x', '2x', '5x'] as const).map((lensOption) => (
            <TouchableOpacity
              key={lensOption}
              accessibilityRole="button"
              accessibilityLabel={`Select ${lensOption} lens`}
              accessibilityState={{ selected: lens === lensOption }}
              onPress={() => setLens(lensOption)}
              style={[
                styles.lensButton,
                lens === lensOption && styles.lensButtonSelected,
              ]}
            >
              <Text
                style={[
                  styles.lensText,
                  lens === lensOption && styles.lensTextSelected,
                ]}
              >
                {lensOption}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity
          accessibilityLabel="Take photo"
          accessibilityRole="button"
          disabled={isCapturing}
          onPress={() => void takePhoto()}
          style={[styles.shutterButton, isCapturing && styles.shutterDisabled]}
        />
      </View>
      <View
        style={styles.galleryThumbnail}
        accessibilityLabel={
          latestPhotoUri ? 'Most recent camera-roll photo' : 'Camera roll is empty'
        }
        accessibilityRole="image"
      >
        {latestPhotoUri ? (
          <Image
            source={{ uri: latestPhotoUri }}
            resizeMode="cover"
            style={styles.galleryImage}
          />
        ) : (
          <Text style={styles.galleryPlaceholder}>PHOTO</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  messageContainer: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  message: {
    color: '#fff',
    fontSize: 16,
    textAlign: 'center',
  },
  controls: {
    position: 'absolute',
    bottom: 28,
    width: '100%',
    alignItems: 'center',
    paddingHorizontal: 12,
  },
  galleryThumbnail: {
    position: 'absolute',
    left: 18,
    bottom: 48,
    width: 58,
    height: 58,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#fff',
    backgroundColor: '#222',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  galleryImage: {
    width: '100%',
    height: '100%',
  },
  galleryPlaceholder: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '700',
  },
  status: {
    color: '#fff',
    marginBottom: 12,
    fontSize: 14,
    fontWeight: '600',
  },
  filmOptions: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'center',
    marginBottom: 10,
  },
  optionButton: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#ffffff88',
    backgroundColor: '#00000088',
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginHorizontal: 3,
  },
  optionButtonSelected: {
    borderColor: '#fff',
    backgroundColor: '#fff',
  },
  optionText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  optionTextSelected: {
    color: '#111',
  },
  effectOptions: {
    flexDirection: 'row',
    marginBottom: 18,
  },
  effectButton: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#ffffff88',
    backgroundColor: '#00000088',
    paddingVertical: 7,
    paddingHorizontal: 14,
    marginHorizontal: 5,
  },
  effectButtonSelected: {
    borderColor: '#e53935',
  },
  effectText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  lensSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#ffffff55',
    backgroundColor: '#00000099',
    padding: 5,
    marginBottom: 16,
  },
  lensButton: {
    minWidth: 54,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
    paddingVertical: 9,
    paddingHorizontal: 12,
  },
  lensButtonSelected: {
    backgroundColor: '#fff',
  },
  lensText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  lensTextSelected: {
    color: '#111',
  },
  exposureIndicator: {
    position: 'absolute',
    right: 18,
    top: '42%',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 18,
    backgroundColor: '#00000088',
  },
  exposureHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  exposureValue: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  exposureReset: {
    marginTop: 7,
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderRadius: 10,
    backgroundColor: '#ffffff22',
  },
  exposureResetText: {
    color: '#ffffffcc',
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  exposureScale: {
    flexDirection: 'row',
    marginTop: 8,
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  exposureTickButton: {
    minWidth: 30,
    height: 32,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  exposureTickLabel: {
    color: '#ffffffaa',
    fontSize: 11,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    textAlign: 'center',
  },
  exposureTickLabelSelected: {
    color: '#fff',
    fontWeight: '800',
  },
  exposureTick: {
    width: 14,
    height: 1,
    backgroundColor: '#ffffff99',
  },
  exposureTickSelected: {
    width: 20,
    height: 2,
    backgroundColor: '#fff',
  },
  shutterButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 4,
    borderColor: '#fff',
    backgroundColor: '#e53935',
  },
  shutterDisabled: {
    opacity: 0.5,
  },
  error: {
    color: '#fff',
    backgroundColor: '#b00020',
    padding: 10,
    marginHorizontal: 20,
    marginBottom: 16,
    textAlign: 'center',
  },
});
