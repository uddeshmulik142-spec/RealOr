import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
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
  type SkImage,
  type SkSurface,
} from '@shopify/react-native-skia';
import { createSynchronizable, scheduleOnRN } from 'react-native-worklets';
import { saveEncodedPhotoToLibrary } from './src/utils/saveEncodedPhotoToLibrary';
import {
  createFilmRuntimeEffect,
  type FilmProfile,
} from './src/shaders/filmShader';

const filmProfiles: { label: string; value: FilmProfile }[] = [
  { label: 'KODAK 400', value: 0 },
  { label: 'FUJI CHROME', value: 1 },
  { label: 'LEICA M', value: 2 },
];

export default function RealOrCamera() {
  const device = useCameraDevice('back');
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
  const statusTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveProcessedPhoto = React.useCallback(async (base64Data: string) => {
    try {
      await saveEncodedPhotoToLibrary(base64Data);
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
          const imageShader = frameTexture.makeShaderOptions(
            TileMode.Clamp,
            TileMode.Clamp,
            FilterMode.Linear,
            MipmapMode.None,
          );
          const shader = filmEffect.makeShaderWithChildren(
            [
              width,
              height,
              filmProfile,
              grainEnabled ? 0.35 : 0,
              halationEnabled ? 0.65 : 0,
              17,
            ],
            [imageShader],
          );
          const paint = Skia.Paint();

          try {
            paint.setShader(shader);
            canvas.drawImage(frameTexture, 0, 0, paint);

            if (captureRequested.getBlocking()) {
              captureRequested.setBlocking(false);

              let surface: SkSurface | null = null;
              let snapshot: SkImage | undefined;
              try {
                surface = Skia.Surface.MakeOffscreen(width, height);
                if (!surface) {
                  throw new Error('Unable to create the high-resolution capture surface.');
                }

                surface.getCanvas().drawImage(frameTexture, 0, 0, paint);
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
              }
            }
          } finally {
            paint.dispose();
            shader.dispose();
            imageShader.dispose();
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

  const takePhoto = async () => {
    if (!device || !hasPermission || isCapturing) return;

    if (statusTimeout.current) clearTimeout(statusTimeout.current);
    setIsCapturing(true);
    setErrorMessage(null);
    setStatusMessage('Capturing high-resolution frame…');
    captureRequested.setBlocking(true);
  };

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
        <Text style={styles.message}>No camera found.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <SkiaCamera
        style={StyleSheet.absoluteFill}
        device={device}
        isActive
        constraints={[{ photoHDR: false }]}
        targetResolution={targetResolution}
        onFrame={renderFilmFrame}
        onError={(error) => setErrorMessage(error.message)}
      />
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
        </View>
        <TouchableOpacity
          accessibilityLabel="Take photo"
          accessibilityRole="button"
          disabled={isCapturing}
          onPress={() => void takePhoto()}
          style={[styles.shutterButton, isCapturing && styles.shutterDisabled]}
        />
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
    bottom: 40,
    width: '100%',
    alignItems: 'center',
    paddingHorizontal: 12,
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
